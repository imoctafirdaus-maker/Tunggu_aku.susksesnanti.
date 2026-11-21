"use strict";
const fs = require("fs");
const path = require("path");
const HarmonicConfig = require("../strategies/harmonic/config");
const HarmonicEngine = require("../strategies/harmonic/engine");
const { checkNewsSafety } = require("./newsGuard");
const { evaluateDualAiConsensus } = require("./dualAiGatekeeper");
const { sendTelegramAlert } = require("./telegramNotifier");
const { loadBinanceConfig, getFuturesSnapshot, fapiRequest, getSymbolFilters, roundStep } = require("./autoTrader");

const SETTINGS_FILE = path.join(__dirname, ".harmonicSettings.json");
const PAPER_FILE = path.join(__dirname, ".harmonicPaperState.json");
const AI_CFG_PATH = path.join(__dirname, "aiConfig.json");
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

function savePaperState(st) {
  try {
    st.history = (st.history || []).slice(-50);
    const allLogs = Array.isArray(st.logs) ? st.logs : [];
    const execLogs = allLogs.filter(l => l && l.status !== "WATCH").slice(-40);
    const watchLogs = allLogs.filter(l => !l || l.status === "WATCH").slice(-50);
    st.logs = [...execLogs, ...watchLogs].sort((a, b) => (a.time || 0) - (b.time || 0));
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
Validasi keselarasan 4H-1H-15M, toleransi rasio ±0.035 Scott Carney, & kelayakan RR >= 1.2 untuk leverage 50x.
Balas HANYA JSON valid tanpa markdown: {"valid": true atau false, "confidence": 0-100, "reason": "maks 18 kata bahasa Indonesia"}`
      : `Kamu adalah Auditor Kuantitatif Scott Carney Harmonic Trading untuk sinyal MANDIRI timeframe ${tfUpper}.
Detail Kandidat Eksekusi (${tfUpper}):
- Pair: ${symbol} | Timeframe: ${tfUpper} | Arah: ${sig.side} | Pola: ${sig.patternName}
- Kualitas PRZ: ${sig.przScore}/100 | RR: 1:${Number(sig.rr || 0).toFixed(2)} | RSI: ${Number(sig.rsi || 50).toFixed(1)}
- Rasio Fibonacci: AB/XA=${sig.ratios.bRatio.toFixed(3)}, BC/AB=${sig.ratios.cRatio.toFixed(3)}, AD/XA=${sig.ratios.dXaRatio.toFixed(3)}
- Zona PRZ: ${sig.prz.low} - ${sig.prz.high} | Entry: ${sig.entry} | SL: ${sig.sl} | TP2: ${sig.tp2}
Validasi apakah rasio Fibonacci pola ${sig.patternName} di ${tfUpper} memenuhi toleransi ±0.035 Scott Carney dan RR >= 1.2 aman untuk leverage 50x.
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
RSI(14): ${sig.rsi.toFixed(1)} (Divergence: ${sig.rsiDivergence ? "YA" : "TIDAK"})
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
async function executeHarmonicOrder(symbol, sig, cfg, paper) {
  const credsCheck = loadBinanceConfig();
  const liveAutoReady = Boolean(credsCheck && credsCheck.autoTrade && credsCheck.apiKey && credsCheck.apiSecret);
  const isPaper = liveAutoReady ? Boolean(sig.forcePaperOnly) : true;

  // Guard 0: Dilarang keras eksekusi langsung di 4H (khusus struktur); 1H & 15M diizinkan
  if (sig.timeframe !== "15m" && sig.timeframe !== "1h") {
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
  if (snap.openPositions.some(p => p.symbol === symbol)) {
    return { executed: false, reason: `Sudah ada posisi Futures aktif di ${symbol}` };
  }
  paper.liveSymbols = Array.isArray(paper.liveSymbols)
    ? paper.liveSymbols.filter(s => snap.openPositions.some(p => p.symbol === s))
    : [];
  if (paper.liveSymbols.length >= (cfg.maxOpenPositions || 3)) {
    return { executed: false, reason: `Maksimal ${cfg.maxOpenPositions || 3} slot independen Harmonic tercapai` };
  }

  const filters = await getSymbolFilters(symbol, creds);
  if (!filters) return { executed: false, reason: `${symbol} tidak tersedia di Futures` };

  const slDist = Math.abs(sig.entry - sig.sl);
  const riskUsd = snap.totalMargin * ((cfg.riskPerTradePct || 1.0) / 100);
  let qty = roundStep(riskUsd / slDist, filters.stepSize);
  if (qty * sig.entry < filters.minNotional) {
    qty = roundStep((filters.minNotional * 1.05) / sig.entry, filters.stepSize);
  }
  if (qty < filters.minQty || qty <= 0) {
    return { executed: false, reason: `Qty (${qty}) di bawah batas minimum` };
  }

  const side = sig.side;
  const closeSide = side === "BUY" ? "SELL" : "BUY";
  const slPrice = roundStep(sig.sl, filters.tickSize);
  const tp1Price = roundStep(sig.tp1, filters.tickSize);
  const tp2Price = roundStep(sig.tp2, filters.tickSize);
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

  try {
    await fapiRequest("POST", "/fapi/v1/order", { symbol, side, type: "MARKET", quantity: qty }, creds, true);
  } catch (ordErr) {
    return { executed: false, reason: `Order MARKET ditolak Binance (${appliedLev}x): ${ordErr.message}` };
  }
  try {
    await fapiRequest("POST", "/fapi/v1/order", { symbol, side: closeSide, type: "STOP_MARKET", stopPrice: slPrice, closePosition: "true", workingType: "MARK_PRICE" }, creds, true);
  } catch (_) {}
  if (qtyTp1 >= filters.minQty) {
    try {
      await fapiRequest("POST", "/fapi/v1/order", { symbol, side: closeSide, type: "TAKE_PROFIT_MARKET", stopPrice: tp1Price, quantity: qtyTp1, reduceOnly: "true", workingType: "MARK_PRICE" }, creds, true);
    } catch (_) {}
  }
  try {
    await fapiRequest("POST", "/fapi/v1/order", { symbol, side: closeSide, type: "TAKE_PROFIT_MARKET", stopPrice: tp2Price, closePosition: "true", workingType: "MARK_PRICE" }, creds, true);
  } catch (_) {}

  await sendTelegramAlert(
    `🚀 <b>[HARMONIC LIVE ORDER]</b> ${symbol} (${sig.timeframe})\n` +
    `Pola: <b>${sig.patternName} ${side}</b> | Qty: ${qty}\n` +
    `SL: $${slPrice} | TP1: $${tp1Price} | TP2: $${tp2Price}\n` +
    `Audit: ${groqAudit.reason}`
  ).catch(() => {});

  paper.liveSymbols.push(symbol);
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
  return { executed: true, mode: "LIVE", reason: `Live Order Independen ${sig.patternName} terkirim (${groqAudit.reason})` };
}

/**
 * Runner Utama Pemindaian Harmonic Pattern (Hierarki wajib: 4h -> 1h -> 15m)
 */
async function runHarmonicScanCycle({ candidates, sharedCandles = {}, apiGetFn, db, admin, dryRun = false }) {
  if (db) __sharedAdminDb = db;
  const cfg = await loadHarmonicSettings();
  cfg.enabled = true; // Pastikan Harmonic selalu aktif memindai bersama EMA Expert
  const paper = loadPaperState();

  if (!dryRun) await managePaperPositions(paper, apiGetFn, cfg);

  const pool = (candidates || []).slice(0, 120);
  const detectedList = [];
  const upFirebase = {};
  let idx = 0;

  await Promise.all(Array.from({ length: 6 }, async () => {
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
        const logEntry = {
          time: Date.now(),
          symbol: sym,
          timeframe: sig.timeframe,
          pattern: sig.patternName,
          side: sig.side,
          przScore: sig.przScore,
          rr: sig.rr,
          status: execRes.executed ? "EXECUTED" : "SKIPPED",
          reason: execRes.reason
        };
        paper.logs.push(logEntry);
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
          rsi: Number(sig.rsi.toFixed(1)),
          status: logEntry.status,
          reason: execRes.reason,
          points: sig.points,
          updatedAt: admin ? admin.database.ServerValue.TIMESTAMP : Date.now()
        };
      } else if (res.logs && res.logs.length) {
        const interesting = res.logs.find(l => l.includes("[MTF ") || l.includes("PRZ Valid") || l.includes("ditolak: RR"));
        if (interesting) {
          paper.logs.push({
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
    } catch (_) {}
  }
  }));

  if (dryRun) return { scanned: pool.length, found: detectedList.length, top: detectedList[0] || null };

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
        found: detectedList.length,
        paperBalance: Number(paper.balance.toFixed(2)),
        openPaperCount: paper.openPositions.length,
        recentLogs: paper.logs.slice(-15),
        updatedAt: admin ? admin.database.ServerValue.TIMESTAMP : Date.now()
      });
    } catch (_) {}
  }

  return { scanned: pool.length, found: detectedList.length, top: detectedList[0] || null };
}

module.exports = { runHarmonicScanCycle, loadHarmonicSettings, loadPaperState, savePaperState, executeHarmonicOrder };
