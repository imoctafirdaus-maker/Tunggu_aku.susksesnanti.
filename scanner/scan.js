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
const { computeSignal, SIG, evaluateIctVolumeDeltaMTF } = require("./engine");
const { IctOrderFlowCollector } = require("./ictWsCollector");
const ictCollector = new IctOrderFlowCollector({ maxSymbols: 25, maxMinutesPerSymbol: 180 });
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
const N_VOLUME = 500;
const N_GAINERS = 100;
const POOL = 500;
const CANDLES = 300;
const CONCURRENCY = 7;

const ENDPOINTS = [
  "https://data-api.binance.vision", "https://api.binance.com",
  "https://api-gcp.binance.com", "https://api1.binance.com",
  "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com"
];
const EXCLUDED = /(UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|[235]LUSDT|[235]SUSDT)$/;
const STABLE = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|AEUR|EUR|USD1|RLUSD|USDE|UST|BFUSD)USDT$/;

async function fetchJson(url, ms = 25000, headers = {}) {
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
      apiGet("/api/v3/ticker/24hr").catch(() => apiGet("/api/v3/ticker/price")),
      require("./autoTrader").fapiRequest("GET", "/fapi/v1/exchangeInfo", {}, { isDemo: false }, false).catch(() => null)
    ]);
    const futuresSet = (fapiEx && Array.isArray(fapiEx.symbols))
      ? new Set(fapiEx.symbols.filter(s => s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT").map(s => s.symbol))
      : null;
    const valid = new Set(ex.symbols.filter(s => s.status === "TRADING" && s.isSpotTradingAllowed &&
      s.quoteAsset === "USDT" && s.baseAsset !== "USDT").map(s => s.symbol));
    const allSorted = ticks
      .filter(t => valid.has(t.symbol) && !EXCLUDED.test(t.symbol) && !STABLE.test(t.symbol) &&
        (Number.isFinite(+t.quoteVolume) ? +t.lastPrice > 0 : +t.price > 0))
      .sort((a, b) => (+b.quoteVolume || 0) - (+a.quoteVolume || 0));
    const futuresFirst = futuresSet ? allSorted.filter(t => futuresSet.has(t.symbol)) : allSorted;
    const spotRest = futuresSet ? allSorted.filter(t => !futuresSet.has(t.symbol)) : [];
    const pool = [...futuresFirst, ...spotRest]
      .slice(0, POOL)
      .map(t => ({ symbol: t.symbol, chg: Number.isFinite(+t.priceChangePercent) ? +t.priceChangePercent : NaN }));
    const topVol = pool.slice(0, N_VOLUME);
    const gainers = [...pool].sort((a, b) => b.chg - a.chg).slice(0, N_GAINERS);
    const map = new Map();
    for (const c of [...topVol, ...gainers]) map.set(c.symbol, c);
    const list = [...map.values()];
    list.futuresSymbols = futuresSet;
    if (list.length >= 100) {
      try { fs.writeFileSync(path.join(__dirname, ".candidatesCache.json"), JSON.stringify(list)); } catch (_) {}
    }
    return list;
  } catch (e) {
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(__dirname, ".candidatesCache.json"), "utf8"));
      if (Array.isArray(cached) && cached.length >= 100) {
        console.warn("Memakai cache 500 kandidat karena API sempat tersendat:", e.message);
        return cached;
      }
    } catch (_) {}
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

// Record ICT + SMC + Volume Delta Expert Strategy (STRUKTUR TERPISAH)
function buildIctExpertRecord(sym, ictRes, chg24) {
  if (!ictRes || !ictRes.ready || (ictRes.signal !== "BUY" && ictRes.signal !== "SELL")) return null;
  if (ictRes.dataQuality !== "VALID") return null;
  const rec = {
    symbol: sym,
    timeframe: "1h/15m/5m",
    mtfConfig: "1h>15m>5m",
    strategy: "ICT_SMC_VD",
    strategyLabel: ictRes.strategyLabel || "ICT + VOLUME DELTA EXPERT",
    category: ictRes.category || ictRes.signal,
    probability: Number(ictRes.score) || 0,
    winrate: Number(ictRes.score) || 0,
    score: Number(ictRes.score) || 0,
    trend: ictRes.ictEvidence?.marketDirection1h || ictRes.ictEvidence?.marketDirection15m || "NEUTRAL",
    signal: ictRes.signal,
    entryPrice: ictRes.entryPrice,
    stopLoss: ictRes.stopLoss,
    takeProfit: ictRes.takeProfit1,
    takeProfit1: ictRes.takeProfit1,
    takeProfit2: ictRes.takeProfit2,
    riskReward: ictRes.riskReward,
    grossRR: ictRes.grossRR,
    invalidation: ictRes.invalidation || "",
    reason: ictRes.reason || "",
    reasons: Array.isArray(ictRes.reasons) ? ictRes.reasons : [],
    breakdown: ictRes.breakdown || {},
    ictEvidence: ictRes.ictEvidence || {},
    volumeDeltaEvidence: ictRes.volumeDeltaEvidence || {},
    dataQuality: ictRes.dataQuality,
    strict7Confluence: Boolean(ictRes.strict7Confluence),
    candleTime: ictRes.candleTime,
    source: SCANNER_SOURCE
  };
  for (const k of ["entryPrice", "stopLoss", "takeProfit", "candleTime"]) {
    if (!Number.isFinite(rec[k])) return null;
  }
  if (Number.isFinite(chg24)) rec.change24h = chg24;
  return rec;
}

function candleMapFallback(shared, sym, tf) {
  const arr = shared && shared[sym] && shared[sym][tf];
  return Array.isArray(arr) ? arr.map(k => ({ ...k, time: k.time * 1000 })) : null;
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
  let scannerFlags = { ictScannerEnabled: true, harmonicScannerEnabled: true };

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

    }, CONCURRENCY);

    // Baca status saklar mesin scanner (ICT+VD & Harmonic)
    scannerFlags = { ictScannerEnabled: true, harmonicScannerEnabled: true };
    try {
      const aiCfgFile = path.join(__dirname, "aiConfig.json");
      if (fs.existsSync(aiCfgFile)) {
        const parsed = JSON.parse(fs.readFileSync(aiCfgFile, "utf8"));
        if (typeof parsed.ictScannerEnabled === "boolean") scannerFlags.ictScannerEnabled = parsed.ictScannerEnabled;
        if (typeof parsed.harmonicScannerEnabled === "boolean") scannerFlags.harmonicScannerEnabled = parsed.harmonicScannerEnabled;
      }
    } catch (_) {}

    // 2) Mesin ICT + SMC + True Volume Delta Expert MTF (1h Struktur & VD -> 15m Validasi -> 5m Eksekusi)
    const ictCands = scannerFlags.ictScannerEnabled ? cands.slice(0, 35) : [];
    if (!scannerFlags.ictScannerEnabled) {
      console.log("⏸ [ICT-SMC-VD] Scanner ICT + VD OFF via saklar UI — pemindaian ICT dilewati.");
    }
    await runPool(ictCands, async (c) => {
      try {
        const [f1h, f15, f5] = await Promise.all([
          ictCollector.fetchFuturesKlines(c.symbol, "1h", 120),
          ictCollector.fetchFuturesKlines(c.symbol, "15m", 120),
          ictCollector.fetchFuturesKlines(c.symbol, "5m", 120)
        ]);
        const candles1h = f1h.length >= 25 ? f1h : (candleMapFallback(sharedCandles, c.symbol, "1h") || []);
        const candles15m = f15.length >= 25 ? f15 : (candleMapFallback(sharedCandles, c.symbol, "15m") || []);
        const candles5m = f5.length >= 25 ? f5 : (candleMapFallback(sharedCandles, c.symbol, "5m") || []);
        if (candles1h.length < 25 || candles15m.length < 25 || candles5m.length < 25) return;
        emaSt.scanned++;
        const ictRes = evaluateIctVolumeDeltaMTF({
          symbol: c.symbol,
          scannerId: SCANNER_SOURCE,
          candles1h,
          candles15m,
          candles5m
        });
        const ictRec = buildIctExpertRecord(c.symbol, ictRes, c.chg);
        if (ictRec) {
          foundEma.push({ id: `${c.symbol}_MTF`, rec: ictRec });
          ictRec.signal === "BUY" ? emaSt.buy++ : emaSt.sell++;
        }
      } catch (_) {}
    }, 5);

    if (dryRun) {
      console.log(`[DRY-RUN] Selesai (${Date.now() - t0}ms):`);
      console.log(`  Algoritma Lama : dipindai=${st.scanned}, BUY=${st.buy}, SELL=${st.sell}`);
      console.log(`  ICT+SMC+VD MTF : dipindai=${emaSt.scanned}, BUY=${emaSt.buy}, SELL=${emaSt.sell}`);
      if (foundEma.length) console.log("  Contoh Sinyal ICT + Volume Delta Expert:", foundEma[0].rec);
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
        let ictAiOn = !(exEma._botControl && exEma._botControl.ictAiAuditEnabled === false);
        try {
          const aiCfgFile = path.join(__dirname, "aiConfig.json");
          if (fs.existsSync(aiCfgFile)) {
            const aiCfg = JSON.parse(fs.readFileSync(aiCfgFile, "utf8"));
            if (typeof aiCfg.ictAiAuditEnabled === "boolean") ictAiOn = aiCfg.ictAiAuditEnabled;
          }
        } catch (_) {}

        for (const [sigId, rec] of Object.entries(upEma)) {
          try {
            console.log(ictAiOn
              ? `🤖 [ICT-SMC-VD] Mengaudit & mengevaluasi eksekusi ${rec.symbol} (${rec.signal})...`
              : `⚡ [ICT-SMC-VD] Audit AI OFF — Termux mengambil alih eksekusi ${rec.symbol} (${rec.signal})...`);
            if (db) {
              await db.ref("emaSignals/_liveRadar").set({
                phase: ictAiOn ? "AUDITING" : "EXECUTING",
                scanCoin: rec.symbol,
                candidate: `${rec.symbol} (ICT + SMC + VD)`,
                signal: `${rec.signal} [ICT 1h/15m/5m]`,
                groqStatus: ictAiOn ? "AUDITING" : "BYPASS (OFF)",
                geminiStatus: ictAiOn ? "AUDITING" : "BYPASS (OFF)",
                tradeResult: "PENDING",
                tradeReason: ictAiOn
                  ? `Mengaudit sinyal ${rec.signal} ${rec.symbol} (Skor ${rec.probability}%)...`
                  : `Audit AI ICT+VD OFF — Mengevaluasi eksekusi langsung ${rec.signal} ${rec.symbol}...`,
                updatedAt: Date.now()
              }).catch(() => {});
            }
            const trRes = await executeSignalTrade(rec, futuresSnap);
            rec.autoExecuted = Boolean(trRes && trRes.executed);
            if (trRes && trRes.leverage) rec.appliedLeverage = trRes.leverage;
            rec.aiSummary = (trRes && trRes.reason) || (rec.autoExecuted ? (ictAiOn ? "Lolos Audit Dual-AI" : "Eksekusi Langsung Termux (AI OFF)") : "SKIPPED");
            console.log(`   -> Hasil ${rec.symbol}:`, trRes.reason || (trRes.executed ? "EXECUTED" : "SKIPPED"));
            await db.ref(`emaSignals/${sigId}`).update({
              aiAudited: true,
              aiBypassed: !ictAiOn,
              autoExecuted: rec.autoExecuted,
              aiAuditReason: trRes.reason || (trRes.executed ? "EXECUTED" : "SKIPPED")
            }).catch(() => {});
            if (db) {
              await db.ref("emaSignals/_liveRadar").set({
                phase: "COMPLETED",
                scanCoin: rec.symbol,
                candidate: `${rec.symbol} (ICT + SMC + VD)`,
                signal: `${rec.signal} [ICT 1h/15m/5m]`,
                groqStatus: ictAiOn ? (trRes.executed ? "PASS" : "DONE") : "OFF",
                geminiStatus: ictAiOn ? (trRes.executed ? "PASS" : "DONE") : "OFF",
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
    const tgSent = await notifyNewSignalsToTelegram(upEma, typeof upOld !== "undefined" ? upOld : {});
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

    
    let harmonicOn = scannerFlags.harmonicScannerEnabled;
    try {
      const aiCfgFile = path.join(__dirname, "aiConfig.json");
      if (fs.existsSync(aiCfgFile)) {
        const parsed = JSON.parse(fs.readFileSync(aiCfgFile, "utf8"));
        if (typeof parsed.harmonicScannerEnabled === "boolean") harmonicOn = parsed.harmonicScannerEnabled;
      }
    } catch (_) {}
    if (!harmonicOn) {
      console.log("⏸ [HARMONIC] Scanner Harmonic OFF via saklar UI — pemindaian Harmonic dilewati.");
    }
    const hmRes = harmonicOn
      ? await runHarmonicScanCycle({ candidates: cands, sharedCandles, apiGetFn: apiGet, db, admin, futuresSymbols: cands && cands.futuresSymbols }).catch(e => ({ scanned: 0, patternFound: 0, futuresEligible: 0, watch: 0, skipped: 0, executed: 0, found: 0, err: e.message }))
      : { scanned: 0, patternFound: 0, futuresEligible: 0, watch: 0, skipped: 0, executed: 0, found: 0, disabled: true };
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
          : `Siklus selesai (${timeWib}): 0 ICT+VD Expert & 0 Harmonic dari ${hmRes.scanned || st.coins} pair (${regTotal} reguler disaring)`;

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
    console.log(`[${SCANNER_SOURCE}] Lama: BUY=${st.buy} SELL=${st.sell} ditulis=${st.written} | EMA Expert: BUY=${emaSt.buy} SELL=${emaSt.sell} ditulis=${emaSt.written} | Harmonic (4h->1h->15m->5m): scanned=${hmRes.scanned ?? 0} patternFound=${hmRes.patternFound ?? hmRes.found ?? 0} futuresEligible=${hmRes.futuresEligible ?? hmRes.found ?? 0} watch=${hmRes.watch ?? 0} skipped=${hmRes.skipped ?? 0} executed=${hmRes.executed ?? 0}`);
    await admin.app().delete();
  }
  process.exitCode = st.ok ? 0 : 1;
}

if (require.main === module) main();
module.exports = { buildRecord, buildIctExpertRecord, buildEmaExpertRecord: buildIctExpertRecord };
