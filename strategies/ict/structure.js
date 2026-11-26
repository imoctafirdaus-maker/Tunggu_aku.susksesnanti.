"use strict";

function computeATR(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/**
 * Non-repainting fractal swing detector.
 * Pivot at index `p` is ONLY confirmed once candle `p + rightBars` has closed.
 */
function detectConfirmedSwings(candles, leftBars = 3, rightBars = 2) {
  const swingHighs = [];
  const swingLows = [];
  const n = candles.length;

  for (let p = leftBars; p <= n - 1 - rightBars; p++) {
    const c = candles[p];
    let isHigh = true;
    let isLow = true;

    for (let j = p - leftBars; j <= p + rightBars; j++) {
      if (j === p) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    const confirmedAt = p + rightBars;
    if (isHigh) {
      swingHighs.push({
        type: "HIGH",
        index: p,
        confirmedAt,
        price: c.high,
        time: c.time,
        confirmedTime: candles[confirmedAt].time,
        label: null
      });
    }
    if (isLow) {
      swingLows.push({
        type: "LOW",
        index: p,
        confirmedAt,
        price: c.low,
        time: c.time,
        confirmedTime: candles[confirmedAt].time,
        label: null
      });
    }
  }

  for (let i = 0; i < swingHighs.length; i++) {
    if (i === 0) swingHighs[i].label = "SH";
    else swingHighs[i].label = swingHighs[i].price > swingHighs[i - 1].price ? "HH" : "LH";
  }
  for (let i = 0; i < swingLows.length; i++) {
    if (i === 0) swingLows[i].label = "SL";
    else swingLows[i].label = swingLows[i].price > swingLows[i - 1].price ? "HL" : "LL";
  }

  return { swingHighs, swingLows };
}

function analyzeMarketStructure(candles, opts = {}) {
  const leftBars = opts.leftBars ?? 3;
  const rightBars = opts.rightBars ?? 2;
  const n = Array.isArray(candles) ? candles.length : 0;

  if (n < leftBars + rightBars + 5) {
    return {
      valid: false,
      direction: "RANGING",
      previousStructure: "RANGING",
      lastStructureLabel: "INSUFFICIENT",
      swingHigh: null,
      swingLow: null,
      swingHighs: [],
      swingLows: [],
      bos: null,
      choch: null,
      mss: null,
      timestamp: n > 0 ? candles[n - 1].time : 0
    };
  }

  const atr = computeATR(candles, 14);
  const { swingHighs, swingLows } = detectConfirmedSwings(candles, leftBars, rightBars);

  let direction = "RANGING";
  let previousStructure = "RANGING";
  let lastBos = null;
  let lastChoch = null;
  let lastMss = null;

  let trackedHigh = null;
  let trackedLow = null;
  let brokenHighIdx = -1;
  let brokenLowIdx = -1;

  for (let i = 0; i < n; i++) {
    const bar = candles[i];
    const barAtr = Number.isFinite(atr[i]) ? atr[i] : Math.abs(bar.high - bar.low);
    const body = Math.abs(bar.close - bar.open);
    const isDisplacementBar = barAtr > 0 && body >= barAtr * 1.15;

    for (const sh of swingHighs) {
      if (sh.confirmedAt === i) trackedHigh = sh;
    }
    for (const sl of swingLows) {
      if (sl.confirmedAt === i) trackedLow = sl;
    }

    // Candle close confirmation prevents wick-only false breakouts
    if (trackedHigh && trackedHigh.index !== brokenHighIdx && i > trackedHigh.index && bar.close > trackedHigh.price) {
      brokenHighIdx = trackedHigh.index;
      previousStructure = direction;
      if (direction === "BEARISH") {
        lastChoch = {
          type: "BULLISH_CHOCH",
          level: trackedHigh.price,
          swingIndex: trackedHigh.index,
          breakIndex: i,
          timestamp: bar.time,
          confirmedByClose: true
        };
        if (isDisplacementBar) {
          lastMss = { ...lastChoch, type: "BULLISH_MSS" };
        }
      } else {
        lastBos = {
          type: "BULLISH_BOS",
          level: trackedHigh.price,
          swingIndex: trackedHigh.index,
          breakIndex: i,
          timestamp: bar.time,
          confirmedByClose: true
        };
      }
      direction = "BULLISH";
    }

    if (trackedLow && trackedLow.index !== brokenLowIdx && i > trackedLow.index && bar.close < trackedLow.price) {
      brokenLowIdx = trackedLow.index;
      previousStructure = direction;
      if (direction === "BULLISH") {
        lastChoch = {
          type: "BEARISH_CHOCH",
          level: trackedLow.price,
          swingIndex: trackedLow.index,
          breakIndex: i,
          timestamp: bar.time,
          confirmedByClose: true
        };
        if (isDisplacementBar) {
          lastMss = { ...lastChoch, type: "BEARISH_MSS" };
        }
      } else {
        lastBos = {
          type: "BEARISH_BOS",
          level: trackedLow.price,
          swingIndex: trackedLow.index,
          breakIndex: i,
          timestamp: bar.time,
          confirmedByClose: true
        };
      }
      direction = "BEARISH";
    }
  }

  const lastHigh = swingHighs.length ? swingHighs[swingHighs.length - 1] : null;
  const lastLow = swingLows.length ? swingLows[swingLows.length - 1] : null;
  const lastEvent = [lastBos, lastChoch, lastMss]
    .filter(Boolean)
    .sort((a, b) => b.breakIndex - a.breakIndex)[0] || null;

  return {
    valid: Boolean(lastHigh && lastLow),
    direction,
    previousStructure,
    lastStructureLabel: `${lastHigh ? lastHigh.label : "NONE"}/${lastLow ? lastLow.label : "NONE"}`,
    swingHigh: lastHigh,
    swingLow: lastLow,
    swingHighs,
    swingLows,
    bos: lastBos,
    choch: lastChoch,
    mss: lastMss,
    lastEvent,
    timestamp: lastEvent ? lastEvent.timestamp : candles[n - 1].time
  };
}

module.exports = { computeATR, detectConfirmedSwings, analyzeMarketStructure };
