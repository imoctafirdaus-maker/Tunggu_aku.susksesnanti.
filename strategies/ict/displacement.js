"use strict";

const { computeATR } = require("./structure");

function analyzeDisplacement(candles, opts = {}) {
  const minBodyToRange = opts.minBodyToRange ?? 0.62;
  const minBodyToAvgMult = opts.minBodyToAvgMult ?? 1.75;
  const minAtrMult = opts.minAtrMult ?? 1.15;
  const n = candles.length;

  if (n < 22) {
    return { valid: false, detected: false, direction: "NEUTRAL", recent: null };
  }

  const atr = computeATR(candles, 14);
  let recent = null;

  for (let i = Math.max(20, n - 8); i < n; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    if (range <= 0 || body <= 0) continue;

    let sumBody = 0;
    for (let j = i - 20; j < i; j++) {
      sumBody += Math.abs(candles[j].close - candles[j].open);
    }
    const avgBody = sumBody / 20;
    const bodyToRange = body / range;
    const bodyToAvg = avgBody > 0 ? body / avgBody : 0;
    const atrVal = Number.isFinite(atr[i]) && atr[i] > 0 ? atr[i] : range;
    const bodyToAtr = body / atrVal;
    const velocityPct = ((c.close - c.open) / Math.max(c.open, 1e-9)) * 100;

    // Check if an FVG formed across i-2, i-1, i
    const hasBullFvg = i >= 2 && candles[i - 2].high < c.low;
    const hasBearFvg = i >= 2 && candles[i - 2].low > c.high;

    if (bodyToRange >= minBodyToRange && bodyToAvg >= minBodyToAvgMult && bodyToAtr >= minAtrMult) {
      const dir = c.close > c.open ? "BULLISH" : "BEARISH";
      recent = {
        detected: true,
        direction: dir,
        barIndex: i,
        barsAgo: n - 1 - i,
        timestamp: c.time,
        body,
        range,
        bodyToRange: Number(bodyToRange.toFixed(2)),
        bodyToAvg: Number(bodyToAvg.toFixed(2)),
        bodyToAtr: Number(bodyToAtr.toFixed(2)),
        velocityPct: Number(velocityPct.toFixed(3)),
        createdFvg: dir === "BULLISH" ? hasBullFvg : hasBearFvg
      };
    }
  }

  return {
    valid: true,
    detected: Boolean(recent),
    direction: recent ? recent.direction : "NEUTRAL",
    recent
  };
}

module.exports = { analyzeDisplacement };
