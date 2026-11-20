(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarmonicSwingDetector = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function computeATR(candles, period = 14) {
    const atr = new Array(candles.length).fill(NaN);
    if (candles.length < period + 1) return atr;
    const trs = [0];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high;
      const l = candles[i].low;
      const pc = candles[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += trs[i];
    atr[period] = sum / period;
    for (let i = period + 1; i < candles.length; i++) {
      atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
    }
    return atr;
  }

  /**
   * Deteksi Fractal ZigZag non-repaint:
   * - Hanya memakai candle yang sudah CLOSED (bar terakhir yang belum close tidak dipakai sebagai konfirmasi fractal).
   * - Memfilter noise menggunakan deviasi % minimum dan kelipatan ATR.
   */
  function detectSwings(rawCandles, cfg) {
    if (!Array.isArray(rawCandles) || rawCandles.length < 30) return [];
    // Pastikan hanya memakai candle yang sudah closed
    const closedCandles = rawCandles.filter((c, idx) => c.closed !== false && idx < rawCandles.length);
    if (closedCandles.length < 30) return [];

    const depth = Math.max(2, Number(cfg.swingDepth) || 3);
    const minDevPct = Number(cfg.minDeviationPct) || 0.35;
    const minAtrMult = Number(cfg.minLegAtrMult) || 0.8;
    const atrArr = computeATR(closedCandles, Number(cfg.atrPeriod) || 14);

    const rawPivots = [];
    // Fractal membutuhkan 'depth' bar closed di kiri dan kanan -> non-repaint pada bar historis
    for (let i = depth; i < closedCandles.length - depth; i++) {
      const hi = closedCandles[i].high;
      const lo = closedCandles[i].low;
      let isHigh = true;
      let isLow = true;

      for (let j = i - depth; j <= i + depth; j++) {
        if (j === i) continue;
        if (closedCandles[j].high >= hi) isHigh = false;
        if (closedCandles[j].low <= lo) isLow = false;
      }

      if (isHigh) {
        rawPivots.push({ idx: i, time: closedCandles[i].time, price: hi, type: "H", atr: atrArr[i] || 0 });
      } else if (isLow) {
        rawPivots.push({ idx: i, time: closedCandles[i].time, price: lo, type: "L", atr: atrArr[i] || 0 });
      }
    }

    // ZigZag alternation + ATR / Deviation filter
    const swings = [];
    for (const p of rawPivots) {
      if (!swings.length) {
        swings.push(p);
        continue;
      }
      const last = swings[swings.length - 1];
      if (last.type === p.type) {
        if ((p.type === "H" && p.price > last.price) || (p.type === "L" && p.price < last.price)) {
          swings[swings.length - 1] = p;
        }
        continue;
      }
      const legMove = Math.abs(p.price - last.price);
      const devPct = (legMove / Math.max(1e-9, last.price)) * 100;
      const refAtr = p.atr || last.atr || 0;
      if (devPct >= minDevPct || (refAtr > 0 && legMove >= refAtr * minAtrMult)) {
        swings.push(p);
      }
    }
    return swings;
  }

  return { computeATR, detectSwings };
});
