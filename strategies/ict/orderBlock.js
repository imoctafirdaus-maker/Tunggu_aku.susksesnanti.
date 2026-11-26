"use strict";

const { computeATR } = require("./structure");

function analyzeOrderBlocks(candles, structure, opts = {}) {
  const maxActiveZones = opts.maxActiveZones ?? 6;
  const n = candles.length;

  if (n < 22) {
    return { valid: false, bullish: [], bearish: [], activeBullish: null, activeBearish: null };
  }

  const atr = computeATR(candles, 14);
  const obs = [];

  for (let i = 20; i < n - 1; i++) {
    const obBar = candles[i];
    const impBar = candles[i + 1];
    const atrVal = Number.isFinite(atr[i + 1]) ? atr[i + 1] : 0;
    if (atrVal <= 0) continue;

    const impBody = Math.abs(impBar.close - impBar.open);
    const impRange = Math.max(impBar.high - impBar.low, 1e-9);
    const isDisplacement = impBody >= atrVal * 1.15 && (impBody / impRange) >= 0.62;
    if (!isDisplacement) continue;

    // Bullish OB: last bearish candle before bullish displacement
    if (obBar.close < obBar.open && impBar.close > impBar.open && impBar.close > obBar.high) {
      const causedShift = Boolean(
        (structure?.bos && structure.bos.type === "BULLISH_BOS" && Math.abs(structure.bos.breakIndex - (i + 1)) <= 3) ||
        (structure?.mss && structure.mss.type === "BULLISH_MSS" && Math.abs(structure.mss.breakIndex - (i + 1)) <= 3) ||
        (structure?.choch && structure.choch.type === "BULLISH_CHOCH" && Math.abs(structure.choch.breakIndex - (i + 1)) <= 3)
      );
      obs.push({
        type: "BULLISH_OB",
        side: "BUY",
        top: obBar.high,
        bottom: obBar.low,
        meanThreshold: (obBar.high + obBar.low) / 2,
        obIndex: i,
        impulseIndex: i + 1,
        timestamp: obBar.time,
        causedStructureShift: causedShift,
        status: "VALID",
        retested: false,
        invalidated: false
      });
    }

    // Bearish OB: last bullish candle before bearish displacement
    if (obBar.close > obBar.open && impBar.close < impBar.open && impBar.close < obBar.low) {
      const causedShift = Boolean(
        (structure?.bos && structure.bos.type === "BEARISH_BOS" && Math.abs(structure.bos.breakIndex - (i + 1)) <= 3) ||
        (structure?.mss && structure.mss.type === "BEARISH_MSS" && Math.abs(structure.mss.breakIndex - (i + 1)) <= 3) ||
        (structure?.choch && structure.choch.type === "BEARISH_CHOCH" && Math.abs(structure.choch.breakIndex - (i + 1)) <= 3)
      );
      obs.push({
        type: "BEARISH_OB",
        side: "SELL",
        top: obBar.high,
        bottom: obBar.low,
        meanThreshold: (obBar.high + obBar.low) / 2,
        obIndex: i,
        impulseIndex: i + 1,
        timestamp: obBar.time,
        causedStructureShift: causedShift,
        status: "VALID",
        retested: false,
        invalidated: false
      });
    }
  }

  for (const ob of obs) {
    for (let j = ob.impulseIndex + 1; j < n; j++) {
      const bar = candles[j];
      if (ob.side === "BUY") {
        if (bar.close < ob.bottom) {
          ob.status = "INVALIDATED";
          ob.invalidated = true;
          ob.invalidatedAtIndex = j;
          break;
        }
        if (bar.low <= ob.top) {
          ob.retested = true;
          ob.status = "MITIGATED";
        }
      } else {
        if (bar.close > ob.top) {
          ob.status = "INVALIDATED";
          ob.invalidated = true;
          ob.invalidatedAtIndex = j;
          break;
        }
        if (bar.high >= ob.bottom) {
          ob.retested = true;
          ob.status = "MITIGATED";
        }
      }
    }
  }

  const lastBar = candles[n - 1];
  const validBull = obs.filter(o => o.side === "BUY" && !o.invalidated).slice(-maxActiveZones);
  const validBear = obs.filter(o => o.side === "SELL" && !o.invalidated).slice(-maxActiveZones);

  const pickBest = (list, isBuy) => {
    const inside = list.filter(o => isBuy
      ? (lastBar.low <= o.top && lastBar.close >= o.bottom)
      : (lastBar.high >= o.bottom && lastBar.close <= o.top));
    const pool = inside.length ? inside : list;
    if (!pool.length) return null;
    return [...pool].sort((a, b) => (Number(b.causedStructureShift) - Number(a.causedStructureShift)) || (b.obIndex - a.obIndex))[0];
  };

  const activeBullish = pickBest(validBull, true);
  const activeBearish = pickBest(validBear, false);

  return {
    valid: true,
    allOrderBlocks: obs,
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

module.exports = { analyzeOrderBlocks };
