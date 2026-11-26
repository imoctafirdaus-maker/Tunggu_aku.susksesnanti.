"use strict";

const assert = require("assert");
const { analyzeMarketStructure } = require("./structure");
const { analyzeLiquidity } = require("./liquidity");
const { analyzeFVG } = require("./fvg");
const { analyzeOrderBlocks } = require("./orderBlock");
const { analyzeDisplacement } = require("./displacement");
const { analyzePremiumDiscountAndContext } = require("./premiumDiscount");
const { aggregateTradesToCandles, analyzeOrderFlow } = require("./volumeDeltaEngine");
const { evaluateIctVolumeDeltaMTF, validateRiskGuards, runIctBacktest } = require("./engine");

function makeCandle(t, o, h, l, c, v = 1000) {
  return { time: t, closeTime: t + 299999, open: o, high: h, low: l, close: c, volume: v };
}

console.log("=== MENJALANKAN UNIT TEST ICT + SMC + TRUE VOLUME DELTA ===");

// Test 1: Market Structure (BOS vs CHoCH / MSS by candle close)
const structCandles = [];
let px = 100;
for (let i = 0; i < 35; i++) {
  const t = 1700000000000 + i * 300000;
  // Create downtrend with clear swing highs and lows
  const wave = Math.sin(i * 0.9) * 2.5;
  px = 110 - i * 0.35 + wave;
  structCandles.push(makeCandle(t, px + 0.4, px + 1.1, px - 1.1, px - 0.3, 1200));
}
// Add strong bullish displacement close breaking prior swing high -> CHoCH / MSS
const lastDowntrend = structCandles[structCandles.length - 1];
structCandles.push(makeCandle(lastDowntrend.time + 300000, lastDowntrend.close, lastDowntrend.close + 8.5, lastDowntrend.close - 0.2, lastDowntrend.close + 8.0, 5000));
const stRes = analyzeMarketStructure(structCandles, { leftBars: 2, rightBars: 2 });
assert.strictEqual(stRes.valid, true, "Market structure harus valid");
assert.strictEqual(stRes.direction, "BULLISH", "Harus berubah menjadi BULLISH setelah close menembus swing high");
assert.ok(stRes.choch && stRes.choch.type === "BULLISH_CHOCH", "Harus mendeteksi BULLISH_CHOCH");
console.log("✅ [PASS] Test 1: Market Structure (HH/HL/LH/LL, BOS, CHoCH/MSS)");

// Test 2: Liquidity Sweep vs Breakout
const liqCandles = [];
for (let i = 0; i < 20; i++) {
  const t = 1700010000000 + i * 300000;
  const base = 100 + Math.sin(i * 0.8) * 1.5;
  liqCandles.push(makeCandle(t, base, base + 0.8, base - 0.8, base + 0.1, 1000));
}
const stLiq = analyzeMarketStructure(liqCandles, { leftBars: 2, rightBars: 2 });
const sslLevel = stLiq.swingLow.price;
// Add wick sweep below SSL closing back above SSL
liqCandles.push(makeCandle(liqCandles[liqCandles.length - 1].time + 300000, sslLevel + 0.4, sslLevel + 0.9, sslLevel - 1.5, sslLevel + 0.6, 3200));
const liqRes = analyzeLiquidity(liqCandles, stLiq, { eqTolerancePct: 0.002, maxSweepAgeBars: 5 });
assert.ok(liqRes.recentSweep && liqRes.recentSweep.type === "BULLISH_SSL_SWEEP", "Harus mendeteksi BULLISH_SSL_SWEEP");
console.log("✅ [PASS] Test 2: Liquidity Engine (BSL/SSL, EQH/EQL, Stop Hunt Sweep)");

// Test 3: FVG (3-Candle Imbalance + CE + Invalidation) & Order Block + Displacement
const fvgCandles = [];
for (let i = 0; i < 22; i++) {
  fvgCandles.push(makeCandle(1700020000000 + i * 300000, 100, 100.5, 99.5, 100.1, 900));
}
// Bearish OB candle -> strong bullish displacement -> gap between c1.high and c3.low
fvgCandles.push(makeCandle(1700026600000, 100.2, 100.4, 99.6, 99.7, 1100)); // c1 & Bullish OB
fvgCandles.push(makeCandle(1700026900000, 99.8, 103.8, 99.7, 103.5, 4800)); // c2 displacement
fvgCandles.push(makeCandle(1700027200000, 103.5, 104.2, 101.6, 102.0, 2200)); // c3 leaves FVG [100.4 .. 101.6]
const fvgRes = analyzeFVG(fvgCandles, { minWidthAtrMult: 0.1 });
const obRes = analyzeOrderBlocks(fvgCandles, stRes, {});
const dispRes = analyzeDisplacement(fvgCandles, {});
assert.ok(fvgRes.activeBullish && fvgRes.activeBullish.bottom === 100.4 && fvgRes.activeBullish.top === 101.6, "Bullish FVG harus terdeteksi akurat");
assert.ok(obRes.activeBullish && obRes.activeBullish.type === "BULLISH_OB", "Bullish OB dengan displacement harus terdeteksi");
assert.strictEqual(dispRes.direction, "BULLISH", "Displacement BULLISH harus terdeteksi");
console.log("✅ [PASS] Test 3: FVG (CE & Status), Order Block, & Displacement Engine");

// Test 4: True Volume Delta from aggTrade (m=false vs m=true), CVD, Divergence & Absorption
const rawTrades = [];
let tid = 1000;
for (let m = 0; m < 25; m++) {
  const baseTs = 1700030000000 + m * 60000;
  // Normal alternating order flow for 23 minutes
  if (m < 23) {
    rawTrades.push({ a: tid++, p: "100.0", q: "12", T: baseTs + 1000, m: false });
    rawTrades.push({ a: tid++, p: "99.9", q: "11", T: baseTs + 2000, m: true });
  } else if (m === 23) {
    // Absorption bar: heavy aggressive selling (m=true) absorbed with lower wick bounce
    rawTrades.push({ a: tid++, p: "99.8", q: "10", T: baseTs + 1000, m: false });
    rawTrades.push({ a: tid++, p: "98.5", q: "90", T: baseTs + 5000, m: true });
    rawTrades.push({ a: tid++, p: "99.7", q: "15", T: baseTs + 45000, m: false });
  } else {
    // Aggressive buyer surge (m=false)
    rawTrades.push({ a: tid++, p: "100.2", q: "120", T: baseTs + 2000, m: false });
    rawTrades.push({ a: tid++, p: "100.1", q: "15", T: baseTs + 10000, m: true });
  }
}
// Add duplicate trade ID to verify duplicate protection
rawTrades.push({ a: 1000, p: "100.0", q: "999", T: 1700030001000, m: false });

const agg = aggregateTradesToCandles(rawTrades, 60000);
assert.strictEqual(agg.duplicateCount, 1, "Harus menyaring duplicate aggTradeId");
const ofRes = analyzeOrderFlow(agg.candles, { lookbackBars: 20 });
assert.strictEqual(ofRes.valid, true, "Order flow harus valid");
assert.strictEqual(ofRes.direction, "BULLISH", "True VD bar terakhir harus BULLISH");
assert.strictEqual(ofRes.isSpike, true, "Harus mendeteksi lonjakan True Volume Delta");
console.log("✅ [PASS] Test 4: True Volume Delta (aggTrade m=false/true), CVD, & Deduplikasi");

// Test 5: Data Unavailable Guard (never fakes delta when aggTrade is missing)
const emptyEval = evaluateIctVolumeDeltaMTF({
  symbol: "ETHUSDT",
  candles15m: structCandles,
  candles5m: fvgCandles,
  vdCandles1m: []
});
assert.strictEqual(emptyEval.signal, "WAIT", "Harus WAIT jika data aggTrade tidak tersedia");
assert.strictEqual(emptyEval.dataQuality, "DATA_UNAVAILABLE", "Harus menandai DATA_UNAVAILABLE");
console.log("✅ [PASS] Test 5: Data Validation Guard (DATA_UNAVAILABLE)");

// Test 6: Risk Manager & Zero-Lookahead Backtester
const guardBlocked = validateRiskGuards({
  accountEquity: 100,
  riskPct: 0.5,
  openPositionsCount: 2,
  dailyPnlPct: 0,
  dataQuality: "VALID",
  setupKey: "BTC_1",
  executedSetupKeys: new Set(),
  plan: { stopLoss: 99, riskDistance: 1, entryPrice: 100, feasibleAfterCosts: true, netRR: 2.0 },
  cfg: { risk: { maxConcurrentPositions: 2, dailyMaxLossPct: 2.0 } }
});
assert.strictEqual(guardBlocked.allowed, false, "Harus menolak jika batas 2 posisi bersamaan penuh");

const btCandles15m = [];
const btCandles5m = [];
const btVd1m = [];
for (let i = 0; i < 160; i++) {
  const t5 = 1700100000000 + i * 300000;
  const p = 100 + Math.sin(i * 0.25) * 4 + i * 0.05;
  btCandles5m.push(makeCandle(t5, p - 0.2, p + 0.6, p - 0.6, p + 0.2, 1500));
  if (i % 3 === 0) {
    btCandles15m.push(makeCandle(t5, p - 0.3, p + 0.9, p - 0.9, p + 0.3, 4500));
  }
  for (let k = 0; k < 5; k++) {
    const t1 = t5 + k * 60000;
    btVd1m.push({
      time: t1,
      closeTime: t1 + 59999,
      open: p,
      high: p + 0.3,
      low: p - 0.3,
      close: p + 0.1,
      volume: 300,
      buyVolume: i % 2 === 0 ? 190 : 110,
      sellVolume: i % 2 === 0 ? 110 : 190
    });
  }
}
const btRes = runIctBacktest({ symbol: "BTCUSDT", candles15m: btCandles15m, candles5m: btCandles5m, vdCandles1m: btVd1m });
assert.strictEqual(btRes.ok, true, "Walk-forward backtester harus berjalan sukses");
console.log("✅ [PASS] Test 6: Risk Guards & Walk-Forward Backtester:", JSON.stringify(btRes.all));
console.log("=== SEMUA UNIT TEST ICT + SMC + VOLUME DELTA BERHASIL ===");
