"use strict";

const { computeATR } = require("./structure");

function analyzeFVG(candles, opts = {}) {
  const minWidthAtrMult = opts.minWidthAtrMult ?? 0.12;
  const maxActiveZones = opts.maxActiveZones ?? 6;
  const n = candles.length;

  if (n < 10) {
    return { valid: false, bullish: [], bearish: [], activeBullish: null, activeBearish: null };
  }

  const atr = computeATR(candles, 14);
  const zones = [];

  for (let i = 2; i < n; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];
    const atrVal = Number.isFinite(atr[i]) ? atr[i] : 0;
    const c2Body = Math.abs(c2.close - c2.open);
    const c2Range = Math.max(c2.high - c2.low, 1e-9);
    const hasDisplacement = atrVal > 0 && c2Body >= atrVal * 1.1 && (c2Body / c2Range) >= 0.6;

    // Bullish FVG: c1.high < c3.low
    if (c1.high < c3.low) {
      const bottom = c1.high;
      const top = c3.low;
      const width = top - bottom;
      if (width >= atrVal * minWidthAtrMult) {
        zones.push({
          type: "BULLISH_FVG",
          side: "BUY",
          top,
          bottom,
          ce: (top + bottom) / 2,
          width,
          formedAtIndex: i,
          timestamp: c3.time,
          hasDisplacement,
          status: "UNTOUCHED",
          touched: false,
          filled: false,
          invalidated: false
        });
      }
    }

    // Bearish FVG: c1.low > c3.high
    if (c1.low > c3.high) {
      const top = c1.low;
      const bottom = c3.high;
      const width = top - bottom;
      if (width >= atrVal * minWidthAtrMult) {
        zones.push({
          type: "BEARISH_FVG",
          side: "SELL",
          top,
          bottom,
          ce: (top + bottom) / 2,
          width,
          formedAtIndex: i,
          timestamp: c3.time,
          hasDisplacement,
          status: "UNTOUCHED",
          touched: false,
          filled: false,
          invalidated: false
        });
      }
    }
  }

  for (const z of zones) {
    for (let j = z.formedAtIndex + 1; j < n; j++) {
      const bar = candles[j];
      if (z.side === "BUY") {
        if (bar.close < z.bottom) {
          z.status = "INVALIDATED";
          z.invalidated = true;
          break;
        }
        if (bar.low <= z.top) {
          z.touched = true;
          if (bar.low <= z.ce) {
            z.filled = true;
            z.status = "FILLED";
          } else if (z.status === "UNTOUCHED") {
            z.status = "TOUCHED";
          }
        }
      } else {
        if (bar.close > z.top) {
          z.status = "INVALIDATED";
          z.invalidated = true;
          break;
        }
        if (bar.high >= z.bottom) {
          z.touched = true;
          if (bar.high >= z.ce) {
            z.filled = true;
            z.status = "FILLED";
          } else if (z.status === "UNTOUCHED") {
            z.status = "TOUCHED";
          }
        }
      }
    }
  }

  const lastBar = candles[n - 1];
  const validBull = zones.filter(z => z.side === "BUY" && !z.invalidated).slice(-maxActiveZones);
  const validBear = zones.filter(z => z.side === "SELL" && !z.invalidated).slice(-maxActiveZones);

  const pickBest = (list, isBuy) => {
    const inZone = list.filter(z => isBuy
      ? (lastBar.low <= z.top && lastBar.close >= z.bottom)
      : (lastBar.high >= z.bottom && lastBar.close <= z.top));
    const pool = inZone.length ? inZone : list;
    if (!pool.length) return null;
    return [...pool].sort((a, b) => (Number(b.hasDisplacement) - Number(a.hasDisplacement)) || (b.formedAtIndex - a.formedAtIndex))[0];
  };

  const activeBullish = pickBest(validBull, true);
  const activeBearish = pickBest(validBear, false);

  return {
    valid: true,
    bullish: validBull,
    bearish: validBear,
    activeBullish: activeBullish ? {
      ...activeBullish,
      priceInside: lastBar.low <= activeBullish.top && lastBar.close >= activeBullish.bottom
    } : null,
    activeBearish: activeBearish ? {
      ...activeBearish,
      priceInside: lastBar.high >= activeBearish.bottom && lastBar.close <= activeBearish.top
    } : null
  };
}

module.exports = { analyzeFVG };
