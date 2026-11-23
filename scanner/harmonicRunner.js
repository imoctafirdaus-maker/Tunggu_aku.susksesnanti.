"use strict";
const lastSkippedReasonBySig = new Map();
const fs = require("fs");
const path = require("path");
const HarmonicConfig = require("../strategies/harmonic/config");
const HarmonicEngine = require("../strategies/harmonic/engine");
const { checkNewsSafety } = require("./newsGuard");
const { evaluateDualAiConsensus } = require("./dualAiGatekeeper");
const { sendTelegramAlert } = require("./telegramNotifier");
const { loadBinanceConfig, getFuturesSnapshot, fapiRequest, getSymbolFilters, roundStep, placeConditionalOrder } = require("./autoTrader");

const SETTINGS_FILE = path.join(__dirname, ".harmonicSettings.json");
const PAPER_FILE = path.join(__dirname, ".harmonicPaperState.json");
const AI_CFG_PATH = path.join(__dirname, "aiConfig.json");
let cachedFuturesSymbols = null;
let cachedFuturesSymbolsAt = 0;

async function resolveFuturesSymbols(passedSet, candidates) {
  if (passedSet instanceof Set && passedSet.size > 0) return passedSet;
  if (candidates && candidates.futuresSymbols instanceof Set && candidates.futuresSymbols.size > 0) {
    return candidates.futuresSymbols;
  }
  if (cachedFuturesSymbols && (Date.now() - cachedFuturesSymbolsAt) < 15 * 60 * 1000) {
    return cachedFuturesSymbols;
  }
  try {
    const creds = loadBinanceConfig() || { isDemo: false };
    const ex = await fapiRequest("GET", "/fapi/v1/exchangeInfo", {}, creds, false);
    if (ex && Array.isArray(ex.symbols)) {
      cachedFuturesSymbols = new Set(
        ex.symbols
          .filter(s => s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT")
          .map(s => s.symbol)
      );
      cachedFuturesSymbolsAt = Date.now();
      return cachedFuturesSymbols;
    }
  } catch (_) {}
  return cachedFuturesSymbols;
}

const LIVE_RADAR_URL = "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app/emaSignals/_liveRadar.json";

async function loadHarmonicSettings() {
  try {
    const res = await fetch("https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app/harmonicConfig.json");
    if (res.ok) {
      const remote = await res.json();
      if (remote && typeof remote === "object") {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(remote, null, 2));
        return HarmonicConfig.mergeSettings(remote);
      }
    }
  } catch (_) {}
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return HarmonicConfig.mergeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")));
    }
  } catch (_) {}
  return HarmonicConfig.mergeSettings({});
}

function loadPaperState() {
  try {
    if (fs.existsSync(PAPER_FILE)) {
      return JSON.parse(fs.readFileSync(PAPER_FILE, "utf8"));
    }
  } catch (_) {}
  return {
    date: new Date().toISOString().slice(0, 10),
    balance: 1000,
    startOfDayBalance: 1000,
    openPositions: [],
    history: [],
    logs: []
  };
}

function pushUniquePaperLog(st, entry) {
  if (!Array.isArray(st.logs)) st.logs = [];
  if (entry.status === "EXECUTED") {
    st.logs.push(entry);
    return;
  }
  for (let i = st.logs.length - 1; i >= 0; i--) {
    const prev = st.logs[i];
    if (!prev) continue;
    if (
      prev.symbol === entry.symbol &&
      prev.timeframe === entry.timeframe &&
      prev.pattern === entry.pattern &&
      prev.side === entry.side
    ) {
      if (prev.status === entry.status && String(prev.reason || "") === String(entry.reason || "")) {
        prev.time = entry.time;
        return;
      }
      break;
    }
  }
  st.logs.push(entry);
}

function savePaperState(st) {
  try {
    st.history = (st.history || []).slice(-50);
    const allLogs = Array.isArray(st.logs) ? st.logs : [];
    const executedLogs = allLogs.filter(l => l && l.status === "EXECUTED").slice(-30);
    const skippedLogs = allLogs.filter(l => l && l.status === "SKIPPED").slice(-30);
    const watchLogs = allLogs.filter(l => !l || l.status === "WATCH").slice(-30);
    st.logs = [...executedLogs, ...skippedLogs, ...watchLogs].sort((a, b) => (a.time || 0) - (b.time || 0));
    fs.writeFileSync(PAPER_FILE, JSON.stringify(st, null, 2));
  } catch (_) {}
}

/**
 * Audit Khusus Groq AI (menghemat limit Gemini agar tetap fokus pada 3 EMA Expert)
 */
async function auditHarmonicDualAi(symbol, sig) {
  try {
    let aiCfg = {};
    try { if (fs.existsSync(AI_CFG_PATH)) aiCfg = JSON.parse(fs.readFileSync(AI_CFG_PATH, "utf8")); } catch (_) {}
    if (aiCfg.aiAuditEnabled === false) {
      return {
        approved: true,
        reason: `Audit AI OFF — lolos langsung filter Scott Carney (${String(sig.timeframe || "15m").toUpperCase()})`
      };
    }
    const groqKeys = (aiCfg.groqKeys || []).map(k => String(k).trim()).filter(Boolean);
    const geminiKeys = (aiCfg.geminiKeys || []).map(k => String(k).trim()).filter(Boolean);
    const cfAccountId = String(aiCfg.cfAccountId || "").trim();
    const cfApiToken = String(aiCfg.cfApiToken || "").trim();

    const tfUpper = String(sig.timeframe || "15m").toUpperCase();
    const isMtf = Boolean(sig.mtfConfirmed);
    const prompt = isMtf
      ? `Kamu adalah Auditor Kuantitatif Multi-Timeframe (MTF) Scott Carney Harmonic Trading.
Hierarki Top-Down 3 lapis terdeteksi:
1) TIMEFRAME 4H (Struktur Makro): ${sig.bias4hDetail || sig.bias4hPattern}
2) TIMEFRAME 1H (Validasi Searah): ${sig.confirm1hNote}
3) TIMEFRAME 15M (Eksekusi PRZ):
   - Pair: ${symbol} | Arah: ${sig.side} | Pola: ${sig.patternName} (PRZ Score: ${sig.przScore}/100, RR: 1:${Number(sig.rr || 0).toFixed(2)})
   - Rasio: AB/XA=${sig.ratios.bRatio.toFixed(3)}, BC/AB=${sig.ratios.cRatio.toFixed(3)}, AD/XA=${sig.ratios.dXaRatio.toFixed(3)}
   - PRZ: ${sig.prz.low} - ${sig.prz.high} | Entry: ${sig.entry} | SL: ${sig.sl} | TP2: ${sig.tp2}
Validasi keselarasan 4H-1H-15M, proyeksi Limit Order di PRZ titik D (±0.035 Scott Carney), & kelayakan RR >= 1.0.
Balas HANYA JSON valid tanpa markdown: {"valid": true atau false, "confidence": 0-100, "reason": "maks 18 kata bahasa Indonesia"}`
      : `Kamu adalah Auditor Kuantitatif Scott Carney Harmonic Trading untuk sinyal MANDIRI timeframe ${tfUpper}.
Detail Kandidat Eksekusi (${tfUpper}):
- Pair: ${symbol} | Timeframe: ${tfUpper} | Arah: ${sig.side} | Pola: ${sig.patternName}
- Kualitas PRZ: ${sig.przScore}/100 | RR: 1:${Number(sig.rr || 0).toFixed(2)}
- Rasio Fibonacci: AB/XA=${sig.ratios.bRatio.toFixed(3)}, BC/AB=${sig.ratios.cRatio.toFixed(3)}, AD/XA=${sig.ratios.dXaRatio.toFixed(3)}
- Zona PRZ: ${sig.prz.low} - ${sig.prz.high} | Entry: ${sig.entry} | SL: ${sig.sl} | TP2: ${sig.tp2}
Validasi apakah proyeksi Limit Order PRZ titik D pola ${sig.patternName} di ${tfUpper} memenuhi rasio Scott Carney dan RR >= 1.0.
Balas HANYA JSON valid tanpa markdown: {"valid": true atau false, "confidence": 0-100, "reason": "maks 18 kata bahasa Indonesia"}`;

    const votes = [];
    const errors = [];

    // 1. Audit Groq Llama-3.3-70B (Rotasi semua key)
    if (groqKeys.length) {
      const startIdx = Math.floor(Math.random() * groqKeys.length);
      for (let i = 0; i < groqKeys.length; i++) {
        const key = groqKeys[(startIdx + i) % groqKeys.length];
        try {
          const c = new AbortController(); const t = setTimeout(() => c.abort(), 10000);
          const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
            signal: c.signal,
            body: JSON.stringify({
              model: aiCfg.groqModel || "llama-3.3-70b-versatile",
              temperature: 0.1,
              messages: [{ role: "user", content: prompt }]
            })
          });
          clearTimeout(t);
          if (r.ok) {
            const d = await r.json();
            const m = (d?.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/);
            if (m) {
              const p = JSON.parse(m[0]);
              votes.push({
                who: "Groq-70B",
                valid: Boolean(p.valid) && (Number(p.confidence) || 75) >= 70,
                reason: p.reason || ""
              });
              break;
            }
          } else {
            errors.push(`Groq HTTP ${r.status}`);
          }
        } catch (e) {
          errors.push(`Groq err: ${e.message}`);
        }
      }
    }

    // 2. Audit Cloudflare Workers AI atau Rotasi Multi-Key Gemini
    if (cfAccountId && cfApiToken) {
      try {
        const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
        const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`;
        const r = await fetch(cfUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfApiToken },
          signal: c.signal,
          body: JSON.stringify({
            temperature: 0.1,
            messages: [{ role: "user", content: prompt }]
          })
        });
        clearTimeout(t);
        if (r.ok) {
          const d = await r.json();
          const m = (d?.result?.response || "").match(/\{[\s\S]*\}/);
          if (m) {
            const p = JSON.parse(m[0]);
            votes.push({
              who: "CF-Llama-70B",
              valid: Boolean(p.valid) && (Number(p.confidence) || 75) >= 70,
              reason: p.reason || ""
            });
          }
        } else {
          errors.push(`CF HTTP ${r.status}`);
        }
      } catch (e) {
        errors.push(`CF err: ${e.message}`);
      }
    } else if (geminiKeys.length) {
      const gStart = Math.floor(Math.random() * geminiKeys.length);
      for (let i = 0; i < geminiKeys.length; i++) {
        const gKey = geminiKeys[(gStart + i) % geminiKeys.length];
        try {
          const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
          const gModel = aiCfg.geminiModel || "gemini-2.0-flash";
          const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${gKey}`;
          const r = await fetch(gUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: c.signal,
            body: JSON.stringify({
              generationConfig: { temperature: 0.1 },
              contents: [{ parts: [{ text: prompt }] }]
            })
          });
          clearTimeout(t);
          if (r.ok) {
            const d = await r.json();
            const rawTxt = d?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            const m = rawTxt.match(/\{[\s\S]*\}/);
            if (m) {
              const p = JSON.parse(m[0]);
              votes.push({
                who: "Gemini",
                valid: Boolean(p.valid) && (Number(p.confidence) || 75) >= 70,
                reason: p.reason || ""
              });
              break;
            }
          } else {
            errors.push(`Gemini HTTP ${r.status}`);
          }
        } catch (e) {
          errors.push(`Gemini err: ${e.message}`);
        }
      }
    }

    if (votes.length > 0) {
      const okCount = votes.filter(v => v.valid).length;
      const approved = okCount === votes.length;
      const summary = votes.map(v => `${v.who}: "${v.reason}"`).join(" | ");
      return { approved, reason: summary };
    }

    return {
      approved: false,
      reason: `Ditolak: Wajib lolos audit AI namun API gagal merespons (${errors.slice(0, 2).join(", ") || "tidak ada respons AI"})`
    };
  } catch (e) {
    return { approved: false, reason: "Ditolak: Error audit AI (" + e.message + ")" };
  }
}

async function _unusedOldAudit(symbol, sig) {
  try {
    if (!fs.existsSync(AI_CFG_PATH)) {
      return { approved: true, reason: "Groq config tidak ditemukan, lolos via filter matematis PRZ" };
    }
    const aiCfg = JSON.parse(fs.readFileSync(AI_CFG_PATH, "utf8"));
    const keys = (aiCfg.groqKeys || []).map(k => String(k).trim()).filter(Boolean);
    if (!keys.length) {
      return { approved: true, reason: "Groq key kosong, lolos via filter matematis PRZ" };
    }

    const key = keys[Math.floor(Math.random() * keys.length)];
    const prompt = `Audit sinyal Scott Carney Harmonic Pattern ${symbol} (${sig.timeframe}):
Pola: ${sig.patternName} (${sig.side})
Rasio: B=${sig.ratios.bRatio.toFixed(3)}, C=${sig.ratios.cRatio.toFixed(3)}, D_XA=${sig.ratios.dXaRatio.toFixed(3)}
PRZ: ${sig.prz.low.toFixed(4)} - ${sig.prz.high.toFixed(4)} (Skor ${sig.przScore}/100, ${sig.prz.count} confluence)
Entry: ${sig.entry}, SL: ${sig.sl}, TP1: ${sig.tp1}, TP2: ${sig.tp2}, RR: 1:${sig.rr.toFixed(2)}.
Jawab HANYA JSON singkat: {"approve":true/false,"confidence":0-100,"reason":"alasan 1 kalimat"}`;

    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 10000);
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      signal: c.signal,
      body: JSON.stringify({
        model: aiCfg.groqModel || "llama-3.3-70b-versatile",
        temperature: 0.15,
        messages: [{ role: "user", content: prompt }]
      })
    });
    clearTimeout(t);

    if (!res.ok) {
      return { approved: true, reason: `Groq HTTP ${res.status} (fallback filter PRZ ${sig.przScore}/100)` };
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      const ok = Boolean(parsed.approve) && (Number(parsed.confidence) || 70) >= 60;
      return {
        approved: ok,
        reason: `Groq (${parsed.confidence || 75}%): ${parsed.reason || (ok ? "PRZ Valid" : "Ditolak")}`
      };
    }
    return { approved: true, reason: "Groq respons non-JSON, lolos via PRZ Score" };
  } catch (e) {
    return { approved: true, reason: `Groq timeout (${e.message}), lolos via PRZ Score` };
  }
}

let __sharedAdminDb = null;
async function updateActiveCandidateUi(payload, adminDb = __sharedAdminDb) {
  try {
    fs.writeFileSync(path.join(__dirname, ".liveUiState.json"), JSON.stringify(payload, null, 2));
    if (adminDb) { await adminDb.ref("emaSignals/_liveRadar").set(payload).catch(() => {}); }
    await fetch(LIVE_RADAR_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => {});
  } catch (_) {}
}

/**
 * Kelola posisi Paper Trading Harmonic (TP1 0.382 AD partial 50% + Breakeven, TP2 0.618 AD, SL)
 */
async function managePaperPositions(paper, apiGetFn, cfg) {
  if (!Array.isArray(paper.openPositions) || !paper.openPositions.length) return;
  const stillOpen = [];
  for (const pos of paper.openPositions) {
    try {
      const raw = await apiGetFn(`/api/v3/klines?symbol=${pos.symbol}&interval=${pos.timeframe}&limit=3`);
      const last = Array.isArray(raw) && raw.length ? raw[raw.length - 1] : null;
      if (!last) { stillOpen.push(pos); continue; }
      const hi = +last[2], lo = +last[3];
      const isBuy = pos.side === "BUY";

      const hitSl = isBuy ? lo <= pos.sl : hi >= pos.sl;
      if (hitSl) {
        const pct = isBuy ? (pos.sl - pos.entry) / pos.entry : (pos.entry - pos.sl) / pos.entry;
        const pnl = pos.remainingNotional * pct;
        paper.balance += pnl;
        paper.history.push({ ...pos, status: pos.tp1Hit ? "TP1+BE" : "SL", pnl: pos.realizedPnl + pnl, closedAt: Date.now() });
        await sendTelegramAlert(`📐 <b>[HARMONIC PAPER CLOSE]</b> ${pos.symbol} (${pos.patternName})\nStatus: <b>${pos.tp1Hit ? "TP1 + Breakeven" : "Stop Loss"}</b>\nPnL: <b>$${(pos.realizedPnl + pnl).toFixed(2)}</b>`).catch(() => {});
        continue;
      }

      if (!pos.tp1Hit) {
        const hitTp1 = isBuy ? hi >= pos.tp1 : lo <= pos.tp1;
        if (hitTp1) {
          const closeNotional = pos.remainingNotional * (cfg.tp1CloseRatio || 0.5);
          const pct = isBuy ? (pos.tp1 - pos.entry) / pos.entry : (pos.entry - pos.tp1) / pos.entry;
          const pnl1 = closeNotional * pct;
          paper.balance += pnl1;
          pos.realizedPnl += pnl1;
          pos.remainingNotional -= closeNotional;
          pos.tp1Hit = true;
          pos.sl = pos.entry; // Geser SL ke Breakeven
          await sendTelegramAlert(`🎯 <b>[HARMONIC TP1 HIT]</b> ${pos.symbol} (${pos.patternName})\nPartial Close 50% (+$${pnl1.toFixed(2)}) · SL digeser ke Breakeven ($${pos.entry})`).catch(() => {});
        }
      }

      const hitTp2 = isBuy ? hi >= pos.tp2 : lo <= pos.tp2;
      if (hitTp2) {
        const pct = isBuy ? (pos.tp2 - pos.entry) / pos.entry : (pos.entry - pos.tp2) / pos.entry;
        const pnl2 = pos.remainingNotional * pct;
        paper.balance += pnl2;
        paper.history.push({ ...pos, status: "TP2", pnl: pos.realizedPnl + pnl2, closedAt: Date.now() });
        await sendTelegramAlert(`🏆 <b>[HARMONIC TP2 FULL]</b> ${pos.symbol} (${pos.patternName})\nTotal PnL: <b>+$${(pos.realizedPnl + pnl2).toFixed(2)}</b>`).catch(() => {});
        continue;
      }

      stillOpen.push(pos);
    } catch (_) {
      stillOpen.push(pos);
    }
  }
  paper.openPositions = stillOpen;
}

/**
 * Eksekusi Order Harmonic (Live/Testnet atau Paper Trading)
 */
function getTfDurationMs(tf) {
  const map = { "5m": 5 * 60000, "15m": 15 * 60000, "1h": 60 * 60000, "4h": 240 * 60000 };
  return map[String(tf || "15m").toLowerCase()] || (15 * 60000);
}

/**
 * Pantau semua Limit Order Harmonic PRZ D:
 * - Jika FILLED -> langsung pasang SL & TP1/TP2 (fail-safe close jika SL gagal)
 * - Jika harga memantul ke TP1 duluan / tembus SL / kedaluwarsa -> batalkan LIMIT order (DELETE)
 */
async function managePendingHarmonicLimits(externalPaper = null) {
  const paper = externalPaper || loadPaperState();
  if (!Array.isArray(paper.pendingLimits) || paper.pendingLimits.length === 0) return { checked: 0, filled: 0, canceled: 0 };

  const creds = loadBinanceConfig();
  if (!creds || !creds.autoTrade) return { checked: 0, filled: 0, canceled: 0 };

  let changed = false;
  let filledCount = 0;
  let canceledCount = 0;
  const remaining = [];
  const eventLogs = [];
  const recordEvent = (entry) => {
    pushUniquePaperLog(paper, entry);
    eventLogs.push(entry);
  };

  for (const item of paper.pendingLimits) {
    try {
      const ord = await fapiRequest("GET", "/fapi/v1/order", { symbol: item.symbol, orderId: item.orderId }, creds, true);
      const status = String((ord && ord.status) || "");
      const execQty = Number((ord && ord.executedQty) || 0);

      // 1. Order Limit terjemput (FILLED / terisi)
      if (status === "FILLED" || (execQty > 0 && status !== "NEW")) {
        if (status === "PARTIALLY_FILLED") {
          try { await fapiRequest("DELETE", "/fapi/v1/order", { symbol: item.symbol, orderId: item.orderId }, creds, true); } catch (_) {}
        }
        const closeSide = item.side === "BUY" ? "SELL" : "BUY";
        const filledQty = execQty > 0 ? execQty : item.qty;
        let slAttached = false;
        try {
          await placeConditionalOrder({
            symbol: item.symbol,
            side: closeSide,
            type: "STOP_MARKET",
            triggerPrice: item.slPrice,
            closePosition: true,
            fallbackQty: filledQty,
            workingType: "MARK_PRICE"
          }, creds);
          slAttached = true;
        } catch (slErr) {
          console.error("[HARMONIC LIMIT SL ERROR] " + item.symbol + ":", slErr.message);
          let emergencyNote = "posisi ditutup darurat";
          try {
            await fapiRequest("POST", "/fapi/v1/order", { symbol: item.symbol, side: closeSide, type: "MARKET", quantity: filledQty, reduceOnly: true }, creds, true);
          } catch (closeErr) {
            emergencyNote = "GAGAL tutup darurat: " + closeErr.message;
          }
          recordEvent( {
            time: Date.now(),
            symbol: item.symbol,
            timeframe: item.timeframe,
            pattern: item.patternName,
            side: item.side,
            status: "SKIPPED",
            reason: `Limit PRZ terisi tapi SL gagal (${slErr.message}) — ${emergencyNote}`
          });
          changed = true;
          continue;
        }

        if (slAttached) {
          const qtyTp1 = roundStep(filledQty * 0.5, item.stepSize || 0.001);
          if (qtyTp1 >= (item.minQty || 0)) {
            try {
              await placeConditionalOrder({
                symbol: item.symbol,
                side: closeSide,
                type: "TAKE_PROFIT_MARKET",
                triggerPrice: item.tp1Price,
                quantity: qtyTp1,
                workingType: "MARK_PRICE"
              }, creds);
            } catch (_) {}
          }
          try {
            const remQty = roundStep(Math.max(item.minQty || 0, filledQty - qtyTp1), item.stepSize || 0.001);
            await placeConditionalOrder({
              symbol: item.symbol,
              side: closeSide,
              type: "TAKE_PROFIT_MARKET",
              triggerPrice: item.tp2Price,
              closePosition: true,
              fallbackQty: remQty,
              workingType: "MARK_PRICE"
            }, creds);
          } catch (_) {}

          paper.liveSymbols = Array.isArray(paper.liveSymbols) ? paper.liveSymbols : [];
          if (!paper.liveSymbols.includes(item.symbol)) paper.liveSymbols.push(item.symbol);
          filledCount++;
          changed = true;

          recordEvent( {
            time: Date.now(),
            symbol: item.symbol,
            timeframe: item.timeframe,
            pattern: item.patternName,
            side: item.side,
            przScore: item.przScore,
            rr: item.rr,
            status: "EXECUTED",
            reason: `Limit PRZ D terjemput @ ${item.limitPrice} (SL & TP1/TP2 aktif)`
          });

          await sendTelegramAlert(
            "✅ <b>[HARMONIC LIMIT FILLED]</b> " + item.symbol + " (" + item.timeframe + ")\n" +
            "Pola: <b>" + item.patternName + " " + item.side + "</b> @ $" + item.limitPrice + " | Qty: " + filledQty + "\n" +
            "SL: $" + item.slPrice + " | TP1: $" + item.tp1Price + " | TP2: $" + item.tp2Price
          ).catch(() => {});
        }
        continue;
      }

      // 2. Sudah dibatalkan / kedaluwarsa di sisi exchange
      if (["CANCELED", "EXPIRED", "REJECTED"].includes(status)) {
        changed = true;
        continue;
      }

      // 3. Masih NEW -> Cek apakah PRZ gagal / terlewat / kedaluwarsa
      let cancelReason = null;
      if (Date.now() > (item.expiresAt || 0)) {
        cancelReason = "Limit PRZ kedaluwarsa tidak terjemput";
      } else {
        try {
          const tick = await fapiRequest("GET", "/fapi/v1/ticker/price", { symbol: item.symbol }, creds, false);
          const livePx = Number(tick && tick.price);
          if (Number.isFinite(livePx) && livePx > 0) {
            const isBuy = item.side === "BUY";
            if (isBuy ? livePx >= item.tp1Price : livePx <= item.tp1Price) {
              cancelReason = `PRZ terlewat: harga (${livePx}) memantul ke TP1 (${item.tp1Price}) sebelum menjemput D`;
            } else if (isBuy ? livePx <= item.slPrice : livePx >= item.slPrice) {
              cancelReason = `PRZ batal: harga (${livePx}) menembus batas SL (${item.slPrice})`;
            }
          }
        } catch (_) {}
      }

      if (cancelReason) {
        try {
          await fapiRequest("DELETE", "/fapi/v1/order", { symbol: item.symbol, orderId: item.orderId }, creds, true);
        } catch (_) {}
        canceledCount++;
        changed = true;
        recordEvent( {
          time: Date.now(),
          symbol: item.symbol,
          timeframe: item.timeframe,
          pattern: item.patternName,
          side: item.side,
          przScore: item.przScore,
          rr: item.rr,
          status: "SKIPPED",
          reason: `Limit PRZ dibatalkan: ${cancelReason}`
        });
        await sendTelegramAlert(
          "🚫 <b>[HARMONIC LIMIT CANCELED]</b> " + item.symbol + " (" + item.timeframe + ")\n" +
          "Alasan: " + cancelReason
        ).catch(() => {});
        continue;
      }

      remaining.push(item);
    } catch (_) {
      remaining.push(item);
    }
  }

  if (changed) {
    if (!externalPaper) {
      const latest = loadPaperState();
      latest.pendingLimits = remaining;
      if (Array.isArray(paper.liveSymbols)) {
        latest.liveSymbols = [...new Set([...(latest.liveSymbols || []), ...paper.liveSymbols])];
      }
      for (const ev of eventLogs) {
        pushUniquePaperLog(latest, ev);
      }
      savePaperState(latest);
    } else {
      paper.pendingLimits = remaining;
    }
  }
  return { checked: remaining.length, filled: filledCount, canceled: canceledCount };
}

async function executeHarmonicOrder(symbol, sig, cfg, paper) {
  const credsCheck = loadBinanceConfig();
  const liveAutoReady = Boolean(credsCheck && credsCheck.autoTrade && credsCheck.apiKey && credsCheck.apiSecret);
  const isPaper = liveAutoReady ? Boolean(sig.forcePaperOnly) : true;

  // Guard 0: Dilarang keras eksekusi langsung di 4H (khusus struktur); 1H & 15M diizinkan
  if (!["1h", "15m", "5m"].includes(sig.timeframe)) {
    return { executed: false, reason: `Diblokir: Timeframe ${sig.timeframe} hanya pembaca struktur (eksekusi hanya 1H / 15M)` };
  }

  // Guard 1: Satu simbol hanya boleh memiliki satu posisi aktif
  if (paper.openPositions.some(p => p.symbol === symbol)) {
    return { executed: false, reason: `Sudah ada posisi aktif Harmonic pada ${symbol}` };
  }
  if (paper.openPositions.length >= (cfg.maxOpenPositions || 3)) {
    return { executed: false, reason: `Batas maksimal ${cfg.maxOpenPositions} posisi Harmonic tercapai` };
  }

  // Guard 2: Max Drawdown Harian
  const today = new Date().toISOString().slice(0, 10);
  if (paper.date !== today) {
    paper.date = today;
    paper.startOfDayBalance = paper.balance;
  }
  const dailyDdPct = paper.startOfDayBalance > 0
    ? ((paper.startOfDayBalance - paper.balance) / paper.startOfDayBalance) * 100
    : 0;
  if (dailyDdPct >= (cfg.maxDailyDrawdownPct || 5.0)) {
    return { executed: false, reason: `Max Drawdown Harian (${dailyDdPct.toFixed(2)}%) tercapai, entry ditahan` };
  }

  // Guard 3: News Guard
  const news = await checkNewsSafety({ symbol, signal: sig.side }, 30);
  if (!news.safe) {
    return { executed: false, reason: news.reason };
  }

  // Guard 4: Gunakan hasil Multi-AI Browser jika sudah terverifikasi, atau audit server
  const groqAudit = sig.preAuditedByBrowser ? { approved: true, reason: sig.browserAuditNote || "Multi-AI Browser VALID" } : await auditHarmonicDualAi(symbol, sig);
  await updateActiveCandidateUi({
    phase: groqAudit.approved ? "APPROVED" : "REJECTED",
    scanCoin: symbol,
    candidate: `${symbol} (${sig.patternName})`,
    signal: `${sig.side} [HARMONIC ${sig.timeframe}]`,
    groqStatus: groqAudit.approved ? "APPROVED" : "REJECTED",
    geminiStatus: groqAudit.approved ? "APPROVED" : "REJECTED",
    tradeResult: groqAudit.approved ? "EXECUTING" : "BLOCKED",
    tradeReason: groqAudit.reason,
    updatedAt: Date.now()
  });
  if (!groqAudit.approved) {
    return { executed: false, reason: groqAudit.reason };
  }

  // Mode Paper Trading
  if (isPaper) {
    const riskUsd = paper.balance * ((cfg.riskPerTradePct || 1.0) / 100);
    const slDistPct = Math.abs(sig.entry - sig.sl) / sig.entry;
    const notional = slDistPct > 0 ? Math.min(paper.balance * 20, riskUsd / slDistPct) : paper.balance;

    const pos = {
      symbol,
      patternName: sig.patternName,
      timeframe: sig.timeframe,
      side: sig.side,
      entry: sig.entry,
      sl: sig.sl,
      tp1: sig.tp1,
      tp2: sig.tp2,
      rr: sig.rr,
      remainingNotional: notional,
      realizedPnl: 0,
      tp1Hit: false,
      groqNote: groqAudit.reason,
      openedAt: Date.now()
    };
    paper.openPositions.push(pos);

    await sendTelegramAlert(
      `📐 <b>[HARMONIC PAPER ENTRY]</b> ${symbol} (${sig.timeframe})\n` +
      `Pola: <b>${sig.patternName} ${sig.side}</b> · PRZ Skor: ${sig.przScore}/100\n` +
      `Entry: $${sig.entry} | SL: $${sig.sl.toFixed(4)}\n` +
      `TP1 (0.382 AD): $${sig.tp1.toFixed(4)} | TP2 (0.618 AD): $${sig.tp2.toFixed(4)} (RR 1:${sig.rr.toFixed(2)})\n` +
      `Audit: ${groqAudit.reason}`
    ).catch(() => {});

    return { executed: true, mode: "PAPER", reason: `Paper Order ${sig.patternName} (${groqAudit.reason})` };
  }

  // Mode Live / Testnet Futures
  const creds = loadBinanceConfig();
  let snap = await getFuturesSnapshot();
  if (!snap || !snap.ok) {
    await new Promise(r => setTimeout(r, 800));
    snap = await getFuturesSnapshot();
  }
  if (!creds || !creds.autoTrade) {
    return { executed: false, reason: "Auto-Trade Live nonaktif di binanceConfig.json" };
  }
  if (!snap || !snap.ok) {
    return { executed: false, reason: `Koneksi Futures gagal: ${snap?.error || "no response"}` };
  }
  const minLimitPrzScore = Math.max(Number(cfg.minLimitPrzScore) || 75, Number(cfg.minPrzScore) || 60);
  if ((Number(sig.przScore) || 0) < minLimitPrzScore) {
    return { executed: false, reason: `Skor PRZ (${sig.przScore || 0}/100) di bawah batas Limit Order (${minLimitPrzScore}/100)` };
  }
  if (snap.openPositions.some(p => p.symbol === symbol)) {
    return { executed: false, reason: `Sudah ada posisi Futures aktif di ${symbol}` };
  }
  paper.pendingLimits = Array.isArray(paper.pendingLimits) ? paper.pendingLimits : [];
  if (paper.pendingLimits.some(o => o.symbol === symbol)) {
    return { executed: false, reason: `Sudah ada Limit Order PRZ D aktif di ${symbol}` };
  }
  paper.liveSymbols = Array.isArray(paper.liveSymbols)
    ? paper.liveSymbols.filter(s => snap.openPositions.some(p => p.symbol === s))
    : [];
  if ((paper.liveSymbols.length + paper.pendingLimits.length) >= (cfg.maxOpenPositions || 3)) {
    return { executed: false, reason: `Maksimal ${cfg.maxOpenPositions || 3} slot aktif/limit Harmonic tercapai` };
  }

  const filters = await getSymbolFilters(symbol, creds);
  if (!filters) return { executed: false, reason: `${symbol} tidak tersedia di Futures` };

  const side = sig.side;
  const isBuy = side === "BUY";
  const limitPrice = roundStep(sig.entry, filters.tickSize);
  const slPrice = roundStep(sig.sl, filters.tickSize);
  const tp1Price = roundStep(sig.tp1, filters.tickSize);
  const tp2Price = roundStep(sig.tp2, filters.tickSize);

  // Pastikan harga live masih berada di sisi pasif Limit D dan belum menyentuh TP1
  try {
    const tick = await fapiRequest("GET", "/fapi/v1/ticker/price", { symbol }, creds, false);
    const livePx = Number(tick && tick.price);
    if (Number.isFinite(livePx) && livePx > 0) {
      if (isBuy && livePx <= limitPrice) {
        return { executed: false, reason: `Harga live ($${livePx}) sudah menyentuh/menembus titik D ($${limitPrice})` };
      }
      if (!isBuy && livePx >= limitPrice) {
        return { executed: false, reason: `Harga live ($${livePx}) sudah menyentuh/menembus titik D ($${limitPrice})` };
      }
      if (isBuy ? livePx >= tp1Price : livePx <= tp1Price) {
        return { executed: false, reason: `PRZ terlewat: harga live ($${livePx}) sudah menyentuh TP1 ($${tp1Price})` };
      }
    }
  } catch (_) {}

  const slDist = Math.abs(limitPrice - slPrice);
  const lev = creds.leverage || 50;
  let qty;
  if (creds.manualMarginEnabled) {
    const manualUsd = Number(creds.manualMarginUsd) || 0;
    if (manualUsd <= 0) {
      return { executed: false, reason: "Margin Manual ON tetapi nominal disetel 0 USDT" };
    }
    qty = roundStep((manualUsd * lev) / limitPrice, filters.stepSize);
    if (qty * limitPrice < filters.minNotional) {
      return { executed: false, reason: `Margin Manual ${manualUsd} (Notional ${(qty * limitPrice).toFixed(2)}) di bawah minNotional ${filters.minNotional}` };
    }
  } else {
    const riskUsd = snap.totalMargin * ((cfg.riskPerTradePct || 1.0) / 100);
    qty = roundStep(riskUsd / slDist, filters.stepSize);
    if (qty * limitPrice < filters.minNotional) {
      qty = roundStep((filters.minNotional * 1.05) / limitPrice, filters.stepSize);
    }
  }
  if (qty < filters.minQty || qty <= 0) {
    return { executed: false, reason: `Qty (${qty}) di bawah batas minimum` };
  }

  const qtyTp1 = roundStep(qty * (cfg.tp1CloseRatio || 0.5), filters.stepSize);

  try { await fapiRequest("POST", "/fapi/v1/marginType", { symbol, marginType: "CROSSED" }, creds, true); } catch (_) {}
  const levCandidates = [...new Set([creds.leverage || 50, 25, 20, 10])];
  let appliedLev = levCandidates[0];
  for (const lv of levCandidates) {
    try {
      await fapiRequest("POST", "/fapi/v1/leverage", { symbol, leverage: lv }, creds, true);
      appliedLev = lv;
      break;
    } catch (_) {}
  }

  let placedOrder;
  try {
    placedOrder = await fapiRequest("POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "LIMIT",
      timeInForce: "GTC",
      quantity: qty,
      price: limitPrice
    }, creds, true);
  } catch (ordErr) {
    return { executed: false, reason: `Limit Order ditolak Binance (${appliedLev}x): ${ordErr.message}` };
  }

  const ttlMs = getTfDurationMs(sig.timeframe) * 8;
  paper.pendingLimits.push({
    orderId: placedOrder.orderId,
    symbol,
    timeframe: sig.timeframe,
    patternName: sig.patternName,
    side,
    limitPrice,
    slPrice,
    tp1Price,
    tp2Price,
    qty,
    qtyTp1,
    stepSize: filters.stepSize,
    minQty: filters.minQty,
    appliedLev,
    przScore: sig.przScore,
    rr: sig.rr,
    placedAt: Date.now(),
    expiresAt: Date.now() + ttlMs
  });

  await sendTelegramAlert(
    "🎯 <b>[HARMONIC LIMIT PRZ D]</b> " + symbol + " (" + sig.timeframe + ")\n" +
    "Pola: <b>" + sig.patternName + " " + side + "</b> (" + appliedLev + "x) | Qty: " + qty + "\n" +
    "Limit Entry (D): <b>$" + limitPrice + "</b>\n" +
    "SL: $" + slPrice + " | TP1: $" + tp1Price + " | TP2: $" + tp2Price + "\n" +
    "Audit: " + groqAudit.reason
  ).catch(() => {});
  try {
    const freshSnap = await getFuturesSnapshot();
    if (freshSnap && freshSnap.ok) {
      const fPayload = {
        totalMargin: freshSnap.totalMargin,
        available: freshSnap.available,
        availableBalance: freshSnap.available,
        unrealizedPnl: freshSnap.unrealizedPnl,
        leverage: freshSnap.leverage || 50,
        riskPct: freshSnap.riskPct || 1.0,
        openPositions: freshSnap.openPositions || [],
        updatedAt: Date.now()
      };
      if (__sharedAdminDb) {
        await Promise.all([
          __sharedAdminDb.ref("futuresPortfolio").set(fPayload),
          __sharedAdminDb.ref("scannerStatus/futures").set(fPayload),
          __sharedAdminDb.ref("emaSignals/_futuresPortfolio").set(fPayload)
        ]).catch(() => {});
      }
    }
  } catch (_) {}
  return { executed: true, mode: "LIVE_LIMIT", reason: `Limit Order PRZ D ${sig.patternName} dipasang @ ${limitPrice} (${groqAudit.reason})` };
}

/**
 * Runner Utama Pemindaian Harmonic Pattern (Hierarki wajib: 4h -> 1h -> 15m)
 */
async function runHarmonicScanCycle({ candidates, sharedCandles = {}, apiGetFn, db, admin, dryRun = false, futuresSymbols = null }) {
  if (db) __sharedAdminDb = db;
  const cfg = await loadHarmonicSettings();
  cfg.enabled = true; // Pastikan Harmonic selalu aktif memindai bersama EMA Expert
  const paper = loadPaperState();

  if (!dryRun) {
    await managePendingHarmonicLimits(paper);
    await managePaperPositions(paper, apiGetFn, cfg);
  }

  const activeFuturesSet = await resolveFuturesSymbols(futuresSymbols, candidates);
  const pool = (candidates || []).slice(0, 500);
  const detectedList = [];
  const upFirebase = {};
  let patternFoundCount = 0;
  let futuresEligibleCount = 0;
  let watchCount = 0;
  let skippedCount = 0;
  let executedCount = 0;
  let idx = 0;

  await Promise.all(Array.from({ length: 7 }, async () => {
    while (idx < pool.length) {
      const item = pool[idx++];
      const sym = typeof item === "string" ? item : item.symbol;
      if (!sym) continue;
      try {
        const candlesByTf = {};
        // Gunakan kembali candle 1h & 15m dari siklus utama jika sudah ada
        if (sharedCandles[sym]?.["1h"]) candlesByTf["1h"] = sharedCandles[sym]["1h"];
        if (sharedCandles[sym]?.["15m"]) candlesByTf["15m"] = sharedCandles[sym]["15m"];
        if (sharedCandles[sym]?.["5m"]) candlesByTf["5m"] = sharedCandles[sym]["5m"];

        const neededTfs = ["4h", "1h", "15m", "5m"].filter(tf => !candlesByTf[tf]);
        for (const tf of neededTfs) {
          const raw = await apiGetFn(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=160`);
          if (Array.isArray(raw) && raw.length >= 50) {
            candlesByTf[tf] = raw.slice(0, -1).map(k => ({
              time: Math.floor(k[0] / 1000),
              open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
              closed: true
            }));
          }
        }

        const res = HarmonicEngine.evaluateMultiTimeframe(candlesByTf, cfg);
      if (res.signal) {
        const sig = res.signal;
        patternFoundCount++;

        // Filter market lebih awal sebelum sinyal dijadikan kandidat final & masuk routing eksekusi
        if (activeFuturesSet && !activeFuturesSet.has(sym)) {
          skippedCount++;
          const skipReason = `${sym} tidak tersedia di Futures`;
          const sigKey = `${sym}_${sig.timeframe}_${sig.patternName}_${sig.side}`;
          lastSkippedReasonBySig.set(sigKey, skipReason);
          pushUniquePaperLog(paper, {
            time: Date.now(),
            symbol: sym,
            timeframe: sig.timeframe,
            pattern: sig.patternName,
            side: sig.side,
            przScore: sig.przScore,
            rr: sig.rr,
            status: "SKIPPED",
            reason: skipReason
          });
          upFirebase[`${sym}_${sig.timeframe}`] = {
            symbol: sym,
            timeframe: sig.timeframe,
            strategy: "HARMONIC_CARNEY",
            patternName: sig.patternName,
            signal: sig.side,
            entryPrice: sig.entry,
            stopLoss: sig.sl,
            tp1: sig.tp1,
            tp2: sig.tp2,
            rr: Number(sig.rr.toFixed(2)),
            przLow: sig.prz.low,
            przHigh: sig.prz.high,
            przScore: sig.przScore,
            status: "SKIPPED",
            reason: skipReason,
            points: sig.points,
            updatedAt: admin ? admin.database.ServerValue.TIMESTAMP : Date.now()
          };
          continue;
        }

        futuresEligibleCount++;
        detectedList.push({ symbol: sym, sig });

        await updateActiveCandidateUi({
          phase: "AUDITING",
          scanCoin: sym,
          candidate: `${sym} (${sig.patternName})`,
          signal: `${sig.side} [HARMONIC ${sig.timeframe}]`,
          groqStatus: "AUDITING",
          geminiStatus: "AUDITING",
          tradeResult: "PENDING",
          tradeReason: sig.reason,
          updatedAt: Date.now()
        });

        const execRes = dryRun
          ? { executed: false, reason: 'DRY-RUN' }
          : await executeHarmonicOrder(sym, sig, cfg, paper).catch(err => ({ executed: false, reason: `Error eksekusi: ${err.message}` }));
        const logStatus = execRes.executed ? "EXECUTED" : "SKIPPED";
        if (execRes.executed) executedCount++;
        else skippedCount++;
        const sigKey = `${sym}_${sig.timeframe}_${sig.patternName}_${sig.side}`;
        const reasonStr = String(execRes.reason || "");
        const shouldPushLog = execRes.executed
          ? (lastSkippedReasonBySig.delete(sigKey), true)
          : (lastSkippedReasonBySig.get(sigKey) !== reasonStr && (lastSkippedReasonBySig.set(sigKey, reasonStr), true));

        if (shouldPushLog) {
          pushUniquePaperLog(paper, {
            time: Date.now(),
            symbol: sym,
            timeframe: sig.timeframe,
            pattern: sig.patternName,
            side: sig.side,
            przScore: sig.przScore,
            rr: sig.rr,
            status: logStatus,
            reason: execRes.reason
          });
        }
        upFirebase[`${sym}_${sig.timeframe}`] = {
          symbol: sym,
          timeframe: sig.timeframe,
          strategy: "HARMONIC_CARNEY",
          patternName: sig.patternName,
          signal: sig.side,
          entryPrice: sig.entry,
          stopLoss: sig.sl,
          tp1: sig.tp1,
          tp2: sig.tp2,
          rr: Number(sig.rr.toFixed(2)),
          przLow: sig.prz.low,
          przHigh: sig.prz.high,
          przScore: sig.przScore,
          status: logStatus,
          reason: execRes.reason,
          points: sig.points,
          updatedAt: admin ? admin.database.ServerValue.TIMESTAMP : Date.now()
        };
      } else if (res.logs && res.logs.length) {
        if (!activeFuturesSet || activeFuturesSet.has(sym)) {
          const interesting = res.logs.find(l => l.includes("[MTF ") || l.includes("PRZ Valid") || l.includes("ditolak: RR"));
          if (interesting) {
            watchCount++;
            pushUniquePaperLog(paper, {
              time: Date.now(),
              symbol: sym,
              timeframe: "MTF",
              pattern: "SCAN",
              side: "-",
              status: "WATCH",
              reason: interesting
            });
          }
        }
      }
    } catch (_) {}
  }
  }));

  const cycleStats = {
    scanned: pool.length,
    found: futuresEligibleCount,
    patternFound: patternFoundCount,
    futuresEligible: futuresEligibleCount,
    watch: watchCount,
    skipped: skippedCount,
    executed: executedCount,
    top: detectedList[0] || null
  };
  if (dryRun) return cycleStats;

  savePaperState(paper);

  if (db) {
    try {
      if (Object.keys(upFirebase).length) {
        await db.ref("harmonicSignals").update(upFirebase);
      }
      await db.ref("harmonicStatus").set({
        enabled: cfg.enabled,
        paperTrading: cfg.paperTrading,
        scanned: pool.length,
        found: futuresEligibleCount,
        patternFound: patternFoundCount,
        futuresEligible: futuresEligibleCount,
        watch: watchCount,
        skipped: skippedCount,
        executed: executedCount,
        paperBalance: Number(paper.balance.toFixed(2)),
        openPaperCount: paper.openPositions.length,
        pendingLimitsCount: Array.isArray(paper.pendingLimits) ? paper.pendingLimits.length : 0,
        pendingLimits: Array.isArray(paper.pendingLimits) ? paper.pendingLimits.map(x => ({
          orderId: x.orderId,
          symbol: x.symbol,
          timeframe: x.timeframe,
          patternName: x.patternName,
          side: x.side,
          limitPrice: x.limitPrice,
          slPrice: x.slPrice,
          tp1Price: x.tp1Price,
          tp2Price: x.tp2Price,
          appliedLev: x.appliedLev,
          przScore: x.przScore,
          rr: x.rr,
          placedAt: x.placedAt,
          expiresAt: x.expiresAt
        })) : [],
        recentLogs: paper.logs.slice(-15),
        updatedAt: admin ? admin.database.ServerValue.TIMESTAMP : Date.now()
      });
    } catch (_) {}
  }

  return cycleStats;
}

module.exports = { runHarmonicScanCycle, loadHarmonicSettings, loadPaperState, savePaperState, executeHarmonicOrder, managePendingHarmonicLimits };
