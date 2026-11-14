"use strict";
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "aiConfig.json");
const QUOTA_STATE_PATH = path.join(__dirname, "aiQuotaState.json");
const RTDB_QUOTA_URL = "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app/emaSignals/_aiQuota.json";

function loadAiConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return {
        enabled: raw.enabled !== false,
        groqModel: raw.groqModel || "llama-3.3-70b-versatile",
        geminiModel: raw.geminiModel || "gemini-3.8-flash",
        minGroqScore: Number(raw.minGroqScore) || 65,
        minGeminiConfidence: Number(raw.minGeminiConfidence) || 75,
        groqKeys: [...new Set((raw.groqKeys || []).map(k => String(k).trim()).filter(Boolean))],
        geminiKeys: [...new Set((raw.geminiKeys || []).map(k => String(k).trim()).filter(Boolean))]
      };
    }
  } catch (_) {}
  return { enabled: false, groqKeys: [], geminiKeys: [] };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadQuotaState(cfg) {
  const today = todayKey();
  let state = { date: today, groq: [], gemini: [], updatedAt: Date.now() };
  try {
    if (fs.existsSync(QUOTA_STATE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(QUOTA_STATE_PATH, "utf8"));
      if (saved && saved.date === today) state = saved;
    }
  } catch (_) {}

  // Inisialisasi slot sesuai jumlah key di aiConfig.json (default 100% standby)
  state.groq = cfg.groqKeys.map((k, idx) => {
    const prev = (state.groq || [])[idx];
    return prev && prev.date === today ? prev : {
      name: `Groq #${idx + 1}`,
      mask: k.slice(0, 7) + "..." + k.slice(-4),
      pct: 100,
      status: "Standby (100%)",
      used: 0,
      limit: null,
      date: today
    };
  });

  state.gemini = cfg.geminiKeys.map((k, idx) => {
    const prev = (state.gemini || [])[idx];
    return prev && prev.date === today ? prev : {
      name: `Gemini #${idx + 1}`,
      mask: k.slice(0, 7) + "..." + k.slice(-4),
      pct: 100,
      status: "Standby (100%)",
      used: 0,
      limit: 250,
      date: today
    };
  });

  return state;
}

async function saveAndPushQuota(state) {
  state.updatedAt = Date.now();
  try { fs.writeFileSync(QUOTA_STATE_PATH, JSON.stringify(state, null, 2)); } catch (_) {}

  // Kirim via Firebase Admin SDK jika tersedia di folder scanner, fallback ke REST PUT
  try {
    const admin = require("firebase-admin");
    if (admin.apps && admin.apps.length) {
      await admin.database().ref("emaSignals/_aiQuota").set(state);
      return;
    }
  } catch (_) {}

  try {
    const saPath = path.join(__dirname, "serviceAccountKey.json");
    if (fs.existsSync(saPath)) {
      const admin = require("firebase-admin");
      const sa = JSON.parse(fs.readFileSync(saPath, "utf8"));
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(sa),
          databaseURL: "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app"
        });
      }
      await admin.database().ref("emaSignals/_aiQuota").set(state);
    }
  } catch (_) {}
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return null;
}

async function getActiveGroqModels(apiKey, preferredModel) {
  const fallbackList = [
    preferredModel,
    "llama-3.1-8b-instant",
    "qwen/qwen3-32b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "openai/gpt-oss-20b"
  ].filter(Boolean);
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    if (res.ok) {
      const data = await res.json();
      const ids = (data.data || [])
        .map(m => m.id)
        .filter(id => id && !/whisper|guard|tts|embed|vision/i.test(id));
      if (ids.length) {
        return [...fallbackList.filter(m => ids.includes(m)), ...ids.filter(m => !fallbackList.includes(m))].slice(0, 4);
      }
    }
  } catch (_) {}
  return [...new Set(fallbackList)];
}

async function callGroqWithRotation(prompt, cfg, qState) {
  if (!cfg.groqKeys.length) throw new Error("Daftar groqKeys kosong");
  let lastErr = "Semua Groq API Key gagal";

  for (let i = 0; i < cfg.groqKeys.length; i++) {
    const key = cfg.groqKeys[i];
    const models = await getActiveGroqModels(key, cfg.groqModel);

    for (const modelId of models) {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 15000);
      try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`
          },
          body: JSON.stringify({
            model: modelId,
            temperature: 0.15,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: "Anda adalah Analis Momentum & Struktur Pasar Kripto Futures. Jawab HANYA dalam JSON valid: {\"pass\": boolean, \"score\": number (0-100), \"analisis\": \"penjelasan singkat maks 18 kata bahasa Indonesia\"}."
              },
              { role: "user", content: prompt }
            ]
          }),
          signal: c.signal
        });

        // Baca header rate limit resmi Groq
        const remReq = Number(res.headers.get("x-ratelimit-remaining-requests"));
        const limReq = Number(res.headers.get("x-ratelimit-limit-requests"));
        if (Number.isFinite(remReq) && Number.isFinite(limReq) && limReq > 0) {
          const pct = Math.max(0, Math.min(100, Math.round((remReq / limReq) * 100)));
          qState.groq[i].pct = pct;
          qState.groq[i].used = limReq - remReq;
          qState.groq[i].limit = limReq;
          qState.groq[i].status = pct === 0 ? "Rate Limit (0%)" : `Aktif (${remReq}/${limReq} req)`;
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error?.message || `HTTP ${res.status}`;
          lastErr = `Groq Key #${i + 1} [${modelId}] (${res.status}): ${msg}`;
          if (res.status === 429) {
            qState.groq[i].pct = 0;
            qState.groq[i].status = "Rate Limit (0%)";
          }
          if (res.status === 404 || res.status === 400) continue;
          break;
        }

        const content = data?.choices?.[0]?.message?.content || "";
        const parsed = extractJson(content);
        if (!parsed || typeof parsed.pass !== "boolean") {
          lastErr = `Groq Key #${i + 1} format JSON tidak valid`;
          continue;
        }

        if (!Number.isFinite(remReq)) {
          qState.groq[i].used = (qState.groq[i].used || 0) + 1;
          qState.groq[i].pct = Math.max(1, 100 - Math.min(99, Math.round((qState.groq[i].used / 1000) * 100)));
          qState.groq[i].status = `Aktif (${qState.groq[i].used} scan)`;
        }

        return {
          ok: true,
          keyIndex: i + 1,
          modelUsed: modelId,
          pass: parsed.pass && Number(parsed.score || 0) >= cfg.minGroqScore,
          score: Number(parsed.score || 0),
          analisis: String(parsed.analisis || "Struktur sesuai").slice(0, 140)
        };
      } catch (e) {
        lastErr = `Groq Key #${i + 1} error: ${e.message}`;
      } finally {
        clearTimeout(t);
      }
    }
  }
  return { ok: false, error: lastErr };
}

async function getActiveGeminiModels(apiKey, preferredModel) {
  const fallbackList = [
    preferredModel,
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-3.0-flash",
    "gemini-flash-latest"
  ].filter(Boolean);

  const isStandardKey = apiKey.startsWith("AIza");
  const listUrl = isStandardKey
    ? `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    : "https://generativelanguage.googleapis.com/v1beta/models";
  const headers = isStandardKey ? {} : { "x-goog-api-key": apiKey };

  try {
    const res = await fetch(listUrl, { headers });
    if (res.ok) {
      const data = await res.json();
      const ids = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => String(m.name || "").replace(/^models\//, ""))
        .filter(id => id && /flash/i.test(id) && !/lite-preview|image|audio|tts/i.test(id));
      if (ids.length) {
        return [...fallbackList.filter(m => ids.includes(m)), ...ids.filter(m => !fallbackList.includes(m))].slice(0, 4);
      }
    }
  } catch (_) {}
  return [...new Set(fallbackList)];
}

async function callGeminiWithRotation(prompt, cfg, qState) {
  if (!cfg.geminiKeys.length) throw new Error("Daftar geminiKeys kosong");
  let lastErr = "Semua Gemini API Key gagal";

  for (let i = 0; i < cfg.geminiKeys.length; i++) {
    const key = cfg.geminiKeys[i];
    const isStandardAiStudioKey = key.startsWith("AIza");
    const models = await getActiveGeminiModels(key, cfg.geminiModel);

    for (const modelId of models) {
      const url = isStandardAiStudioKey
        ? `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

      const headers = { "Content-Type": "application/json" };
      if (!isStandardAiStudioKey) headers["x-goog-api-key"] = key;

      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 18000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            systemInstruction: {
              parts: [{
                text: "Anda adalah Auditor Risiko Senior Binance USDⓈ-M Futures Leverage 50x (Isolated). Tugas Anda mengaudit usulan sinyal & argumen analis pertama. Tolak (decision: TIDAK) jika jarak SL terlalu sempit (<0.25%) atau terlalu lebar (>1.6%), rasio kurang sehat, atau rawan likuidasi 50x. Jawab HANYA JSON valid: {\"decision\": \"YA\" atau \"TIDAK\", \"confidence\": number (0-100), \"alasan\": \"penjelasan singkat maks 18 kata bahasa Indonesia\"}."
              }]
            },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json"
            }
          }),
          signal: c.signal
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error?.message || `HTTP ${res.status}`;
          lastErr = `Gemini Key #${i + 1} [${modelId}] (${res.status}): ${msg}`;
          if (res.status === 429) {
            qState.gemini[i].pct = 0;
            qState.gemini[i].status = "Rate Limit (0%)";
          }
          if (res.status === 404 || res.status === 400) continue;
          break;
        }
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const parsed = extractJson(text);
        if (!parsed || !parsed.decision) {
          lastErr = `Gemini Key #${i + 1} format JSON tidak valid`;
          continue;
        }

        const dailyCap = qState.gemini[i].limit || 250;
        qState.gemini[i].used = (qState.gemini[i].used || 0) + 1;
        qState.gemini[i].pct = Math.max(1, Math.round(((dailyCap - qState.gemini[i].used) / dailyCap) * 100));
        qState.gemini[i].status = `Aktif (${qState.gemini[i].used}/${dailyCap} req)`;

        const verdict = String(parsed.decision).toUpperCase().trim();
        const conf = Number(parsed.confidence || 0);
        return {
          ok: true,
          keyIndex: i + 1,
          modelUsed: modelId,
          approved: verdict === "YA" && conf >= cfg.minGeminiConfidence,
          decision: verdict,
          confidence: conf,
          alasan: String(parsed.alasan || "Risiko terukur").slice(0, 140)
        };
      } catch (e) {
        lastErr = `Gemini Key #${i + 1} error: ${e.message}`;
      } finally {
        clearTimeout(t);
      }
    }
  }
  return { ok: false, error: lastErr };
}

async function evaluateDualAiConsensus(rec, tmResult = null) {
  const cfg = loadAiConfig();
  const qState = loadQuotaState(cfg);
  if (!cfg.enabled) return { approved: true, summary: "Dual-AI nonaktif" };

  const slPct = rec.entryPrice > 0 ? ((Math.abs(rec.entryPrice - rec.stopLoss) / rec.entryPrice) * 100).toFixed(2) : "0";
  const tpPct = rec.entryPrice > 0 ? ((Math.abs(rec.takeProfit - rec.entryPrice) / rec.entryPrice) * 100).toFixed(2) : "0";

  const marketBrief = [
    `Koin: ${rec.symbol} | Arah Sinyal: ${rec.signal}`,
    `Entry: $${rec.entryPrice} | Stop Loss: $${rec.stopLoss} (${slPct}%) | Take Profit: $${rec.takeProfit} (${tpPct}%) | Risk-Reward: 1:${(Number(tpPct) / Math.max(0.01, Number(slPct))).toFixed(1)}`,
    `Struktur Tren: EMA Expert MTF (1h > 15m > 5m) searah`,
    `Volume Relatif (RVOL): ${rec.rvol || "≥1.15"}x | Backtest Winrate: ${rec.winrate || "-"}%`,
    tmResult && tmResult.winProb ? `Simulasi Monte Carlo (2000 skenario): Probabilitas TP ${tmResult.winProb}%` : ""
  ].filter(Boolean).join("\n");

  const groq = await callGroqWithRotation(marketBrief, cfg, qState);
  if (!groq.ok) {
    await saveAndPushQuota(qState);
    return { approved: false, reason: `AI Tahap 1 Gagal (${groq.error})` };
  }
  if (!groq.pass) {
    await saveAndPushQuota(qState);
    return {
      approved: false,
      reason: `Ditolak Groq #${groq.keyIndex} (Skor ${groq.score}/100): ${groq.analisis}`
    };
  }

  const auditBrief = `${marketBrief}\n\nLaporan Analis Tahap 1 (Groq #${groq.keyIndex} - Skor ${groq.score}/100): "${groq.analisis}"\nBerikan vonis akhir YA atau TIDAK untuk eksekusi Leverage 50x Isolated.`;
  const gemini = await callGeminiWithRotation(auditBrief, cfg, qState);
  await saveAndPushQuota(qState);

  if (!gemini.ok) {
    return { approved: false, reason: `AI Tahap 2 Gagal (${gemini.error})` };
  }
  if (!gemini.approved) {
    return {
      approved: false,
      reason: `Ditolak Gemini #${gemini.keyIndex} (${gemini.decision} · Conf ${gemini.confidence}%): ${gemini.alasan}`
    };
  }

  return {
    approved: true,
    summary: `Groq#${groq.keyIndex}(${groq.score}) → Gemini#${gemini.keyIndex}: YA (${gemini.confidence}%) · ${gemini.alasan}`
  };
}

if (require.main === module && process.argv.includes("--test")) {
  (async () => {
    const sample = {
      symbol: "SOLUSDT",
      signal: "BUY",
      entryPrice: 145.5,
      stopLoss: 144.6,
      takeProfit: 147.75,
      rvol: 1.85,
      winrate: 64
    };
    const res = await evaluateDualAiConsensus(sample, { winProb: 44.2 });
    const cfg = loadAiConfig();
    const q = loadQuotaState(cfg);
    console.log("Hasil Konsensus:", res);
    console.log("\n📊 Monitor Kuota & Rate Limit API Key AI:");
    [...q.groq, ...q.gemini].forEach(item => {
      const barLen = 10;
      const filled = Math.round((item.pct / 100) * barLen);
      const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
      console.log(` - ${item.name.padEnd(10)} [${bar}] ${String(item.pct).padStart(3)}% · ${item.status}`);
    });
    process.exit(0);
  })();
}

module.exports = { loadAiConfig, loadQuotaState, evaluateDualAiConsensus };
