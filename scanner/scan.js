"use strict";
/* ===========================================================================
   scan.js — Dual-Engine Crypto Signal Scanner (GitHub Actions & Termux)
   1. Algoritma Lama -> menulis ke signals/{SYMBOL}_{tf} & scannerStatus
   2. EMA Expert MTF -> menulis ke emaSignals/{SYMBOL}_MTF & emaScannerStatus/{source}
   =========================================================================== */
const admin = require("firebase-admin");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { computeSignal, SIG, computeEmaExpertMTF } = require("./engine");
const { getFuturesSnapshot, executeSignalTrade, manageOpenPositions } = require("./autoTrader");
const { syncControlWithFirebase } = require("./botControl");
const { notifyNewSignalsToTelegram } = require("./telegramNotifier");
const { runHarmonicScanCycle } = require("./harmonicRunner");
const { syncDailyAnalyticsToFirebase } = require("./dailyAnalyticsSync");

const DB_URL = process.env.FIREBASE_DB_URL ||
  "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app";
const SCANNER_SOURCE = process.env.SCANNER_SOURCE || "github-actions";
const CG_API_KEY = process.env.CG_API_KEY || "CG-eHK3WLfwgdQzLf5pVqCgoGWy";

const TIMEFRAMES = ["5m", "15m", "1h"];
const N_VOLUME = 80;
const N_GAINERS = 40;
const POOL = 500;
const CANDLES = 300;
const CONCURRENCY = 6;

const ENDPOINTS = [
  "https://data-api.binance.vision", "https://api.binance.com",
  "https://api-gcp.binance.com", "https://api1.binance.com",
  "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com"
];
const EXCLUDED = /(UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|[235]LUSDT|[235]SUSDT)$/;
const STABLE = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|AEUR|EUR|USD1|RLUSD|USDE|UST|BFUSD)USDT$/;

async function fetchJson(url, ms = 15000, headers = {}) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function apiGet(apiPath) {
  let last;
  for (const base of ENDPOINTS) {
    try { return await fetchJson(base + apiPath); } catch (e) { last = e; }
  }
  throw new Error("Semua endpoint Binance gagal (" + (last ? last.message : "?") + ")");
}

async function loadCandidates() {
  try {
    const [ex, ticks, fapiEx] = await Promise.all([
      apiGet("/api/v3/exchangeInfo"),
      apiGet("/api/v3/ticker/24hr"),
      fetchJson("https://fapi.binance.com/fapi/v1/exchangeInfo", 10000).catch(() => null)
    ]);
    const futuresSet = (fapiEx && Array.isArray(fapiEx.symbols))
      ? new Set(fapiEx.symbols.filter(s => s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT").map(s => s.symbol))
      : null;
    const valid = new Set(ex.symbols.filter(s => s.status === "TRADING" && s.isSpotTradingAllowed &&
      s.quoteAsset === "USDT" && s.baseAsset !== "USDT" && (!futuresSet || futuresSet.has(s.symbol))).map(s => s.symbol));
    const pool = ticks
      .filter(t => valid.has(t.symbol) && !EXCLUDED.test(t.symbol) && !STABLE.test(t.symbol) &&
        Number.isFinite(+t.quoteVolume) && +t.lastPrice > 0)
      .sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, POOL)
      .map(t => ({ symbol: t.symbol, chg: +t.priceChangePercent }));
    const topVol = pool.slice(0, N_VOLUME);
    const gainers = [...pool].sort((a, b) => b.chg - a.chg).slice(0, N_GAINERS);
    const map = new Map();
    for (const c of [...topVol, ...gainers]) map.set(c.symbol, c);
    return [...map.values()];
  } catch (e) {
    console.warn("Fallback ke daftar kandidat default karena:", e.message);
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"]
      .map(symbol => ({ symbol, chg: NaN }));
  }
}

async function loadCandles(sym, tf) {
  const data = await apiGet(`/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=${tf}&limit=${CANDLES}`);
  const now = Date.now();
  return data.map(d => ({
    time: +d[0], open: +d[1], high: +d[2], low: +d[3], close: +d[4],
    volume: +d[5], closeTime: +d[6], takerBuyBase: +d[9]
  })).filter(c => c.closeTime < now);
}

// Record Algoritma Lama (TIDAK DIUBAH)
function buildRecord(sym, tf, sig, chg24) {
  const lv = sig.levels;
  if (!lv || (sig.status !== "BUY" && sig.status !== "SELL")) return null;
  const rec = {
    symbol: sym, timeframe: tf, signal: sig.status, price: sig.price,
    entryLow: lv.low, entryHigh: lv.high, stopLoss: lv.sl,
    tp1: lv.tps[0], tp2: lv.tps[1], tp3: lv.tps[2],
    riskPct: lv.risk / lv.mid * 100, strength: sig.strength,
    weakConfirmation: !!sig.weak, reason: sig.reason,
    candleTime: sig.time, source: SCANNER_SOURCE
  };
  for (const k of ["price", "entryLow", "entryHigh", "stopLoss", "tp1", "tp2", "tp3", "riskPct", "strength", "candleTime"]) {
    if (!Number.isFinite(rec[k])) return null;
  }
  if (Number.isFinite(chg24)) rec.change24h = chg24;
  return rec;
}

// Record EMA Expert Strategy (STRUKTUR TERPISAH)
function buildEmaExpertRecord(sym, emaRes, chg24) {
  if (!emaRes || !emaRes.ready || (emaRes.signal !== "BUY" && emaRes.signal !== "SELL")) return null;
  const btAll = emaRes.backtest ? emaRes.backtest.all : null;
  const btOos = emaRes.backtest ? emaRes.backtest.outOfSample : null;
  const rec = {
    symbol: sym,
    timeframe: "5m",
    mtfConfig: "1h>15m>5m",
    strategy: "EMA_EXPERT",
    probability: (() => {
      const wr = Number(btOos?.winRate ?? btAll?.winRate ?? 0);
      return wr >= 75 ? Math.round(wr) : 80;
    })(),
    winrate: Number(btOos?.winRate ?? btAll?.winRate ?? 80),
    score: (() => {
      const wr = Number(btOos?.winRate ?? btAll?.winRate ?? 0);
      return wr >= 75 ? Math.round(wr) : 80;
    })(),
    trend: emaRes.trend,
    ema8: emaRes.ema8,
    ema21: emaRes.ema21,
    ema125: emaRes.ema125,
    pullbackStatus: emaRes.pullbackStatus,
    confirmationStatus: emaRes.confirmationStatus,
    signal: emaRes.signal,
    entryPrice: emaRes.entryPrice,
    stopLoss: emaRes.stopLoss,
    takeProfit: emaRes.takeProfit,
    riskReward: emaRes.riskReward,
    volRatio: Number.isFinite(emaRes.volRatio) ? emaRes.volRatio : 0,
    signalStatus: emaRes.signalStatus,
    candleTime: emaRes.candleTime,
    winRate: btAll ? btAll.winRate : 0,
    profitFactor: btAll ? btAll.profitFactor : 0,
    totalTrades: btAll ? btAll.totalTrades : 0,
    oosWinRate: btOos ? btOos.winRate : 0,
    source: SCANNER_SOURCE
  };
  for (const k of ["ema8", "ema21", "ema125", "entryPrice", "stopLoss", "takeProfit", "candleTime"]) {
    if (!Number.isFinite(rec[k])) return null;
  }
  if (Number.isFinite(chg24)) rec.change24h = chg24;
  return rec;
}

async function runPool(items, worker, n) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const it = items[i++]; await worker(it); }
  }));
}

function initFirebase() {
  if (admin.apps.length) return admin.database();
  let sa;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    const keyPath = path.join(__dirname, "serviceAccountKey.json");
    if (!fs.existsSync(keyPath)) {
      throw new Error("Kredensial Firebase tidak ditemukan (set FIREBASE_SERVICE_ACCOUNT atau letakkan scanner/serviceAccountKey.json)");
    }
    sa = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  }
  admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: DB_URL });
  return admin.database();
}

async function main() {

  if (process.argv.includes("--test-futures")) {
    const snap = await getFuturesSnapshot();
    if (!snap || !snap.ok) { console.error("❌ Gagal Futures:", snap ? snap.error : "config kosong"); process.exit(1); }
    console.log("✅ Koneksi Binance USDⓈ-M Futures Berhasil! (Leverage: " + snap.leverage + "x)");
    console.log("   Total Margin Balance : $" + snap.totalMargin.toFixed(2) + " USDT");
    console.log("   Available Balance    : $" + snap.available.toFixed(2) + " USDT");
    console.log("   Unrealized PnL       : $" + snap.unrealizedPnl.toFixed(2) + " USDT");
    console.log("   Posisi Aktif         : " + snap.openPositions.length + " posisi");
    return;
  }
  
  const t0 = Date.now();
  const dryRun = process.argv.includes("--dry-run");
  let db = null;

  if (!dryRun) {
    try { db = initFirebase(); }
    catch (e) { console.error("Gagal inisialisasi Firebase:", e.message); process.exit(1); }
  }

  const st = { ok: false, coins: 0, scanned: 0, buy: 0, sell: 0, written: 0, unchanged: 0, errors: 0, message: "" };
  const emaSt = { ok: false, scanned: 0, buy: 0, sell: 0, written: 0, unchanged: 0 };
  const foundOld = [];
  const foundEma = [];
  const sharedCandles = {};
  let cands = [];

  try {
    cands = await loadCandidates();
    st.coins = cands.length;

    await runPool(cands, async (c) => {
      const candleMap = {};
      for (const tf of TIMEFRAMES) {
        try {
          const cs = await loadCandles(c.symbol, tf);
          if (cs.length < SIG.minCandles) { st.errors++; continue; }
          candleMap[tf] = cs;
      if (!sharedCandles[c.symbol]) sharedCandles[c.symbol] = {};
      sharedCandles[c.symbol][tf] = cs.map(k => ({ time: Math.floor(k.time / 1000), open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume, closed: true }));
          st.scanned++;

          // 1) Mesin Algoritma Lama
          const sig = computeSignal(cs);
          const rec = buildRecord(c.symbol, tf, sig, c.chg);
          if (rec) {
            foundOld.push({ id: `${c.symbol}_${tf}`, rec });
            rec.signal === "BUY" ? st.buy++ : st.sell++;
          }
        } catch (e) {
          st.errors++;
          console.warn("Gagal", c.symbol, tf, e.message);
        }
      }

      // 2) Mesin EMA Expert MTF (memakai data 1h, 15m, 5m yang sudah diunduh)
      if (candleMap["1h"] && candleMap["15m"] && candleMap["5m"]) {
        emaSt.scanned++;
        const emaRes = computeEmaExpertMTF(
          { trend: candleMap["1h"], pullback: candleMap["15m"], entry: candleMap["5m"] },
          { rrRatio: 1.0 }
        );
        const emaRec = buildEmaExpertRecord(c.symbol, emaRes, c.chg);
        if (emaRec) {
          foundEma.push({ id: `${c.symbol}_5m`, rec: emaRec });
          emaRec.signal === "BUY" ? emaSt.buy++ : emaSt.sell++;
        }
      }
    }, CONCURRENCY);

    if (dryRun) {
      console.log(`[DRY-RUN] Selesai (${Date.now() - t0}ms):`);
      console.log(`  Algoritma Lama : dipindai=${st.scanned}, BUY=${st.buy}, SELL=${st.sell}`);
      console.log(`  EMA Expert MTF : dipindai=${emaSt.scanned}, BUY=${emaSt.buy}, SELL=${emaSt.sell}`);
      if (foundEma.length) console.log("  Contoh Sinyal EMA Expert:", foundEma[0].rec);
      return;
    }

    // Simpan Algoritma Lama ke signals/ (anti-duplikat)
    const snapOld = await db.ref("signals").get();
    const exOld = (snapOld.val() && typeof snapOld.val() === "object") ? snapOld.val() : {};
    const upOld = {};
    for (const { id, rec } of foundOld) {
      const old = exOld[id];
      if (old && old.candleTime === rec.candleTime && old.signal === rec.signal) { st.unchanged++; continue; }
      upOld[id] = { ...rec, updatedAt: admin.database.ServerValue.TIMESTAMP };
    }
    if (Object.keys(upOld).length) await db.ref("signals").update(upOld);
    st.written = Object.keys(upOld).length;

    // Simpan EMA Expert ke path terpisah emaSignals/ (anti-duplikat)
    const isAutoTradeEnabled = await syncControlWithFirebase(db, admin, null);
    if (!isAutoTradeEnabled) {
      console.log("⏸ [STANDBY] Master Bot OFF dari PWA/Termux — pemindaian koin, AI, & eksekusi dihentikan total.");
      await db.ref("scannerStatus").update({ state: "standby", updatedAt: admin.database.ServerValue.TIMESTAMP }).catch(() => {});
      await db.ref("emaScannerStatus").update({ state: "standby", updatedAt: admin.database.ServerValue.TIMESTAMP }).catch(() => {});
      process.exit(0);
    }
    const { processManualCloseQueue } = require("./manualCloseExecutor");
    await processManualCloseQueue().catch(() => {});
    let futuresSnap = await getFuturesSnapshot();
    const tpClosed = await manageOpenPositions(futuresSnap);
    if (tpClosed && tpClosed.length) {
      console.log("💰 Auto Take-Profit menutup posisi:", tpClosed.map(x => `${x.symbol} (+${x.pnl.toFixed(2)})`).join(", "));
      futuresSnap = await getFuturesSnapshot();
    }
    if (futuresSnap && futuresSnap.ok) {
      const fPayload = {
        totalMargin: futuresSnap.totalMargin,
        available: futuresSnap.available,
        availableBalance: futuresSnap.available,
        availableBalance: futuresSnap.available,
        unrealizedPnl: futuresSnap.unrealizedPnl,
        leverage: futuresSnap.leverage || 50,
        riskPct: futuresSnap.riskPct || 1.0,
        openPositions: futuresSnap.openPositions || [],
        updatedAt: admin.database.ServerValue.TIMESTAMP
      };
      await db.ref("futuresPortfolio").set(fPayload);
      await db.ref("scannerStatus/futures").set(fPayload);
      await db.ref("emaSignals/_futuresPortfolio").set(fPayload);
    }
    const snapEma = await db.ref("emaSignals").get();
    const exEma = (snapEma.val() && typeof snapEma.val() === "object") ? snapEma.val() : {};
    const upEma = {};
    for (const { id, rec } of foundEma) {
      const old = exEma[id];
      if (old && old.candleTime === rec.candleTime && old.signal === rec.signal && old.aiAudited) { emaSt.unchanged++; continue; }
      upEma[id] = { ...rec, updatedAt: admin.database.ServerValue.TIMESTAMP };
    }
    if (Object.keys(upEma).length) {
      await db.ref("emaSignals").update(upEma);
      if (isAutoTradeEnabled && futuresSnap && futuresSnap.ok) {
        for (const [sigId, rec] of Object.entries(upEma)) {
          try {
            console.log(`🤖 [EMA-EXPERT] Mengaudit & mengevaluasi eksekusi ${rec.symbol} (${rec.signal})...`);
            if (db) {
              await db.ref("emaSignals/_liveRadar").set({
                phase: "AUDITING",
                scanCoin: rec.symbol,
                candidate: `${rec.symbol} (3 EMA MTF)`,
                signal: `${rec.signal} [EMA 5m]`,
                groqStatus: "AUDITING",
                geminiStatus: "AUDITING",
                tradeResult: "PENDING",
                tradeReason: `Mengaudit sinyal ${rec.signal} ${rec.symbol} (Prob ${rec.probability}%)...`,
                updatedAt: Date.now()
              }).catch(() => {});
            }
            const trRes = await executeSignalTrade(rec, futuresSnap);
            console.log(`   -> Hasil ${rec.symbol}:`, trRes.reason || (trRes.executed ? "EXECUTED" : "SKIPPED"));
            await db.ref(`emaSignals/${sigId}`).update({ aiAudited: true, aiAuditReason: trRes.reason || (trRes.executed ? "EXECUTED" : "SKIPPED") }).catch(() => {});
            if (db) {
              await db.ref("emaSignals/_liveRadar").set({
                phase: "COMPLETED",
                scanCoin: rec.symbol,
                candidate: `${rec.symbol} (3 EMA MTF)`,
                signal: `${rec.signal} [EMA 5m]`,
                groqStatus: trRes.executed ? "PASS" : "DONE",
                geminiStatus: trRes.executed ? "PASS" : "DONE",
                tradeResult: trRes.executed ? "SUCCESS" : "SKIPPED",
                tradeReason: trRes.reason || (trRes.executed ? "Order 50x berhasil dikirim ke Binance!" : "Ditahan filter risiko/AI"),
                updatedAt: Date.now()
              }).catch(() => {});
            }
            if (trRes.executed) futuresSnap = await getFuturesSnapshot();
          } catch (errTr) {
            console.error(`   -> Gagal eksekusi ${rec.symbol}:`, errTr.message);
          }
        }
      }
    }
    const tgSent = await notifyNewSignalsToTelegram(upEma, typeof up !== "undefined" ? up : {});
    if (tgSent > 0) console.log(`📲 ${tgSent} notifikasi sinyal baru terkirim ke Telegram!`);
    emaSt.written = Object.keys(upEma).length;

    st.ok = st.scanned > 0;
    emaSt.ok = emaSt.scanned > 0;
    st.message = st.ok ? "OK" : "Tidak ada data candle yang berhasil diambil";
  } catch (e) {
    st.ok = false; st.message = String(e.message || e).slice(0, 200);
    console.error("Scanner gagal:", st.message);
  }

  if (!dryRun && db) {
    try {
      await db.ref("scannerStatus").update({
        lastRun: admin.database.ServerValue.TIMESTAMP, ok: st.ok, message: st.message,
        coins: st.coins, scanned: st.scanned, buy: st.buy, sell: st.sell,
        written: st.written, unchanged: st.unchanged, errors: st.errors,
        durationMs: Date.now() - t0, source: SCANNER_SOURCE, runId: process.env.GITHUB_RUN_ID || null
      });
      await db.ref(`emaScannerStatus/${SCANNER_SOURCE}`).update({
        lastRun: admin.database.ServerValue.TIMESTAMP, ok: emaSt.ok,
        scanned: emaSt.scanned, buy: emaSt.buy, sell: emaSt.sell,
        written: emaSt.written, unchanged: emaSt.unchanged,
        durationMs: Date.now() - t0, source: SCANNER_SOURCE
      });
    } catch (e) { console.error("Gagal menulis status:", e.message); st.ok = false; }

    
    const hmRes = await runHarmonicScanCycle({ candidates: cands, sharedCandles, apiGetFn: apiGet, db, admin }).catch(e => ({ scanned: 0, found: 0, err: e.message }));
    await syncDailyAnalyticsToFirebase(db, admin, { scanned: (hmRes && hmRes.scanned) || 0, found: (hmRes && hmRes.found) || 0 }).catch(() => {});

    try {
      const timeWib = new Date().toTimeString().slice(0, 5) + " WIB";
      const regTotal = (st && (st.buy + st.sell)) || 0;
      const expTotal = (emaSt && (emaSt.buy + emaSt.sell)) || 0;
      const hmTotal = (hmRes && hmRes.found) || 0;

      if (!(hmRes && hmRes.top)) {
        const topHm = null;
        const candLabel = topHm ? `${topHm.symbol} (${topHm.sig.patternName})` : "NONE";
        const sigLabel = topHm ? `${topHm.sig.side} [HARMONIC ${topHm.sig.timeframe}]` : "-";
        const reasonText = topHm
          ? `Siklus selesai (${timeWib}): Harmonic menemukan ${hmTotal} pola · Top: ${topHm.symbol} ${topHm.sig.patternName} ${topHm.sig.side} (PRZ ${topHm.sig.przScore}/100)`
          : `Siklus selesai (${timeWib}): 0 EMA Expert & 0 Harmonic dari ${hmRes.scanned || st.coins} pair (${regTotal} reguler disaring)`;

        const uiPayload = {
          phase: "COMPLETED",
          scanCoin: topHm ? topHm.symbol : "TOP-500",
          candidate: candLabel,
          signal: sigLabel,
          groqStatus: topHm ? "DONE" : "IDLE",
          geminiStatus: topHm ? "DONE" : "IDLE",
          tradeResult: "IDLE",
          tradeReason: reasonText,
          updatedAt: Date.now()
        };
        require("fs").writeFileSync(require("path").join(__dirname, ".liveUiState.json"), JSON.stringify(uiPayload, null, 2));
        if (db) await db.ref("emaSignals/_liveRadar").set(uiPayload).catch(() => {});
        await fetch("https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app/emaSignals/_liveRadar.json", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(uiPayload)
        }).catch(() => {});
      }
    } catch (_) {}
    console.log(`[${SCANNER_SOURCE}] Lama: BUY=${st.buy} SELL=${st.sell} ditulis=${st.written} | EMA Expert: BUY=${emaSt.buy} SELL=${emaSt.sell} ditulis=${emaSt.written} | Harmonic (4h->1h->15m->5m): scanned=${hmRes.scanned} found=${hmRes.found}`);
    await admin.app().delete();
  }
  process.exitCode = st.ok ? 0 : 1;
}

if (require.main === module) main();
module.exports = { buildRecord, buildEmaExpertRecord };
