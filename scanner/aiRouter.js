"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 4000;
const CFG_PATH = path.join(__dirname, "aiConfig.json");
const cooldownMap = new Map();
const responseCache = new Map();
let rrCounter = 0;

function loadRoutes() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
  const geminiModels = [...new Set([cfg.geminiModel, "gemini-2.5-flash", "gemini-flash-latest"].filter(Boolean))];
  const geminiRoutes = [];
  for (const model of geminiModels) {
    for (const key of (cfg.geminiKeys || [])) {
      if (key && key.trim()) geminiRoutes.push({ provider: "gemini", model, key: key.trim() });
    }
  }
  const groqRoutes = (cfg.groqKeys || [])
    .filter(k => k && k.trim())
    .flatMap(k => [...new Set([cfg.groqModel, "openai/gpt-oss-120b", "llama-3.1-8b-instant", "meta-llama/llama-4-scout-17b-16e-instruct"].filter(Boolean))].map(m => ({ provider: "groq", model: m, key: k.trim() })));

  const sambaModels = Array.isArray(cfg.sambanovaModels) && cfg.sambanovaModels.length
    ? cfg.sambanovaModels
    : ["Meta-Llama-3.3-70B-Instruct", "Qwen3-32B"];
  const sambaRoutes = (cfg.sambanovaKeys || [])
    .filter(k => k && k.trim())
    .flatMap(k => sambaModels.map(m => ({ provider: "sambanova", model: m, key: k.trim() })));

  return { geminiRoutes, groqRoutes, sambaRoutes };
}

async function forwardToGemini(route, messages, temperature = 0.2) {
  const promptText = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const isStandardKey = route.key.startsWith("AIza");
  const url = isStandardKey
    ? `https://generativelanguage.googleapis.com/v1beta/models/${route.model}:generateContent?key=${encodeURIComponent(route.key)}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${route.model}:generateContent`;

  const headers = { "Content-Type": "application/json" };
  if (!isStandardKey) headers["x-goog-api-key"] = route.key;

  const res = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      generationConfig: { temperature }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return {
    id: "chatcmpl-router-" + Date.now(),
    object: "chat.completion",
    model: route.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }]
  };
}

async function forwardToOpenAICompat(endpoint, route, messages, temperature = 0.2) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${route.key}`
    },
    signal: AbortSignal.timeout(9000),
    body: JSON.stringify({ model: route.model, messages, temperature })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    const { geminiRoutes, groqRoutes, sambaRoutes } = loadRoutes();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "auditor-gemini", active_routes: geminiRoutes.length, fallback_sambanova: sambaRoutes.length },
        { id: "analis-groq", active_routes: groqRoutes.length, fallback_sambanova: sambaRoutes.length },
        { id: "auditor-sambanova", active_routes: sambaRoutes.length }
      ]
    }));
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const target = payload.model || "auditor-gemini";
        const messages = payload.messages || [];
        const cacheKey = target + ":" + JSON.stringify(messages);
        const cached = responseCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < 1800000) {
          res.writeHead(200, { "Content-Type": "application/json", "X-Router-Cache": "HIT" });
          return res.end(JSON.stringify(cached.data));
        }

        const { geminiRoutes, groqRoutes, sambaRoutes } = loadRoutes();
        const primaryPool = target.includes("samba") ? sambaRoutes : (target.includes("groq") ? groqRoutes : geminiRoutes);
        const now = Date.now();
        const start = (rrCounter++) % Math.max(1, primaryPool.length);

        const orderedPrimary = [];
        for (let step = 0; step < primaryPool.length; step++) {
          orderedPrimary.push(primaryPool[(start + step) % primaryPool.length]);
        }
        // Gabungkan rute utama di depan, diikuti SambaNova sebagai fallback otomatis
        const fullQueue = orderedPrimary;

        let lastErr = null;
        for (const route of fullQueue) {
          const routeId = `${route.provider}:${route.model}:${route.key.slice(-6)}`;
          if ((cooldownMap.get(routeId) || 0) > now) continue;

          try {
            let result;
            if (route.provider === "gemini") {
              result = await forwardToGemini(route, messages, payload.temperature ?? 0.2);
            } else if (route.provider === "sambanova") {
              result = await forwardToOpenAICompat("https://api.sambanova.ai/v1/chat/completions", route, messages, payload.temperature ?? 0.2);
            } else {
              result = await forwardToOpenAICompat("https://api.groq.com/openai/v1/chat/completions", route, messages, payload.temperature ?? 0.2);
            }

            responseCache.set(cacheKey, { ts: now, data: result });
            if (responseCache.size > 200) responseCache.delete(responseCache.keys().next().value);

            res.writeHead(200, { "Content-Type": "application/json", "X-Routed-To": routeId });
            return res.end(JSON.stringify(result));
          } catch (e) {
            lastErr = e;
            const isTimeout = e.name === "TimeoutError" || String(e.message).toLowerCase().includes("timeout");
            if (isTimeout || e.status === 429 || e.status === 503 || e.status === 400 || e.status === 403 || e.status === 404) {
              cooldownMap.set(routeId, now + (isTimeout ? 30000 : 60000));
            }
          }
        }
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: lastErr ? lastErr.message : "Semua jalur AI sedang cooldown" } }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

const { processManualCloseQueue } = require("./manualCloseExecutor");
setInterval(() => { processManualCloseQueue().catch(() => {}); }, 2500);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`🚀 Local AI Router (Gemini + Groq + SambaNova Fallback) aktif di http://127.0.0.1:${PORT}`);
});
