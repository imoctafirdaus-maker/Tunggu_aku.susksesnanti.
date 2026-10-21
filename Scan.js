"use strict";
/* ===========================================================================
   scan.js — Crypto Signal Scanner (dijalankan GitHub Actions)
   Alur: ambil Top 500 Binance -> pilih koin kandidat -> hitung sinyal memakai
   engine.js (logika sama dengan index.html) -> tulis BUY/SELL ke Firebase.

   Path Firebase yang ditulis (hanya dua ini):
     signals/{SYMBOL}_{timeframe}   satu entri per koin+timeframe (ditimpa bila
                                    ada candle baru; tidak ada duplikat)
     scannerStatus                  status terakhir scanner berjalan
   Data lain di database tidak disentuh dan tidak ada yang dihapus.
   =========================================================================== */
const admin = require("firebase-admin");
const { computeSignal, SIG } = require("./engine");

const DB_URL = process.env.FIREBASE_DB_URL ||
  "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app";

// Dapat Anda ubah. Cron GitHub minimal tiap 5 menit, jadi timeframe 1 menit
// tidak cocok untuk scanner ini.
const TIMEFRAMES = ["5m", "15m", "1h"];
const N_VOLUME = 10;      // koin volume 24 jam terbesar
const N_GAINERS = 10;     // koin kenaikan 24 jam tertinggi (dari Top 500)
const POOL = 500;
const CANDLES = 300;
const CONCURRENCY = 4;

const ENDPOINTS = [
  "https://data-api.binance.vision", "https://api.binance.com",
  "https://api-gcp.binance.com", "https://api1.binance.com",
  "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com"
];
const EXCLUDED = /(UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|[235]LUSDT|[235]SUSDT)$/;
const STABLE = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|AEUR|EUR|USD1|RLUSD|USDE|UST)USDT$/;

async function fetchJson(url, ms = 15000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function apiGet(path) {
  let last;
  for (const base of ENDPOINTS) {
    try { return await fetchJson(base + path); } catch (e) { last = e; }
  }
  throw new Error("Semua endpoint Binance gagal (" + (last ? last.message : "?") + ")");
}

async function loadCandidates() {
  const [ex, ticks] = await Promise.all([apiGet("/api/v3/exchangeInfo"), apiGet("/api/v3/ticker/24hr")]);
  const valid = new Set(ex.symbols.filter(s => s.status === "TRADING" && s.isSpotTradingAllowed &&
    s.quoteAsset === "USDT" && s.baseAsset !== "USDT").map(s => s.symbol));
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
}

async function loadCandles(sym, tf) {
  const data = await apiGet(`/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=${tf}&limit=${CANDLES}`);
  const now = Date.now();
  return data.map(d => ({ time: +d[0], open: +d[1], high: +d[2], low: +d[3], close: +d[4],
    volume: +d[5], closeTime: +d[6], takerBuyBase: +d[9] })).filter(c => c.closeTime < now);
}

function buildRecord(sym, tf, sig, chg24) {
  const lv = sig.levels;
  if (!lv || (sig.status !== "BUY" && sig.status !== "SELL")) return null;
  const rec = {
    symbol: sym, timeframe: tf, signal: sig.status, price: sig.price,
    entryLow: lv.low, entryHigh: lv.high, stopLoss: lv.sl,
    tp1: lv.tps[0], tp2: lv.tps[1], tp3: lv.tps[2],
    riskPct: lv.risk / lv.mid * 100, strength: sig.strength,
    weakConfirmation: !!sig.weak, reason: sig.reason,
    candleTime: sig.time, source: "github-actions"
  };
  for (const k of ["price", "entryLow", "entryHigh", "stopLoss", "tp1", "tp2", "tp3", "riskPct", "strength", "candleTime"]) {
    if (!Number.isFinite(rec[k])) return null;   // jangan pernah menyimpan angka tidak valid
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

async function main() {
  const t0 = Date.now();
  let db;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("secret FIREBASE_SERVICE_ACCOUNT kosong");
    let sa;
    try { sa = JSON.parse(raw); } catch (_) { throw new Error("isi secret FIREBASE_SERVICE_ACCOUNT bukan JSON valid"); }
    admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: DB_URL });
    db = admin.database();
  } catch (e) {
    console.error("Gagal inisialisasi Firebase:", e.message);   // tidak mencetak isi secret
    process.exit(1);
  }

  const st = { ok: false, coins: 0, scanned: 0, buy: 0, sell: 0, written: 0, unchanged: 0, errors: 0, message: "" };
  const found = [];
  try {
    const cands = await loadCandidates();
    st.coins = cands.length;
    const jobs = [];
    for (const c of cands) for (const tf of TIMEFRAMES) jobs.push({ c, tf });
    await runPool(jobs, async ({ c, tf }) => {
      try {
        const cs = await loadCandles(c.symbol, tf);
        if (cs.length < SIG.minCandles) { st.errors++; return; }
        st.scanned++;
        const sig = computeSignal(cs);
        const rec = buildRecord(c.symbol, tf, sig, c.chg);
        if (rec) { found.push({ id: `${c.symbol}_${tf}`, rec }); rec.signal === "BUY" ? st.buy++ : st.sell++; }
      } catch (e) { st.errors++; console.warn("Gagal", c.symbol, tf, e.message); }
    }, CONCURRENCY);

    // Hindari duplikat: lewati bila candle dan arah sinyalnya sama dengan yang sudah tersimpan
    const snap = await db.ref("signals").get();
    const existing = (snap.val() && typeof snap.val() === "object") ? snap.val() : {};
    const updates = {};
    for (const { id, rec } of found) {
      const old = existing[id];
      if (old && old.candleTime === rec.candleTime && old.signal === rec.signal) { st.unchanged++; continue; }
      updates[id] = { ...rec, updatedAt: admin.database.ServerValue.TIMESTAMP };
    }
    if (Object.keys(updates).length) await db.ref("signals").update(updates);
    st.written = Object.keys(updates).length;
    st.ok = st.scanned > 0;
    st.message = st.ok ? "OK" : "Tidak ada data candle yang berhasil diambil";
  } catch (e) {
    st.ok = false; st.message = String(e.message || e).slice(0, 200);
    console.error("Scanner gagal:", st.message);
  }

  try {
    await db.ref("scannerStatus").update({
      lastRun: admin.database.ServerValue.TIMESTAMP, ok: st.ok, message: st.message,
      coins: st.coins, scanned: st.scanned, buy: st.buy, sell: st.sell,
      written: st.written, unchanged: st.unchanged, errors: st.errors,
      durationMs: Date.now() - t0, runId: process.env.GITHUB_RUN_ID || null
    });
  } catch (e) { console.error("Gagal menulis scannerStatus:", e.message); st.ok = false; }

  console.log(`Selesai: koin=${st.coins} dipindai=${st.scanned} BUY=${st.buy} SELL=${st.sell} ditulis=${st.written} tak-berubah=${st.unchanged} error=${st.errors}`);
  await admin.app().delete();
  process.exitCode = st.ok ? 0 : 1;
}

if (require.main === module) main();
module.exports = { buildRecord };
