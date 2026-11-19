(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarmonicRsiConfirmation = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function computeRsiSeries(closes, period = 14) {
    const out = new Array(closes.length).fill(NaN);
    if (closes.length < period + 1) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      gain += Math.max(diff, 0);
      loss += Math.max(-diff, 0);
    }
    gain /= period;
    loss /= period;
    out[period] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
      out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  /**
   * Deteksi candle reversal close di PRZ (Bullish Engulfing / Hammer / Strong Green Close; Bearish Shooting Star / Engulfing / Red Close)
   */
  function hasReversalCandle(candles, idx, isBullish) {
    const c = candles[idx];
    const prev = candles[idx - 1];
    if (!c || !prev) return false;
    const body = Math.abs(c.close - c.open);
    const range = Math.max(1e-9, c.high - c.low);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);

    if (isBullish) {
      const bullishClose = c.close > c.open && body / range >= 0.35;
      const pinBar = lowerWick >= body * 1.4 && c.close >= c.open;
      const engulf = c.close > prev.open && c.open <= prev.close && c.close > c.open;
      return bullishClose || pinBar || engulf;
    } else {
      const bearishClose = c.close < c.open && body / range >= 0.35;
      const shootingStar = upperWick >= body * 1.4 && c.close <= c.open;
      const engulf = c.close < prev.open && c.open >= prev.close && c.close < c.open;
      return bearishClose || shootingStar || engulf;
    }
  }

  /**
   * Konfirmasi RSI:
   * - Level: RSI <= rsiOversold (Bullish) atau >= rsiOverbought (Bearish)
   * - Divergence: Harga LL tapi RSI HL (Bullish), atau Harga HH tapi RSI LH (Bearish) antara C/A dan D
   */
  function evaluateRsiAndCandle({ candles, rsiArr, isBullish, refPivot, dIdx, cfg }) {
    const curRsi = rsiArr[dIdx];
    if (!Number.isFinite(curRsi)) {
      return { valid: false, reason: "Data RSI belum mencukupi" };
    }

    const levelOk = isBullish ? curRsi <= (cfg.rsiOversold || 35) : curRsi >= (cfg.rsiOverbought || 65);

    // Cek divergence antara pivot pembanding (C atau A) dengan titik D
    let divergenceOk = false;
    if (refPivot && Number.isFinite(rsiArr[refPivot.idx])) {
      const refRsi = rsiArr[refPivot.idx];
      const dPrice = isBullish ? candles[dIdx].low : candles[dIdx].high;
      if (isBullish) {
        // Bullish divergence: harga membuat Lower Low, RSI membuat Higher Low
        divergenceOk = dPrice < refPivot.price && curRsi > refRsi + 1.5;
      } else {
        // Bearish divergence: harga membuat Higher High, RSI membuat Lower High
        divergenceOk = dPrice > refPivot.price && curRsi < refRsi - 1.5;
      }
    }

    const mode = cfg.rsiMode || "both";
    const rsiConfirmed = mode === "level" ? levelOk : mode === "divergence" ? divergenceOk : (levelOk || divergenceOk);

    if (!rsiConfirmed) {
      return {
        valid: false,
        curRsi,
        levelOk,
        divergenceOk,
        reason: `RSI (${curRsi.toFixed(1)}) belum konfirmasi (${mode})`
      };
    }

    if (cfg.requireReversalCandle !== false && !hasReversalCandle(candles, dIdx, isBullish)) {
      return {
        valid: false,
        curRsi,
        levelOk,
        divergenceOk,
        reason: "Menunggu candle reversal close di zona PRZ"
      };
    }

    return {
      valid: true,
      curRsi,
      levelOk,
      divergenceOk,
      reason: `RSI OK (${curRsi.toFixed(1)}${divergenceOk ? " + Divergence" : ""}) & Candle Reversal Close`
    };
  }

  return { computeRsiSeries, hasReversalCandle, evaluateRsiAndCandle };
});
