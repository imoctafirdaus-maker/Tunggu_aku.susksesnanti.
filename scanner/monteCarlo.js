"use strict";
const https = require("https");

const DATA_HOSTS = [
  "data-api.binance.vision",
  "api.binance.com",
  "api1.binance.com",
  "api2.binance.com"
];

function fetchKlines5m(symbol, limit = 150) {
  return new Promise(async (resolve) => {
    for (const host of DATA_HOSTS) {
      try {
        const data = await new Promise((res, rej) => {
          const req = https.get(
            `https://${host}/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}`,
            { timeout: 8000 },
            (r) => {
              let body = "";
              r.on("data", (c) => { body += c; });
              r.on("end", () => {
                if (r.statusCode !== 200) return rej(new Error(`HTTP ${r.statusCode}`));
                try { res(JSON.parse(body)); } catch (e) { rej(e); }
              });
            }
          );
          req.on("timeout", () => req.destroy(new Error("timeout")));
          req.on("error", rej);
        });
        if (Array.isArray(data) && data.length >= 60) return resolve(data);
      } catch (_) {}
    }
    resolve(null);
  });
}

// Generator bilangan acak distribusi normal (Box-Muller)
function randNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

async function runTimeMachineCheck(rec, minWinProb = 38.0, paths = 2000, horizonCandles = 48) {
  if (!rec || !rec.symbol || !rec.entryPrice || !rec.stopLoss || !rec.takeProfit) {
    return { pass: true, winProb: null, note: "Data harga tidak lengkap, dilewati" };
  }

  const klines = await fetchKlines5m(rec.symbol, 150);
  if (!klines) {
    // Jika gagal ambil data historis sesaat, jangan memblokir sistem utama
    return { pass: true, winProb: null, note: "Data kline historis timeout, fallback lolos" };
  }

  const closes = klines.map(k => +k[4]).filter(n => Number.isFinite(n) && n > 0);
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (logReturns.length < 30) return { pass: true, winProb: null, note: "Sampel kurang" };

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Gunakan drift netral (0) agar simulasi murni menguji struktur volatilitas & jarak SL/TP
  const isLong = rec.signal === "BUY";
  const entry = +rec.entryPrice;
  const sl = +rec.stopLoss;
  const tp = +rec.takeProfit;

  let tpHits = 0;
  let slHits = 0;

  for (let p = 0; p < paths; p++) {
    let price = entry;
    for (let step = 0; step < horizonCandles; step++) {
      const shock = stdDev * randNormal();
      price = price * Math.exp(-0.5 * variance + shock);
      if (isLong) {
        if (price <= sl) { slHits++; break; }
        if (price >= tp) { tpHits++; break; }
      } else {
        if (price >= sl) { slHits++; break; }
        if (price <= tp) { tpHits++; break; }
      }
    }
  }

  const resolved = tpHits + slHits;
  const winProb = resolved > 0 ? (tpHits / resolved) * 100 : 50.0;

  return {
    pass: winProb >= minWinProb,
    winProb: Number(winProb.toFixed(1)),
    tpHits,
    slHits,
    unresolved: paths - resolved
  };
}

if (require.main === module && process.argv.includes("--test")) {
  (async () => {
    const sample = {
      symbol: "BTCUSDT",
      signal: "BUY",
      entryPrice: 69000,
      stopLoss: 68500,
      takeProfit: 69500
    };
    const res = await runTimeMachineCheck(sample, 52.0);
    console.log("✅ Uji Monte Carlo TimeMachine (2.000 skenario):", res);
  })();
}

module.exports = { runTimeMachineCheck };
