"use strict";
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "aiConfig.json");

function loadAiConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return {
        enabled: raw.enabled !== false,
        groqModel: raw.groqModel || "llama-3.3-70b-versatile",
        geminiModel: raw.geminiModel || "gemini-2.5-flash",
        minGroqScore: Number(raw.minGroqScore) || 65,
        minGeminiConfidence: Number(raw.minGeminiConfidence) || 70,
        groqKeys: [...new Set((raw.groqKeys || []).map(k => String(k).trim()).filter(Boolean))],
        geminiKeys: [...new Set((raw.geminiKeys || []).map(k => String(k).trim()).filter(Boolean))]
      };
    }
  } catch (_) {}
  return { enabled: false, groqKeys: [], geminiKeys: [] };
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
        const prioritized = [
          ...fallbackList.filter(m => ids.includes(m)),
          ...ids.filter(m => !fallbackList.includes(m))
        ];
        return prioritized.slice(0, 4);
      }
    }
  } catch (_) {}
  return [...new Set(fallbackList)];
}

// Tahap 1: Rotasi Groq API (Key 1 -> Key 2 -> Key 3 -> dst + Auto-Model Discovery)
async function callGroqWithRotation(prompt, cfg) {
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
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error?.message || `HTTP ${res.status}`;
          lastErr = `Groq Key #${i + 1} [${modelId}] (${res.status}): ${msg}`;
          // Jika model tidak ditemukan (404), coba model berikutnya pada key yang sama; jika rate limit (429/401), pindah key
          if (res.status === 404 || res.status === 400) continue;
          break;
        }
        const content = data?.choices?.[0]?.message?.content || "";
        const parsed = extractJson(content);
        if (!parsed || typeof parsed.pass !== "boolean") {
          lastErr = `Groq Key #${i + 1} format JSON tidak valid`;
          continue;
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
        const prioritized = [
          ...fallbackList.filter(m => ids.includes(m)),
          ...ids.filter(m => !fallbackList.includes(m))
        ];
        return prioritized.slice(0, 4);
      }
    }
  } catch (_) {}
  return [...new Set(fallbackList)];
}

// Tahap 2: Rotasi Gemini Flash API (Key 1 -> Key 2 -> Key 3 -> dst + Auto-Model Discovery)
async function callGeminiWithRotation(prompt, cfg) {
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
      if (!isStandardAiStudioKey) {
        headers["x-goog-api-key"] = key;
      }

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
          if (res.status === 404 || res.status === 400) continue;
          break;
        }
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const parsed = extractJson(text);
        if (!parsed || !parsed.decision) {
          lastErr = `Gemini Key #${i + 1} format JSON tidak valid`;
          continue;
        }
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
  if (!cfg.enabled) return { approved: true, summary: "Dual-AI nonaktif" };

  const slPct = rec.entryPrice > 0 ? ((Math.abs(rec.entryPrice - rec.stopLoss) / rec.entryPrice) * 100).toFixed(2) : "0";
  const tpPct = rec.entryPrice > 0 ? ((Math.abs(rec.takeProfit - rec.entryPrice) / rec.entryPrice) * 100).toFixed(2) : "0";

  const marketBrief = [
    `Koin: ${rec.symbol} | Arah Sinyal: ${rec.signal}`,
    `Entry: $${rec.entryPrice} | Stop Loss: $${rec.stopLoss} (${slPct}%) | Take Profit: $${rec.takeProfit} (${tpPct}%)`,
    `Struktur Tren: EMA Expert MTF (1h > 15m > 5m) searah`,
    `Volume Relatif (RVOL): ${rec.rvol || "≥1.15"}x | Backtest Winrate: ${rec.winrate || "-"}%`,
    tmResult && tmResult.winProb ? `Simulasi Monte Carlo (2000 skenario): Probabilitas TP ${tmResult.winProb}%` : ""
  ].filter(Boolean).join("\n");

  // 1. Konsultasi Tahap 1: Groq
  const groq = await callGroqWithRotation(marketBrief, cfg);
  if (!groq.ok) {
    return { approved: false, reason: `AI Tahap 1 Gagal (${groq.error})` };
  }
  if (!groq.pass) {
    return {
      approved: false,
      reason: `Ditolak Groq #${groq.keyIndex} (Skor ${groq.score}/100): ${groq.analisis}`
    };
  }

  // 2. Konsultasi Tahap 2: Gemini Flash (Hakim Akhir)
  const auditBrief = `${marketBrief}\n\nLaporan Analis Tahap 1 (Groq #${groq.keyIndex} - Skor ${groq.score}/100): "${groq.analisis}"\nBerikan vonis akhir YA atau TIDAK untuk eksekusi Leverage 50x Isolated.`;
  const gemini = await callGeminiWithRotation(auditBrief, cfg);
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
      takeProfit: 146.4,
      rvol: 1.48,
      winrate: 64
    };
    console.log("🤖 Menguji Rantai Konsensus Dual-AI (Termux -> Groq -> Gemini Flash)...");
    const res = await evaluateDualAiConsensus(sample, { winProb: 56.4 });
    console.log("Hasil Konsensus:", res);
  })();
}

module.exports = { loadAiConfig, evaluateDualAiConsensus };
