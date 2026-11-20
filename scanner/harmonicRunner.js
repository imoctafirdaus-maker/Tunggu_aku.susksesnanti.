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
    st.logs = (st.logs || []).slice(-80);
    fs.writeFileSync(PAPER_FILE, JSON.stringify(st, null, 2));
  } catch (_) {}
}

/**
 * Audit Khusus Groq AI (menghemat limit Gemini agar tetap fokus pada 3 EMA Expert)
 */
async function auditHarmonicDualAi(symbol, sig) {
  try {
    const signalPayload = {
      symbol,
      timeframe: sig.timeframe,
      strategy: "HARMONIC_CARNEY",
      patternName: sig.patternName,
      signal: sig.side,
      entryPrice: sig.entry,
      stopLoss: sig.sl,
      takeProfit: sig.tp2,
      tp1: sig.tp1,
      riskReward: Number(sig.rr.toFixed(2)),
      przLow: sig.prz.low,
      przHigh: sig.prz.high,
      przScore: sig.przScore,
      ratios: sig.ratios,
      rvol: 1.5,
      winrate: Math.max(60, sig.przScore),
      reason: `Scott Carney ${sig.patternName} (${sig.side}) · Rasio B=${sig.ratios.bRatio.toFixed(3)}, C=${sig.ratios.cRatio.toFixed(3)}, D/XA=${sig.ratios.dXaRatio.toFixed(3)} · PRZ Skor ${sig.przScore}/100 (Murni aturan Fibonacci Scott Carney tanpa syarat wajib RSI ekstrem)`
    };
    const consensus = await evaluateDualAiConsensus(signalPayload, { winProb: Math.max(55, sig.przScore) });
    if (consensus && consensus.approved) {
      return {
        approved: true,
        groq: consensus.groqVerdict || "APPROVE",
        gemini: consensus.geminiVerdict || "APPROVE",
        reason: consensus.summary || `Dual-AI VALID (${sig.patternName} PRZ ${sig.przScore}/100)`
      };
    }
    return {
      approved: false,
      groq: consensus?.groqVerdict || "REJECT",
      gemini: consensus?.geminiVerdict || "REJECT",
      reason: consensus?.summary || "Ditolak oleh konsensus Dual-AI"
    };
  } catch (e) {
    return { approved: false, reason: "Gagal evaluasi Dual-AI: " + e.message };
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

async function updateActiveCandidateUi(payload) {
  try {
    fs.writeFileSync(path.join(__dirname, ".liveUiState.json"), JSON.stringify(payload, null, 2));
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
  const isPaper = liveAutoReady ? (cfg.forcePaperOnly === true) : true;

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

  // Guard 4: Audit Khusus Groq AI (Gemini tidak disentuh)
  const groqAudit = await auditHarmonicDualAi(symbol, sig);
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
  const snap = await getFuturesSnapshot();
  if (!creds || !creds.autoTrade || !snap || !snap.ok) {
    return { executed: false, reason: "Auto-Trade Live nonaktif atau koneksi Futures gagal" };
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
  await fapiRequest("POST", "/fapi/v1/leverage", { symbol, leverage: creds.leverage || 20 }, creds, true);

  await fapiRequest("POST", "/fapi/v1/order", { symbol, side, type: "MARKET", quantity: qty }, creds, true);
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
  return { executed: true, mode: "LIVE", reason: `Live Order Independen ${sig.patternName} terkirim (${groqAudit.reason})` };
}

/**
 * Runner Utama Pemindaian Harmonic Pattern (Hierarki wajib: 4h -> 1h -> 15m)
 */
async function runHarmonicScanCycle({ candidates, sharedCandles = {}, apiGetFn, db, admin, dryRun = false }) {
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

        const neededTfs = ["4h", "1h", "15m"].filter(tf => !candlesByTf[tf]);
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
          geminiStatus: "EMA-ONLY",
          tradeResult: "PENDING",
          tradeReason: sig.reason,
          updatedAt: Date.now()
        });

        const execRes = dryRun ? { executed: false, reason: 'DRY-RUN' } : await executeHarmonicOrder(sym, sig, cfg, paper);
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
      } else if (res.logs && res.logs.length) {
        const interesting = res.logs.find(l => l.includes("PRZ OK") || l.includes("ditolak: RR"));
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

module.exports = { runHarmonicScanCycle, loadHarmonicSettings, loadPaperState };
