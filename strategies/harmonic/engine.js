(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./config"),
      require("./swingDetector"),
      require("./przValidator"),
      require("./rsiConfirmation")
    );
  } else {
    root.HarmonicEngine = factory(
      root.HarmonicConfig,
      root.HarmonicSwingDetector,
      root.HarmonicPrzValidator,
      root.HarmonicRsiConfirmation
    );
  }
})(typeof self !== "undefined" ? self : this, function (ConfigMod, SwingMod, PrzMod, RsiMod) {
  "use strict";

  const TF_WEIGHT = { "4h": 30, "1h": 20, "15m": 10 };

  /**
   * Analisis satu timeframe pada closed candles (tanpa repaint / tanpa look-ahead bias)
   */
  function analyzeSingleTimeframe(rawCandles, timeframe, userSettings) {
    const cfg = ConfigMod.mergeSettings(userSettings);
    const logs = [];
    if (!cfg.enabled) return { signal: null, logs: ["Modul Harmonic dalam keadaan OFF"] };
    if (!Array.isArray(rawCandles) || rawCandles.length < 45) {
      return { signal: null, logs: ["Jumlah candle historis kurang dari 45 bar"] };
    }

    const candles = rawCandles.filter(c => c.closed !== false);
    const lastIdx = candles.length - 1;
    const lastCandle = candles[lastIdx];
    const closes = candles.map(c => c.close);
    const atrArr = SwingMod.computeATR(candles, cfg.atrPeriod);
    const rsiArr = RsiMod.computeRsiSeries(closes, cfg.rsiPeriod);
    const swings = SwingMod.detectSwings(candles, cfg);

    if (swings.length < 4) {
      return { signal: null, logs: [`[${timeframe}] Pivot swing belum cukup (${swings.length}/4)`] };
    }

    const curAtr = atrArr[lastIdx] || 0;
    const tol = Number(cfg.ratioTolerance) || 0.03;
    let bestCandidate = null;

    // Evaluasi struktur X-A-B-C terakhir (D terbentuk di bar terakhir atau sedang diuji di bar closed terakhir)
    for (let s = swings.length - 4; s >= Math.max(0, swings.length - 8); s--) {
      const X = swings[s];
      const A = swings[s + 1];
      const B = swings[s + 2];
      const C = swings[s + 3];
      const D_swing = swings[s + 4];

      // Jangan pakai pola basi jika D terbentuk lebih dari 2 candle closed lalu
      if (D_swing && (lastIdx - D_swing.idx) > 2) continue;

      const isBullish = X.type === "L" && A.type === "H" && B.type === "L" && C.type === "H";
      const isBearish = X.type === "H" && A.type === "L" && B.type === "H" && C.type === "L";
      if (!isBullish && !isBearish) continue;

      const XA = Math.abs(A.price - X.price);
      const AB = Math.abs(B.price - A.price);
      const BC = Math.abs(C.price - B.price);
      const XC = Math.abs(C.price - X.price);
      if (XA <= 0 || AB <= 0 || BC <= 0) continue;

      const dIdx = D_swing ? D_swing.idx : lastIdx;
      const D_price = D_swing ? D_swing.price : (isBullish ? lastCandle.low : lastCandle.high);
      const AD = Math.abs(A.price - D_price);
      const CD = Math.abs(D_price - C.price);

      const bRatio = AB / XA;
      const cRatio = BC / AB;
      const cXcRatio = XC / XA;
      const dXaRatio = AD / XA;
      const dBcRatio = CD / BC;
      const dXcRatio = XC > 0 ? Math.abs(C.price - D_price) / XC : 0;

      for (const [pKey, pCfg] of Object.entries(cfg.patterns)) {
        if (!pCfg.enabled) continue;

        // 1. Cek Rasio B
        if (!PrzMod.inTolRange(bRatio, pCfg.bRange, tol)) continue;

        // 2. Cek Rasio C (AB retracement atau XA extension untuk Cypher)
        if (pCfg.cIsXcExtension) {
          if (!PrzMod.inTolRange(cXcRatio, pCfg.cRange, tol)) continue;
        } else {
          if (!PrzMod.inTolRange(cRatio, pCfg.cRange, tol)) continue;
        }

        // 3. Cek Rasio D (XA / XC & BC)
        if (pCfg.dXa && !PrzMod.inTolRange(dXaRatio, pCfg.dXa, tol)) continue;
        if (pCfg.dXc && !PrzMod.inTolRange(dXcRatio, pCfg.dXc, tol)) continue;
        if (pCfg.dBc && !PrzMod.inTolRange(dBcRatio, pCfg.dBc, tol)) continue;

        // 4. Validasi PRZ Confluence (>=3 proyeksi, skor 0-100, guard beyond-X)
        const przCheck = PrzMod.validatePRZ({
          isBullish,
          patternKey: pKey,
          patternCfg: pCfg,
          X, A, B, C,
          D_price,
          currentPrice: lastCandle.close,
          atr: curAtr,
          cfg
        });

        if (!przCheck.valid) {
          logs.push(`[${timeframe}] ${pCfg.label} (${isBullish ? "LONG" : "SHORT"}) ditolak: ${przCheck.reason}`);
          continue;
        }

        // 5. Konfirmasi RSI (Level / Divergence) + Candle Reversal Close
        const refPivot = isBullish
          ? (C.price < A.price ? C : A)
          : (C.price > A.price ? C : A);
        const rsiCheck = RsiMod.evaluateRsiAndCandle({
          candles,
          rsiArr,
          isBullish,
          refPivot,
          dIdx: lastIdx,
          cfg
        });

        if (!rsiCheck.valid) {
          logs.push(`[${timeframe}] ${pCfg.label} PRZ OK, menunggu konfirmasi: ${rsiCheck.reason}`);
          continue;
        }

        // 6. Kalkulasi Entry, Stop Loss (di luar X atau luar PRZ + buffer ATR), TP1 (0.382 AD), TP2 (0.618 AD), & RR >= 1:2
        const entry = lastCandle.close;
        const atrBuf = curAtr * (cfg.slAtrBufferMult || 0.35);
        const rawSl = isBullish
          ? Math.min(X.price, przCheck.prz.low, D_price) - atrBuf
          : Math.max(X.price, przCheck.prz.high, D_price) + atrBuf;

        const actualAD = Math.abs(A.price - D_price);
        const tp1 = isBullish
          ? D_price + actualAD * (cfg.tp1Fib || 0.382)
          : D_price - actualAD * (cfg.tp1Fib || 0.382);
        const tp2 = isBullish
          ? D_price + actualAD * (cfg.tp2Fib || 0.618)
          : D_price - actualAD * (cfg.tp2Fib || 0.618);

        const riskDist = Math.abs(entry - rawSl);
        const rewardDist = Math.abs(tp2 - entry);
        const rr = riskDist > 0 ? rewardDist / riskDist : 0;

        if (rr < (cfg.minRR || 2.0)) {
          logs.push(`[${timeframe}] ${pCfg.label} ditolak: RR 1:${rr.toFixed(2)} di bawah minimum 1:${cfg.minRR}`);
          continue;
        }

        const totalScore = przCheck.score + (TF_WEIGHT[timeframe] || 10) + (rsiCheck.divergenceOk ? 10 : 0);
        const candidate = {
          strategy: "HARMONIC_CARNEY",
          timeframe,
          side: isBullish ? "BUY" : "SELL",
          patternKey: pKey,
          patternName: pCfg.label,
          points: {
            X, A, B, C,
            D: { idx: lastIdx, time: lastCandle.time, price: D_price }
          },
          ratios: { bRatio, cRatio, cXcRatio, dXaRatio, dBcRatio, dXcRatio },
          prz: przCheck.prz,
          przScore: przCheck.score,
          totalScore,
          rsi: rsiCheck.curRsi,
          rsiDivergence: rsiCheck.divergenceOk,
          entry,
          sl: rawSl,
          tp1,
          tp2,
          rr,
          atr: curAtr,
          timestamp: lastCandle.time,
          reason: `${pCfg.label} ${isBullish ? "Bullish" : "Bearish"} [${timeframe}] · PRZ ${przCheck.score}/100 · RSI ${rsiCheck.curRsi.toFixed(1)} · RR 1:${rr.toFixed(2)}`
        };

        if (!bestCandidate || candidate.totalScore > bestCandidate.totalScore) {
          bestCandidate = candidate;
        }
      }
    }

    return { signal: bestCandidate, logs };
  }

  /**
   * Evaluasi Hierarki Multi-Timeframe: 4h -> 1h -> 15m
   */
  function evaluateMultiTimeframe(candlesByTf, userSettings) {
    const cfg = ConfigMod.mergeSettings(userSettings);
    const order = cfg.timeframes || ["4h", "1h", "15m"];
    const allLogs = [];
    const foundSignals = [];

    for (const tf of order) {
      const cs = candlesByTf[tf];
      if (!Array.isArray(cs) || !cs.length) {
        allLogs.push(`[${tf}] Data candle belum tersedia`);
        continue;
      }
      const res = analyzeSingleTimeframe(cs, tf, cfg);
      allLogs.push(...res.logs);
      if (res.signal) {
        foundSignals.push(res.signal);
      }
    }

    if (!foundSignals.length) {
      return { signal: null, allSignals: [], logs: allLogs };
    }

    // Prioritas utama: sinyal dari timeframe lebih tinggi (4h > 1h > 15m), lalu skor tertinggi
    foundSignals.sort((a, b) => b.totalScore - a.totalScore);
    const top = foundSignals[0];

    // Bonus confluence jika TF bawah searah dengan sinyal TF atas
    const alignedLower = foundSignals.filter(s => s.timeframe !== top.timeframe && s.side === top.side);
    if (alignedLower.length) {
      top.mtfAligned = alignedLower.map(s => s.timeframe);
      top.reason += ` + MTF Searah (${top.mtfAligned.join(",")})`;
    }

    return { signal: top, allSignals: foundSignals, logs: allLogs };
  }

  return { analyzeSingleTimeframe, evaluateMultiTimeframe };
});
