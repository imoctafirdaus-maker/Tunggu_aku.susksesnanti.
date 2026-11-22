(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarmonicPrzValidator = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function inTolRange(val, range, tol) {
    if (!range) return true;
    const min = range[0] * (1 - tol);
    const max = range[1] * (1 + tol);
    return val >= min && val <= max;
  }

  function expandLevels(basePrice, dir, legSize, range) {
    if (!range || !Number.isFinite(legSize) || legSize <= 0) return [];
    if (Math.abs(range[0] - range[1]) < 1e-6) {
      return [basePrice + dir * legSize * range[0]];
    }
    const mid = (range[0] + range[1]) / 2;
    return [
      basePrice + dir * legSize * range[0],
      basePrice + dir * legSize * mid,
      basePrice + dir * legSize * range[1]
    ];
  }

  /**
   * Validasi PRZ (Potential Reversal Zone):
   * - Minimal 3 proyeksi Fibonacci bertemu (XA, BC, AB=CD, dan XC untuk Cypher)
   * - Lebar zona sempit berbasis ATR & %
   * - Guard beyond-X sesuai aturan pola Scott Carney
   */
  function validatePRZ({ isBullish, patternKey, patternCfg, X, A, B, C, D_price, currentPrice, atr, cfg }) {
    const dir = isBullish ? -1 : 1; // Bullish D berada di bawah A/C, Bearish D di atas A/C
    const XA = Math.abs(A.price - X.price);
    const AB = Math.abs(B.price - A.price);
    const BC = Math.abs(C.price - B.price);
    const XC = Math.abs(C.price - X.price);

    const projections = [];

    // 1. Proyeksi XA (atau XC untuk Cypher)
    if (patternCfg.dXa) {
      expandLevels(A.price, dir, XA, patternCfg.dXa).forEach(lvl => projections.push({ source: "XA", price: lvl }));
    }
    if (patternCfg.dXc) {
      expandLevels(C.price, dir, XC, patternCfg.dXc).forEach(lvl => projections.push({ source: "XC", price: lvl }));
    }

    // 2. Proyeksi BC
    if (patternCfg.dBc) {
      expandLevels(C.price, dir, BC, patternCfg.dBc).forEach(lvl => projections.push({ source: "BC", price: lvl }));
    }

    // 3. Proyeksi AB=CD (1.0 AB dan 1.272 AB dari titik C)
    projections.push({ source: "ABCD_1.0", price: C.price + dir * AB * 1.0 });
    projections.push({ source: "ABCD_1.272", price: C.price + dir * AB * 1.272 });

    // Cari klaster confluence terketat dengan minimal 3 proyeksi dari sumber berbeda
    const atrWidth = atr > 0 ? atr * (cfg.maxPrzWidthAtrMult || 1.35) : 0;
    const pctWidth = D_price * ((cfg.maxPrzWidthPct || 2.2) / 100);
    const maxWidth = Math.max(atrWidth, pctWidth);

    let bestCluster = null;
    for (let i = 0; i < projections.length; i++) {
      const anchor = projections[i].price;
      const members = projections.filter(p => Math.abs(p.price - anchor) <= maxWidth);
      const uniqueSources = new Set(members.map(m => m.source.split("_")[0]));
      const minConf = patternKey === "FIVE_O" ? 1 : (cfg.minPrzConfluence || 3);
      const minSrc = patternKey === "FIVE_O" ? 1 : 2;
      if (members.length >= minConf && uniqueSources.size >= minSrc) {
        const prices = members.map(m => m.price);
        const low = Math.min(...prices);
        const high = Math.max(...prices);
        const width = high - low;
        if (width <= maxWidth) {
          if (!bestCluster || members.length > bestCluster.count || (members.length === bestCluster.count && width < bestCluster.width)) {
            bestCluster = { low, high, mid: (low + high) / 2, width, count: members.length, sources: [...uniqueSources], members };
          }
        }
      }
    }

    if (!bestCluster) {
      return { valid: false, reason: "PRZ confluence < 3 proyeksi atau zona terlalu lebar" };
    }

    // Aturan Beyond-X: jika pola tidak boleh tembus X, tolak bila D atau harga menembus X
    if (!patternCfg.beyondX) {
      if (isBullish && (D_price < X.price || currentPrice < X.price)) {
        return { valid: false, reason: `${patternCfg.label} invalid: titik D menembus X` };
      }
      if (!isBullish && (D_price > X.price || currentPrice > X.price)) {
        return { valid: false, reason: `${patternCfg.label} invalid: titik D menembus X` };
      }
    }

    // Titik D harus masuk/menyentuh PRZ, dan harga penutupan belum memantul terlalu jauh meninggalkan PRZ
    const buffer = atr > 0 ? atr * 0.55 : bestCluster.mid * 0.005;
    const dInPrz = D_price >= (bestCluster.low - buffer) && D_price <= (bestCluster.high + buffer);
    const maxChase = atr > 0 ? atr * 2.2 : bestCluster.mid * 0.018;
    const notChased = isBullish
      ? (currentPrice >= bestCluster.low - buffer && currentPrice <= bestCluster.high + maxChase)
      : (currentPrice <= bestCluster.high + buffer && currentPrice >= bestCluster.low - maxChase);
    if (!dInPrz || !notChased) {
      return {
        valid: false,
        reason: !dInPrz ? "Titik D belum masuk zona PRZ" : "Harga sudah memantul jauh dari PRZ",
        prz: bestCluster
      };
    }

    // Skor kualitas PRZ (0-100)
    const confluenceScore = Math.min(45, bestCluster.count * 12);
    const tightnessRatio = maxWidth > 0 ? Math.max(0, 1 - bestCluster.width / maxWidth) : 0.5;
    const tightnessScore = Math.round(tightnessRatio * 35);
    const proximityRatio = Math.max(0, 1 - Math.abs(currentPrice - bestCluster.mid) / Math.max(1e-9, bestCluster.width + buffer));
    const proximityScore = Math.round(proximityRatio * 20);
    const score = Math.min(100, confluenceScore + tightnessScore + proximityScore);

    if (score < (cfg.minPrzScore || 60)) {
      return { valid: false, reason: `Skor PRZ (${score}) di bawah minimum (${cfg.minPrzScore})`, score, prz: bestCluster };
    }

    return {
      valid: true,
      score,
      count: bestCluster.count,
      prz: bestCluster,
      reason: `PRZ valid (${bestCluster.count} confluence, skor ${score}/100)`
    };
  }

  return { inTolRange, validatePRZ };
});
