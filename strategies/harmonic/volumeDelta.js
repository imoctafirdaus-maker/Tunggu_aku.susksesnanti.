(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarmonicVolumeDelta = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function computeCandleVD(candle) {
    if (!candle || typeof candle !== "object") {
      return { valid: false, vd: 0, absVd: 0, totalVol: 0, takerBuy: 0, buyPct: 50 };
    }
    const totalVol = Number(candle.volume || 0);
    const rawBuy = candle.takerBuyBase != null ? candle.takerBuyBase : candle.takerBuyVolume;
    const takerBuy = Number(rawBuy);
    if (!Number.isFinite(totalVol) || totalVol <= 0 || !Number.isFinite(takerBuy) || takerBuy < 0) {
      return { valid: false, vd: 0, absVd: 0, totalVol: Math.max(0, totalVol || 0), takerBuy: 0, buyPct: 50 };
    }
    const clampedBuy = Math.min(totalVol, takerBuy);
    const vd = (2 * clampedBuy) - totalVol;
    const buyPct = (clampedBuy / totalVol) * 100;
    return {
      valid: true,
      vd,
      absVd: Math.abs(vd),
      totalVol,
      takerBuy: clampedBuy,
      buyPct
    };
  }

  function analyzeSeriesVD(candles, opts = {}) {
    const lookback = Math.max(5, Number(opts.lookback) || 20);
    const recentBars = Math.max(1, Number(opts.recentBars) || 2);
    const strongMult = Number(opts.strongMult) || 2.0;
    const exhaustionMult = Number(opts.exhaustionMult) || 2.2;

    if (!Array.isArray(candles) || candles.length < lookback + recentBars) {
      return {
        valid: false,
        isStrong: false,
        isCounterExhaustion: false,
        direction: "NEUTRAL",
        vd: 0,
        vdRatio: 0,
        buyPct: 50,
        reason: "Data candle VD belum mencukupi"
      };
    }

    const parsed = candles.map(computeCandleVD);
    const recentSlice = parsed.slice(-recentBars);
    const validRecent = recentSlice.filter(x => x.valid);
    if (validRecent.length === 0) {
      return {
        valid: false,
        isStrong: false,
        isCounterExhaustion: false,
        direction: "NEUTRAL",
        vd: 0,
        vdRatio: 0,
        buyPct: 50,
        reason: "Data Taker Buy Volume tidak tersedia"
      };
    }

    const baseSlice = parsed.slice(-(lookback + recentBars), -recentBars).filter(x => x.valid);
    if (baseSlice.length < 5) {
      return {
        valid: false,
        isStrong: false,
        isCounterExhaustion: false,
        direction: "NEUTRAL",
        vd: 0,
        vdRatio: 0,
        buyPct: 50,
        reason: "Baseline historis VD kurang"
      };
    }

    const avgAbsVd = baseSlice.reduce((acc, x) => acc + x.absVd, 0) / baseSlice.length;
    const avgVol = baseSlice.reduce((acc, x) => acc + x.totalVol, 0) / baseSlice.length;
    const baseline = Math.max(avgAbsVd, avgVol * 0.18, 1e-9);

    let peak = validRecent[0];
    for (const item of validRecent) {
      if (item.absVd > peak.absVd) peak = item;
    }

    const vdRatio = peak.absVd / baseline;
    const direction = peak.vd > 0 ? "BUY" : (peak.vd < 0 ? "SELL" : "NEUTRAL");
    const decisiveFlow = direction === "BUY" ? peak.buyPct >= 62 : (direction === "SELL" ? peak.buyPct <= 38 : false);
    const isStrong = Boolean(direction !== "NEUTRAL" && vdRatio >= strongMult && decisiveFlow);

    const exhaustedFlow = direction === "BUY" ? peak.buyPct <= 36 : (direction === "SELL" ? peak.buyPct >= 64 : false);
    const isCounterExhaustion = Boolean(direction !== "NEUTRAL" && vdRatio >= exhaustionMult && exhaustedFlow);

    return {
      valid: true,
      isStrong,
      isCounterExhaustion,
      direction,
      vd: peak.vd,
      vdRatio: Number(vdRatio.toFixed(2)),
      buyPct: Number(peak.buyPct.toFixed(1)),
      reason: isStrong
        ? `VD Kuat ${direction} (${vdRatio.toFixed(2)}x avg · Buy ${peak.buyPct.toFixed(1)}%)`
        : `VD Normal (${vdRatio.toFixed(2)}x avg · Buy ${peak.buyPct.toFixed(1)}%)`
    };
  }

  function computeTrendFibExtensions({ isBullish, entry, X, A, C, stdTp1, stdTp2, extTp1Fib = 1.272, extTp2Fib = 1.618 }) {
    const dir = isBullish ? 1 : -1;
    const xaLeg = (X && A && Number.isFinite(X.price) && Number.isFinite(A.price)) ? Math.abs(A.price - X.price) : 0;
    const cdLeg = (C && Number.isFinite(C.price) && Number.isFinite(entry)) ? Math.abs(C.price - entry) : 0;
    const trendLeg = xaLeg > 0 ? xaLeg : cdLeg;

    let extTp1 = entry + dir * trendLeg * extTp1Fib;
    let extTp2 = entry + dir * trendLeg * extTp2Fib;

    // Pastikan target Fib Extension selalu lebih panjang dari target Harmonic standar
    if (isBullish) {
      if (Number.isFinite(stdTp2) && extTp1 <= stdTp2) {
        const step = Math.max(stdTp2 - (stdTp1 || entry), trendLeg * 0.382);
        extTp1 = stdTp2 + step;
      }
      if (extTp2 <= extTp1) {
        extTp2 = extTp1 + Math.max(trendLeg * 0.346, (extTp1 - entry) * 0.272);
      }
    } else {
      if (Number.isFinite(stdTp2) && extTp1 >= stdTp2) {
        const step = Math.max((stdTp1 || entry) - stdTp2, trendLeg * 0.382);
        extTp1 = stdTp2 - step;
      }
      if (extTp2 >= extTp1) {
        extTp2 = extTp1 - Math.max(trendLeg * 0.346, (entry - extTp1) * 0.272);
      }
    }

    return {
      trendLeg,
      extTp1Fib,
      extTp2Fib,
      extTp1,
      extTp2
    };
  }

  return {
    computeCandleVD,
    analyzeSeriesVD,
    computeTrendFibExtensions
  };
});
