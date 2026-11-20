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
        minGeminiConfidence: Math.max(75, Number(raw.minGeminiConfidence || 75)) || 75,
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


const LOCAL_ROUTER_URL = "http://127.0.0.1:4000/v1/chat/completions";

async function queryLocalAiRouter(targetModel, systemPrompt, userPrompt, temperature = 0.15, timeoutMs = 16000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(LOCAL_ROUTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: targetModel,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      }),
      signal: c.signal
    });
    if (!res.ok) return null;
    const routedTo = res.headers.get("x-routed-to") || "";
    const cacheHit = res.headers.get("x-router-cache") || "";
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content || "";
    if (!content) return null;
    return { content, routedTo, cacheHit, model: data?.model || targetModel };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
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
        return [...fallbackList.filter(m => ids.includes(m)), ...ids.filter(m => !fallbackList.includes(m))].slice(0, 2);
      }
    }
  } catch (_) {}
  return [...new Set(fallbackList)];
}

async function callGroqWithRotation(prompt, cfg, qState) {
  const sysGroq = "Anda adalah Analis Momentum & Struktur Pasar Kripto Futures. Jawab HANYA dalam JSON valid: {\"pass\": boolean, \"score\": number (0-100), \"analisis\": \"penjelasan singkat maks 18 kata bahasa Indonesia\"}.";
  const viaRouter = await queryLocalAiRouter("analis-groq", sysGroq, prompt, 0.15, 15000);
  if (viaRouter) {
    const parsed = extractJson(viaRouter.content);
    if (parsed && typeof parsed.pass === "boolean") {
      const suffix = viaRouter.routedTo.split(":").pop() || "";
      let idx = cfg.groqKeys.findIndex(k => suffix && k.endsWith(suffix));
      if (idx < 0) idx = 0;
      if (qState.groq[idx]) {
        qState.groq[idx].used = (qState.groq[idx].used || 0) + (viaRouter.cacheHit === "HIT" ? 0 : 1);
        qState.groq[idx].pct = Math.max(1, 100 - Math.min(99, Math.round((qState.groq[idx].used / 1000) * 100)));
        qState.groq[idx].status = viaRouter.cacheHit === "HIT" ? "Cache Hemat Kuota" : `Router (${qState.groq[idx].used} req)`;
      }
      return {
        ok: true,
        keyIndex: idx + 1,
        modelUsed: viaRouter.model,
        pass: parsed.pass && Number(parsed.score || 0) >= cfg.minGroqScore,
        score: Number(parsed.score || 0),
        analisis: String(parsed.analisis || "Struktur sesuai").slice(0, 140)
      };
    }
  }
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
          qState.groq[i].status = pct === 0 ? "Standby (100%)" : `Aktif (${remReq}/${limReq} req)`;
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error?.message || `HTTP ${res.status}`;
          lastErr = `Groq Key #${i + 1} [${modelId}] (${res.status}): ${msg}`;
          if (res.status === 429) {
            qState.groq[i].pct = 0;
            qState.groq[i].status = "Standby (100%)";
          }
          if ([400, 404, 429, 500, 502, 503].includes(res.status)) continue;
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
        return [...fallbackList.filter(m => ids.includes(m)), ...ids.filter(m => !fallbackList.includes(m))].slice(0, 2);
      }
    }
  } catch (_) {}
  return [...new Set(fallbackList)];
}

async function callGeminiWithRotation(prompt, cfg, qState) {
  const isHarmonicPrompt = String(prompt).includes("HARMONIC_CARNEY");
  const sysGem = isHarmonicPrompt
    ? "Anda adalah Auditor Risiko Senior Scott Carney Harmonic Pattern Binance USDⓈ-M Futures. Evaluasi validitas rasio Fibonacci (B, C, D/XA), konfluensi PRZ, dan Risk-Reward (>= 1:1.2). Jangan menolak hanya karena jarak SL > 1.6% selama R:R sehat dan ukuran posisi menyesuaikan risiko. Beri confidence >= 75 jika valid. Jawab HANYA JSON valid: {\"decision\": \"YA\" atau \"TIDAK\", \"confidence\": number (0-100), \"alasan\": \"penjelasan singkat maks 18 kata bahasa Indonesia\"}."
    : "Anda adalah Auditor Risiko Senior Binance USDⓈ-M Futures Leverage 50x (Isolated). Tugas Anda mengaudit usulan sinyal & argumen analis pertama. Tolak (decision: TIDAK) jika jarak SL terlalu sempit (<0.25%) atau terlalu lebar (>1.6%), rasio kurang sehat, atau rawan likuidasi 50x. Jawab HANYA JSON valid: {\"decision\": \"YA\" atau \"TIDAK\", \"confidence\": number (0-100), \"alasan\": \"penjelasan singkat maks 18 kata bahasa Indonesia\"}.";
  const viaRouter = await queryLocalAiRouter("auditor-gemini", sysGem, prompt, 0.1, 18000);
  if (viaRouter) {
    const parsed = extractJson(viaRouter.content);
    if (parsed && parsed.decision) {
      const suffix = viaRouter.routedTo.split(":").pop() || "";
      let idx = cfg.geminiKeys.findIndex(k => suffix && k.endsWith(suffix));
      if (idx < 0) idx = 0;
      if (qState.gemini[idx]) {
        const dailyCap = qState.gemini[idx].limit || 250;
        qState.gemini[idx].used = (qState.gemini[idx].used || 0) + (viaRouter.cacheHit === "HIT" ? 0 : 1);
        qState.gemini[idx].pct = Math.max(1, Math.round(((dailyCap - qState.gemini[idx].used) / dailyCap) * 100));
        qState.gemini[idx].status = viaRouter.cacheHit === "HIT" ? "Cache Hemat Kuota" : `Router (${qState.gemini[idx].used}/${dailyCap})`;
      }
      const verdict = String(parsed.decision).toUpperCase().trim();
      const conf = Number(parsed.confidence || 0);
      return {
        ok: true,
        keyIndex: idx + 1,
        modelUsed: viaRouter.model,
        approved: verdict === "YA" && conf >= cfg.minGeminiConfidence,
        decision: verdict,
        confidence: conf,
        alasan: String(parsed.alasan || "Risiko terukur").slice(0, 140)
      };
    }
  }
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
            const dailyCap = qState.gemini[i].limit || 250;
            const remPct = Math.max(5, Math.round(((dailyCap - (qState.gemini[i].used || 0)) / dailyCap) * 100));
            qState.gemini[i].pct = remPct;
            qState.gemini[i].status = "Cooldown RPM (60d)";
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


const AUDIT_CACHE_PATH = path.join(__dirname, ".aiAuditCache.json");
function getCachedAudit(key) {
  try {
    if (!fs.existsSync(AUDIT_CACHE_PATH)) return null;
    const all = JSON.parse(fs.readFileSync(AUDIT_CACHE_PATH, "utf8"));
    const item = all[key];
    if (item && Date.now() - item.ts < 2700000) return item.res;
  } catch (_) {}
  return null;
}
function setCachedAudit(key, res) {
  try {
    let all = {};
    if (fs.existsSync(AUDIT_CACHE_PATH)) all = JSON.parse(fs.readFileSync(AUDIT_CACHE_PATH, "utf8"));
    const now = Date.now();
    for (const k of Object.keys(all)) {
      if (now - (all[k]?.ts || 0) > 2700000) delete all[k];
    }
    all[key] = { ts: now, res };
    fs.writeFileSync(AUDIT_CACHE_PATH, JSON.stringify(all, null, 2));
  } catch (_) {}
}

async function evaluateDualAiConsensus(rec, tmResult = null) {
  const stratTag = rec.strategy || "EMA_EXPERT";
  const cacheKey = `${stratTag}_${rec.symbol}_${rec.signal}_${rec.timeframe || "5m"}`;
  const cachedDecision = getCachedAudit(cacheKey);
  if (cachedDecision) return cachedDecision;
  const cfg = loadAiConfig();
  const qState = loadQuotaState(cfg);
  if (!cfg.enabled) return { approved: true, summary: "Dual-AI nonaktif" };

  const slPct = rec.entryPrice > 0 ? ((Math.abs(rec.entryPrice - rec.stopLoss) / rec.entryPrice) * 100).toFixed(2) : "0";
  const tpPct = rec.entryPrice > 0 ? ((Math.abs(rec.takeProfit - rec.entryPrice) / rec.entryPrice) * 100).toFixed(2) : "0";

  const isHarmonic = rec.strategy === "HARMONIC_CARNEY";
  const marketBrief = isHarmonic ? [
    `Strategi Independen: HARMONIC_CARNEY (${rec.patternName || "Harmonic"}) | Timeframe: ${rec.timeframe || "1h"}`,
    `Koin: ${rec.symbol} | Arah Sinyal: ${rec.signal}`,
    `Entry: ${rec.entryPrice} | Stop Loss: ${rec.stopLoss} (${slPct}%) | TP1: ${rec.tp1 || "-"} | TP2: ${rec.takeProfit} (${tpPct}%) | Risk-Reward: 1:${rec.riskReward || (Number(tpPct) / Math.max(0.01, Number(slPct))).toFixed(2)}`,
    `Zona PRZ: ${rec.przLow || "-"} - ${rec.przHigh || "-"} | Skor Konfluensi PRZ: ${rec.przScore || 80}/100`,
    rec.reason ? `Detail Struktur Fibonacci: ${rec.reason}` : "",
    tmResult && tmResult.winProb ? `Skor Struktur Scott Carney: ${tmResult.winProb}/100` : ""
  ].filter(Boolean).join("\n") : [
    `Strategi Independen: EMA_EXPERT MTF (1h > 15m > 5m) | Timeframe: ${rec.timeframe || "5m"}`,
    `Koin: ${rec.symbol} | Arah Sinyal: ${rec.signal}`,
    `Entry: ${rec.entryPrice} | Stop Loss: ${rec.stopLoss} (${slPct}%) | Take Profit: ${rec.takeProfit} (${tpPct}%) | Risk-Reward: 1:${(Number(tpPct) / Math.max(0.01, Number(slPct))).toFixed(1)}`,
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
    const is429 = String(gemini.error).includes("429") || String(gemini.error).includes("Quota exceeded");
    if (is429) {
      const FAILOVER_MIN = 75;
      if (groq.score >= FAILOVER_MIN) {
        return {
          approved: true,
          summary: `[GROQ-SOLO FAILOVER] Groq#${groq.keyIndex} (Skor ${groq.score}): YA · Gemini Limit (429) Bypassed`
        };
      }
      return {
        approved: false,
        reason: `Gemini Limit (429) & Groq Skor (${groq.score}) di bawah ambang failover (${FAILOVER_MIN})`
      };
    }
    return { approved: false, reason: `AI Tahap 2 Gagal (${gemini.error})` };
  }
  if (!gemini.approved) {
    const rejOut = {
      approved: false,
      reason: `Ditolak Gemini #${gemini.keyIndex} (${gemini.decision} · Conf ${gemini.confidence}%): ${gemini.alasan}`
    };
    setCachedAudit(cacheKey, rejOut);
    return rejOut;
  }

  const okOut = {
    approved: true,
    summary: `Groq#${groq.keyIndex}(${groq.score}) → Gemini#${gemini.keyIndex}: YA (${gemini.confidence}%) · ${gemini.alasan}`
  };
  setCachedAudit(cacheKey, okOut);
  return okOut;
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
    console.log("\n📊 Monitor Kuota & Standby API Key AI:");
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
