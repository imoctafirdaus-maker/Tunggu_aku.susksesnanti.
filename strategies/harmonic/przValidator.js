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
    const dir = isBullish ? -1 : 1;
    const XA = Math.abs(A.price - X.price);
    const AB = Math.abs(B.price - A.price);
    const BC = Math.abs(C.price - B.price);
    const XC = Math.abs(C.price - X.price);

    const zones = [];
    const addZone = (source, base, leg, range) => {
        if (!range || !Number.isFinite(leg) || leg <= 0) return;
        const a = base + dir * leg * range[0];
        const b = base + dir * leg * range[1];
        zones.push({ source, lo: Math.min(a, b), hi: Math.max(a, b) });
    };

    addZone("XA", A.price, XA, patternCfg.dXa);
    addZone("XC", C.price, XC, patternCfg.dXc);
    addZone("BC", C.price, BC, patternCfg.dBc);
    if (patternKey !== "FIVE_O") addZone("ABCD", C.price, AB, [1.0, 1.272]);

    const atrWidth = atr > 0 ? atr * (cfg.maxPrzWidthAtrMult || 1.5) : Infinity;
    const pctWidth = D_price * ((cfg.maxPrzWidthPct || 1.0) / 100);
    const maxWidth = Math.min(atrWidth, pctWidth);

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    let bestCluster = null;
    for (const z of zones) {
        for (const p of [z.lo, (z.lo + z.hi) / 2, z.hi]) {
            const members = [];
            for (const zz of zones) {
                const cp = clamp(p, zz.lo, zz.hi);
                if (Math.abs(cp - p) <= maxWidth / 2) members.push({ source: zz.source, price: cp });
            }
            
            // Wajib minimal 2 sumber Utama (XA/XC/BC), ABCD murni sebagai penambah skor
            const primaryCount = members.filter(m => m.source !== "ABCD").length;
            const minPrimaryNeeded = patternKey === "FIVE_O" ? 1 : 2;
            if (primaryCount < minPrimaryNeeded) continue;

            const prices = members.map(m => m.price);
            const low = Math.min(...prices);
            const high = Math.max(...prices);
            const width = high - low;
            if (width > maxWidth) continue;

            if (!bestCluster || members.length > bestCluster.count ||
                (members.length === bestCluster.count && width < bestCluster.width)) {
                bestCluster = { low, high, mid: (low + high) / 2, width, count: members.length,
                                sources: members.map(m => m.source), members };
            }
        }
    }

    if (!bestCluster) {
        return { valid: false, reason: `PRZ confluence < 2 sumber utama atau zona > ${maxWidth.toFixed(4)}` };
    }

    // Aturan Beyond-X: jika pola tidak boleh tembus X, tolak bila D atau harga menembus X
    if (!patternCfg.beyondX) {
      if (isBullish && (D_price < X.price || currentPrice < X.price)) {
        return { valid: false, reason: `${patternCfg.label} invalid: titik D menembus X` };
      }
      if (!isBullish && (D_price > X.price || currentPrice > X.price)) {
        return { valid: false, reason: `${patternCfg.label} invalid: titik D menembus X` };
      }
    } else if (patternKey !== "FIVE_O") {
      if (isBullish && !(D_price < X.price)) {
        return { valid: false, reason: `${patternCfg.label} invalid: titik D wajib menembus X` };
      }
      if (!isBullish && !(D_price > X.price)) {
        return { valid: false, reason: `${patternCfg.label} invalid: titik D wajib menembus X` };
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

  /**
   * Proyeksi PRZ Titik D saat struktur X-A-B-C sudah terbentuk (Anticipatory Limit Order)
   */
  function projectPRZ({ isBullish, patternKey, patternCfg, X, A, B, C, currentPrice, atr, cfg }) {
    const dir = isBullish ? -1 : 1;
    const XA = Math.abs(A.price - X.price);
    const AB = Math.abs(B.price - A.price);
    const BC = Math.abs(C.price - B.price);
    const XC = Math.abs(C.price - X.price);

    const zones = [];
    const addZone = (source, base, leg, range) => {
      if (!range || !Number.isFinite(leg) || leg <= 0) return;
      const a = base + dir * leg * range[0];
      const b = base + dir * leg * range[1];
      zones.push({ source, lo: Math.min(a, b), hi: Math.max(a, b) });
    };

    addZone("XA", A.price, XA, patternCfg.dXa);
    addZone("XC", C.price, XC, patternCfg.dXc);
    addZone("BC", C.price, BC, patternCfg.dBc);
    if (patternKey !== "FIVE_O") addZone("ABCD", C.price, AB, [1.0, 1.272]);

    const refLeg = XA > 0 ? XA : BC;
    const atrWidth = atr > 0 ? atr * (cfg.maxPrzWidthAtrMult || 1.5) : Infinity;
    const pctWidth = refLeg * ((cfg.maxPrzWidthPct || 1.0) / 100) * 1.5;
    const maxWidth = Math.min(atrWidth, Math.max(pctWidth, atr * 0.5));
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    let bestCluster = null;
    for (const z of zones) {
      for (const p of [z.lo, (z.lo + z.hi) / 2, z.hi]) {
        const members = [];
        for (const zz of zones) {
          const cp = clamp(p, zz.lo, zz.hi);
          if (Math.abs(cp - p) <= maxWidth / 2) members.push({ source: zz.source, price: cp });
        }
        const primaryCount = members.filter(m => m.source !== "ABCD").length;
        const minPrimaryNeeded = patternKey === "FIVE_O" ? 1 : 2;
        if (primaryCount < minPrimaryNeeded) continue;

        const prices = members.map(m => m.price);
        const low = Math.min(...prices);
        const high = Math.max(...prices);
        const width = high - low;
        if (width > maxWidth) continue;

        if (!bestCluster || members.length > bestCluster.count ||
            (members.length === bestCluster.count && width < bestCluster.width)) {
          bestCluster = {
            low,
            high,
            mid: (low + high) / 2,
            width,
            count: members.length,
            sources: members.map(m => m.source),
            members
          };
        }
      }
    }

    if (!bestCluster) {
      return { valid: false, reason: "Proyeksi PRZ confluence < 2 sumber utama atau zona terlalu lebar" };
    }

    // Jangkar harga Limit Order tepat pada rasio inti Scott Carney di dalam cluster PRZ
    let anchorD = bestCluster.mid;
    if (patternCfg.dXa && XA > 0) {
      anchorD = A.price + dir * XA * patternCfg.dXa[0];
    } else if (patternCfg.dXc && XC > 0) {
      anchorD = C.price + dir * XC * patternCfg.dXc[0];
    } else if (patternCfg.dBc && BC > 0) {
      anchorD = C.price + dir * BC * patternCfg.dBc[0];
    }
    const targetD = clamp(anchorD, bestCluster.low, bestCluster.high);

    // Validasi Beyond-X pada titik proyeksi D
    if (!patternCfg.beyondX) {
      if (isBullish && targetD <= X.price) {
        return { valid: false, reason: `${patternCfg.label} invalid: proyeksi D menembus X` };
      }
      if (!isBullish && targetD >= X.price) {
        return { valid: false, reason: `${patternCfg.label} invalid: proyeksi D menembus X` };
      }
    } else if (patternKey !== "FIVE_O") {
      if (isBullish && !(targetD < X.price)) {
        return { valid: false, reason: `${patternCfg.label} invalid: proyeksi D wajib menembus X` };
      }
      if (!isBullish && !(targetD > X.price)) {
        return { valid: false, reason: `${patternCfg.label} invalid: proyeksi D wajib menembus X` };
      }
    }

    // Titik proyeksi D wajib melewati B (kecuali 5-0)
    if (patternKey !== "FIVE_O") {
      if (isBullish && !(targetD < B.price)) {
        return { valid: false, reason: `${patternCfg.label} invalid: proyeksi D di atas B` };
      }
      if (!isBullish && !(targetD > B.price)) {
        return { valid: false, reason: `${patternCfg.label} invalid: proyeksi D di bawah B` };
      }
    }

    // Jarak pendekatan saat ini ke targetD tidak boleh terlalu jauh (> 4.5 ATR)
    const distToD = Math.abs(currentPrice - targetD);
    if (atr > 0 && distToD > atr * 4.5) {
      return { valid: false, reason: "Harga saat ini masih terlalu jauh dari proyeksi PRZ D" };
    }

    const confluenceScore = Math.min(50, bestCluster.count * 13);
    const tightnessRatio = maxWidth > 0 ? Math.max(0, 1 - bestCluster.width / maxWidth) : 0.5;
    const tightnessScore = Math.round(tightnessRatio * 35);
    const approachRatio = atr > 0 ? Math.max(0, 1 - distToD / (atr * 4.5)) : 0.5;
    const approachScore = Math.round(approachRatio * 15);
    const score = Math.min(100, confluenceScore + tightnessScore + approachScore);

    if (score < (cfg.minPrzScore || 60)) {
      return { valid: false, reason: `Skor PRZ (${score}) di bawah minimum (${cfg.minPrzScore})`, score, prz: bestCluster };
    }

    return {
      valid: true,
      score,
      count: bestCluster.count,
      prz: bestCluster,
      targetD,
      reason: `Proyeksi PRZ D valid (${bestCluster.count} confluence, skor ${score}/100)`
    };
  }

  return { inTolRange, validatePRZ, projectPRZ };
});
