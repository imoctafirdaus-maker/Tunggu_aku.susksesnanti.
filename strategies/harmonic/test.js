"use strict";
const assert = require("assert");
const ConfigMod = require("./config");
const SwingMod = require("./swingDetector");
const PrzMod = require("./przValidator");
const RsiMod = require("./rsiConfirmation");
const EngineMod = require("./engine");
const BacktesterMod = require("./backtester");

console.log("=== MENJALANKAN UNIT TEST MODUL HARMONIC PATTERN ===");

// 1. Test Rasio Toleransi ±3%
assert.strictEqual(PrzMod.inTolRange(0.618, [0.618, 0.618], 0.03), true, "Gartley B=0.618 harus valid");
assert.strictEqual(PrzMod.inTolRange(0.635, [0.618, 0.618], 0.03), true, "Gartley B=0.635 (+2.75%) harus valid");
assert.strictEqual(PrzMod.inTolRange(0.660, [0.618, 0.618], 0.03), false, "Gartley B=0.660 (+6.8%) harus ditolak");
console.log("✅ [PASS] Test 1: Validasi Rasio Scott Carney & Toleransi ±3%");

// 2. Test PRZ Confluence (>=3 proyeksi) & Guard Beyond-X
const cfg = ConfigMod.mergeSettings({ minPrzScore: 50 });
const przValid = PrzMod.validatePRZ({
  isBullish: true,
  patternKey: "GARTLEY",
  patternCfg: cfg.patterns.GARTLEY,
  X: { price: 100 },
  A: { price: 200 },
  B: { price: 138.2 }, // 0.618 XA
  C: { price: 186.8 }, // 0.786 AB
  D_price: 121.4,      // 0.786 XA = 121.4, 1.272 BC = 124.9, AB=CD = 125.0
  currentPrice: 122.0,
  atr: 3.0,
  cfg
});
assert.strictEqual(przValid.valid, true, "PRZ Gartley Bullish valid harus lolos: " + przValid.reason);
assert.ok(przValid.score >= 50, "Skor PRZ harus >= 50");

const przInvalidBeyondX = PrzMod.validatePRZ({
  isBullish: true,
  patternKey: "GARTLEY",
  patternCfg: cfg.patterns.GARTLEY,
  X: { price: 100 },
  A: { price: 200 },
  B: { price: 138.2 },
  C: { price: 186.8 },
  D_price: 98.0, // Tembus X = 100!
  currentPrice: 98.0,
  atr: 3.0,
  cfg
});
assert.strictEqual(przInvalidBeyondX.valid, false, "Gartley menembus X wajib ditolak");
console.log("✅ [PASS] Test 2: Validasi PRZ Confluence & Beyond-X Guard");

// 3. Test RSI Level & Bullish Divergence
const closes = [50,49,48,47,46,45,44,43,42,41,40,39,38,37,36, 38, 41, 35, 34, 33, 35];
const candlesDiv = closes.map((cl, idx) => ({
  time: 1700000000 + idx * 3600,
  open: idx === closes.length - 1 ? 33.2 : cl + 0.5,
  high: cl + 1.0,
  low: idx === 14 ? 35.0 : (idx === closes.length - 1 ? 32.5 : cl - 0.8),
  close: cl,
  closed: true
}));
const rsiSeries = RsiMod.computeRsiSeries(closes, 14);
const rsiCheck = RsiMod.evaluateRsiAndCandle({
  candles: candlesDiv,
  rsiArr: rsiSeries,
  isBullish: true,
  refPivot: { idx: 14, price: 35.0 },
  dIdx: candlesDiv.length - 1,
  cfg: ConfigMod.mergeSettings({ rsiMode: "both", rsiOversold: 40 })
});
assert.strictEqual(rsiCheck.valid, true, "RSI Bullish + Candle Reversal harus valid: " + rsiCheck.reason);
console.log("✅ [PASS] Test 3: Konfirmasi RSI Level/Divergence & Reversal Candle");

// 4. Test No-Repaint Swing Detector & Backtester Walk-Forward
const synthetic = [];
let price = 100;
for (let i = 0; i < 140; i++) {
  const wave = Math.sin(i / 6) * 8 + Math.cos(i / 13) * 4;
  const open = price;
  const close = 100 + wave;
  const high = Math.max(open, close) + 1.2;
  const low = Math.min(open, close) - 1.2;
  synthetic.push({ time: 1700000000 + i * 3600, open, high, low, close, closed: true });
  price = close;
}
const swings100 = SwingMod.detectSwings(synthetic.slice(0, 100), cfg);
const swings110 = SwingMod.detectSwings(synthetic.slice(0, 110), cfg);
if (swings100.length >= 2 && swings110.length >= 2) {
  assert.strictEqual(swings100[0].time, swings110[0].time, "Swing historis tidak boleh repaint saat bar baru masuk");
}
const bt = BacktesterMod.runBacktest(synthetic, "1h", cfg, 1000);
assert.ok(typeof bt.winRate === "number" && typeof bt.profitFactor === "number", "Backtester harus mengembalikan metrik lengkap");
console.log("✅ [PASS] Test 4: Non-Repaint Swing & Walk-Forward Backtester:", JSON.stringify({
  totalPatterns: bt.totalPatterns,
  winRate: bt.winRate + "%",
  profitFactor: bt.profitFactor,
  maxDrawdownPct: bt.maxDrawdownPct + "%"
}));
// 5. Test Proyeksi PRZ Titik D (Anticipatory Limit Order) & Guard Beyond-X
const projGartley = PrzMod.projectPRZ({
  isBullish: true,
  patternKey: "GARTLEY",
  patternCfg: cfg.patterns.GARTLEY,
  X: { price: 100 },
  A: { price: 200 },
  B: { price: 138.2 }, // 0.618 XA
  C: { price: 186.8 }, // 0.786 AB
  currentPrice: 130.0,
  atr: 3.0,
  cfg
});
assert.strictEqual(projGartley.valid, true, "Proyeksi PRZ Gartley Bullish harus valid: " + projGartley.reason);
assert.ok(projGartley.targetD > 100 && projGartley.targetD < 138.2, "Target Limit D Gartley harus berada di antara X dan B");

const projInvalidBeyondX = PrzMod.projectPRZ({
  isBullish: true,
  patternKey: "BAT",
  patternCfg: cfg.patterns.BAT,
  X: { price: 100 },
  A: { price: 200 },
  B: { price: 150 },   // 0.50 XA
  C: { price: 194.3 }, // 0.886 AB -> proyeksi 2.618 BC tembus di bawah X=100
  currentPrice: 120.0,
  atr: 3.0,
  cfg: ConfigMod.mergeSettings({ minPrzScore: 40, maxPrzWidthAtrMult: 5.0, maxPrzWidthPct: 5.0 })
});
if (projInvalidBeyondX.valid) {
  assert.ok(projInvalidBeyondX.targetD > 100, "Target D Bat tidak boleh menembus X");
}
console.log("✅ [PASS] Test 5: Proyeksi Limit Order PRZ D & Guard Beyond-X:", JSON.stringify({
  targetD: Number(projGartley.targetD.toFixed(2)),
  score: projGartley.score,
  confluence: projGartley.count
}));

console.log("=== SEMUA UNIT TEST BERHASIL ===");
