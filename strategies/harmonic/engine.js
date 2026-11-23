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

  const TF_WEIGHT = { "4h": 30, "1h": 20, "15m": 10, "5m": 8 };

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
    const rsiArr = RsiMod.computeRsiSeries(closes, cfg.rsiPeriod || 14);
    const swings = SwingMod.detectSwings(candles, cfg);

    if (swings.length < 4) {
      return { signal: null, logs: [`[${timeframe}] Pivot swing belum cukup (${swings.length}/4)`] };
    }

    const curAtr = atrArr[lastIdx] || 0;
    const tol = Number(cfg.ratioTolerance) || 0.03;
    let bestCandidate = null;

    // Evaluasi struktur X-A-B-C selesai yang sedang menuju proyeksi titik D (Anticipatory Limit Order)
    for (let s = swings.length - 4; s >= Math.max(0, swings.length - 6); s--) {
      const X = swings[s];
      const A = swings[s + 1];
      const B = swings[s + 2];
      const C = swings[s + 3];
      const D_swing = swings[s + 4];

      // Hanya ambil struktur X-A-B-C aktif yang titik D-nya BELUM terbentuk sebagai swing selesai
      if (D_swing) continue;
      if ((lastIdx - C.idx) > 24) continue;

      const isBullish = X.type === "L" && A.type === "H" && B.type === "L" && C.type === "H";
      const isBearish = X.type === "H" && A.type === "L" && B.type === "H" && C.type === "L";
      if (!isBullish && !isBearish) continue;

      // Validasi struktur geometris X-A-B-C sejati
      if (isBullish && !(A.price > X.price && B.price < A.price && C.price > B.price)) continue;
      if (isBearish && !(A.price < X.price && B.price > A.price && C.price < B.price)) continue;

      const XA = Math.abs(A.price - X.price);
      const AB = Math.abs(B.price - A.price);
      const BC = Math.abs(C.price - B.price);
      const XC = Math.abs(C.price - X.price);
      if (XA <= 0 || AB <= 0 || BC <= 0) continue;

      const bRatio = AB / XA;
      const cRatio = BC / AB;
      const cXcRatio = XC / XA;

      // Cek ekstrem harga setelah pivot C untuk memastikan D belum pernah disentuh/ditembus
      let minLowSinceC = Infinity;
      let maxHighSinceC = -Infinity;
      for (let k = C.idx + 1; k <= lastIdx; k++) {
        if (candles[k].low < minLowSinceC) minLowSinceC = candles[k].low;
        if (candles[k].high > maxHighSinceC) maxHighSinceC = candles[k].high;
      }
      if (isBullish && maxHighSinceC > C.price) continue;
      if (isBearish && minLowSinceC < C.price) continue;

      for (const [pKey, pCfg] of Object.entries(cfg.patterns)) {
        if (!pCfg.enabled) continue;

        // Guard geometris titik C terhadap A sesuai jenis pola Scott Carney
        const cMustExceedA = pKey === "CYPHER" || pKey === "FIVE_O";
        if (cMustExceedA) {
          if (isBullish && !(C.price > A.price)) continue;
          if (isBearish && !(C.price < A.price)) continue;
        } else {
          if (isBullish && !(C.price <= A.price)) continue;
          if (isBearish && !(C.price >= A.price)) continue;
        }

        // 1. Cek Rasio B
        if (!PrzMod.inTolRange(bRatio, pCfg.bRange, tol)) continue;

        // 2. Cek Rasio C
        if (pCfg.cIsXcExtension) {
          if (!PrzMod.inTolRange(cXcRatio, pCfg.cRange, tol)) continue;
        } else {
          if (!PrzMod.inTolRange(cRatio, pCfg.cRange, tol)) continue;
        }

        // 3. Proyeksi Zona PRZ Titik D
        const przCheck = PrzMod.projectPRZ({
          isBullish,
          patternKey: pKey,
          patternCfg: pCfg,
          X, A, B, C,
          currentPrice: lastCandle.close,
          atr: curAtr,
          cfg
        });

        if (!przCheck.valid) {
          logs.push(`[${timeframe}] ${pCfg.label} (${isBullish ? "LONG" : "SHORT"}) ditolak: ${przCheck.reason}`);
          continue;
        }

        const D_price = przCheck.targetD;
        const minPassiveGap = Math.max(D_price * 0.0005, curAtr * 0.1);

        // 4. Pastikan proyeksi D BELUM terjemput & harga saat ini masih menuju D
        if (isBullish) {
          if (minLowSinceC <= D_price) continue;
          if (lastCandle.close <= D_price + minPassiveGap || lastCandle.close >= C.price) continue;
        } else {
          if (maxHighSinceC >= D_price) continue;
          if (lastCandle.close >= D_price - minPassiveGap || lastCandle.close <= C.price) continue;
        }

        const AD = Math.abs(A.price - D_price);
        const CD = Math.abs(D_price - C.price);
        const dXaRatio = AD / XA;
        const dBcRatio = CD / BC;
        const dXcRatio = XC > 0 ? Math.abs(C.price - D_price) / XC : 0;

        logs.push(`[${timeframe}] ${pCfg.label} PRZ Limit Siap (Scott Carney · ${przCheck.count} confluence · Limit D @ ${D_price.toFixed(5)})`);

        // 5. Kalkulasi Limit Entry tepat di PRZ D, Stop Loss, & TP1/TP2 Scott Carney
        const entry = D_price;
        const atrBuf = curAtr * (cfg.slAtrBufferMult || 0.35);
        const rawSl = pCfg.beyondX
          ? (isBullish ? D_price - atrBuf : D_price + atrBuf)
          : (isBullish ? Math.min(X.price, D_price) - atrBuf : Math.max(X.price, D_price) + atrBuf);

        const targetLeg = (pKey === "SHARK" || pKey === "FIVE_O")
          ? Math.abs(C.price - D_price)
          : Math.abs(A.price - D_price);
        const tp1Fib = cfg.tp1Fib || 0.382;
        const tp2Fib = cfg.tp2Fib || 0.618;
        const tp1 = isBullish
          ? D_price + targetLeg * tp1Fib
          : D_price - targetLeg * tp1Fib;
        const tp2 = isBullish
          ? D_price + targetLeg * tp2Fib
          : D_price - targetLeg * tp2Fib;

        const riskDist = isBullish ? (entry - rawSl) : (rawSl - entry);
        const rewardDist = isBullish ? (tp2 - entry) : (entry - tp2);
        const rr = (riskDist > 0 && rewardDist > 0) ? (rewardDist / riskDist) : 0;

        const effectiveMinRr = przCheck.score >= 65 ? Math.min(cfg.minRR || 1.5, 1.0) : (cfg.minRR || 1.5);
        if (rr < effectiveMinRr) {
          logs.push(`[${timeframe}] ${pCfg.label} ditolak: RR 1:${rr.toFixed(2)} di bawah minimum 1:${effectiveMinRr}`);
          continue;
        }

        if (isBullish ? tp1 <= entry : tp1 >= entry) {
          logs.push(`[${timeframe}] ${pCfg.label} ditolak: TP1 tidak valid terhadap Limit D`);
          continue;
        }

        const totalScore = przCheck.score + (TF_WEIGHT[timeframe] || 10);
        const candidate = {
          strategy: "HARMONIC_CARNEY",
          entryType: "LIMIT",
          timeframe,
          side: isBullish ? "BUY" : "SELL",
          patternKey: pKey,
          patternName: pCfg.label,
          points: {
            X, A, B, C,
            D: { idx: lastIdx, time: lastCandle.time, price: D_price, projected: true }
          },
          ratios: { bRatio, cRatio, cXcRatio, dXaRatio, dBcRatio, dXcRatio },
          prz: przCheck.prz,
          przScore: przCheck.score,
          totalScore,
          entry,
          sl: rawSl,
          tp1,
          tp2,
          rr,
          atr: curAtr,
          timestamp: lastCandle.time,
          reason: `${pCfg.label} ${isBullish ? "Bullish" : "Bearish"} [${timeframe}] · Limit PRZ D (${przCheck.score}/100) · RR 1:${rr.toFixed(2)}`
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
  function check1hStructureConfirm(cs1h, side) {
    if (!Array.isArray(cs1h) || cs1h.length < 25) return { ok: false, reason: "Data 1H kurang" };
    const closes = cs1h.map(c => c.close);
    const mult = 2 / (21 + 1);
    let ema21 = closes.slice(0, 21).reduce((a, b) => a + b, 0) / 21;
    for (let i = 21; i < closes.length; i++) ema21 = (closes[i] - ema21) * mult + ema21;

    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];

    if (side === "BUY") {
      const ok = (lastClose >= ema21 && lastClose > prevClose);
      return { ok, reason: `1H Close=${lastClose.toFixed(4)} vs EMA21=${ema21.toFixed(4)}` };
    } else {
      const ok = (lastClose <= ema21 && lastClose < prevClose);
      return { ok, reason: `1H Close=${lastClose.toFixed(4)} vs EMA21=${ema21.toFixed(4)}` };
    }
  }

  /**
   * Evaluasi Hierarki Wajib Top-Down:
   * 1) 4H: Mencari Pola Harmonic Utama (Bias Makro - DILARANG EKSEKUSI)
   * 2) 1H: Konfirmasi Struktur / Pola Searah
   * 3) 15M: Mencari PRZ Sniper Entry (SATU-SATUNYA TF EKSEKUSI)
   */
  function evaluateMultiTimeframe(candlesByTf, userSettings) {
    const cfg = ConfigMod.mergeSettings(userSettings);
    const allLogs = [];
    const allSignals = [];

    const cs4h = candlesByTf["4h"];
    const cs1h = candlesByTf["1h"];
    const cs15m = candlesByTf["15m"];

    // Analisis masing-masing timeframe (4H hanya struktur, 1H & 15M boleh mandiri atau MTF)
    const res4h = (Array.isArray(cs4h) && cs4h.length >= 50)
      ? analyzeSingleTimeframe(cs4h, "4h", cfg)
      : { signal: null, logs: ["[4h] Data candle belum cukup"] };
    allLogs.push(...res4h.logs);
    const sig4h = res4h.signal;
    if (sig4h) allSignals.push(sig4h);

    const res1h = (Array.isArray(cs1h) && cs1h.length >= 50)
      ? analyzeSingleTimeframe(cs1h, "1h", cfg)
      : { signal: null, logs: ["[1h] Data candle belum cukup"] };
    allLogs.push(...res1h.logs);
    const sig1h = res1h.signal;
    if (sig1h) allSignals.push(sig1h);

    const res15m = (Array.isArray(cs15m) && cs15m.length >= 50)
      ? analyzeSingleTimeframe(cs15m, "15m", cfg)
      : { signal: null, logs: ["[15m] Data candle belum cukup"] };
    allLogs.push(...res15m.logs);
    const sig15m = res15m.signal;
    if (sig15m) allSignals.push(sig15m);

    const cs5m = candlesByTf["5m"];
    const res5m = (Array.isArray(cs5m) && cs5m.length >= 50)
      ? analyzeSingleTimeframe(cs5m, "5m", cfg)
      : { signal: null, logs: ["[5m] Data candle belum cukup"] };
    allLogs.push(...res5m.logs);
    const sig5m = res5m.signal;
    if (sig5m) allSignals.push(sig5m);

    // JALUR A (Prioritas Tertinggi): Top-Down MTF 4H Struktur -> 1H Validasi -> 15M Sniper Eksekusi
    if (sig4h) {
      const biasSide = sig4h.side;
      let confirmed1h = false;
      let confirm1hNote = "";
      if (sig1h && sig1h.side === biasSide) {
        confirmed1h = true;
        confirm1hNote = `1H Harmonic ${sig1h.patternName} Searah`;
      } else if (Array.isArray(cs1h) && cs1h.length >= 25) {
        const struct1h = check1hStructureConfirm(cs1h, biasSide);
        confirmed1h = struct1h.ok;
        confirm1hNote = struct1h.reason;
      }

      if (confirmed1h && sig15m && sig15m.side === biasSide) {
        sig15m.timeframe = "15m";
        sig15m.mtfConfirmed = true;
        sig15m.bias4hPattern = sig4h.patternName;
        sig15m.bias4hDetail = `${sig4h.patternName} (${sig4h.side}) | AB/XA=${sig4h.ratios.bRatio.toFixed(3)}, BC/AB=${sig4h.ratios.cRatio.toFixed(3)}, AD/XA=${sig4h.ratios.dXaRatio.toFixed(3)} | PRZ ${sig4h.prz.low.toFixed(4)}-${sig4h.prz.high.toFixed(4)}`;
        sig15m.confirm1hNote = confirm1hNote;
        sig15m.reason = `[MTF 4H->1H->15M] Struktur 4H: ${sig4h.patternName} (${biasSide}) -> Validasi 1H (${confirm1hNote}) -> Eksekusi 15M ${sig15m.patternName} (RR 1:${sig15m.rr.toFixed(2)})`;
        return { signal: sig15m, allSignals, logs: allLogs };
      } else if (!confirmed1h) {
        allLogs.push(`[MTF HOLD] Struktur 4H ${sig4h.patternName} (${biasSide}) menunggu validasi 1H (${confirm1hNote})`);
      } else {
        allLogs.push(`[MTF WATCH] Struktur 4H ${sig4h.patternName} (${biasSide}) + 1H Valid -> Menunggu PRZ 15M`);
      }
    }

    // JALUR B: Eksekusi Mandiri 1H (boleh mandiri tanpa struktur 4H di atasnya, selama tidak berlawanan pola aktif 4H)
    if (sig1h) {
      if (sig4h && sig1h.side !== sig4h.side) {
        allLogs.push("[BLOCKED 4H BIAS] Mandiri 1H " + sig1h.patternName + " (" + sig1h.side + ") berlawanan pola aktif 4H (" + sig4h.patternName + " " + sig4h.side + ")");
      } else {
        sig1h.timeframe = "1h";
        sig1h.reason = "[MANDIRI 1H] " + sig1h.patternName + " (" + sig1h.side + ") valid Scott Carney (±3.5% + RSI BAMM) · PRZ " + sig1h.przScore + "/100 · RR 1:" + sig1h.rr.toFixed(2);
        return { signal: sig1h, allSignals, logs: allLogs };
      }
    }

    // JALUR C: Eksekusi Mandiri 15M (boleh mandiri tanpa struktur 1H/4H di atasnya, selama tidak berlawanan pola aktif 4H)
    if (sig15m) {
      if (sig4h && sig15m.side !== sig4h.side) {
        allLogs.push("[BLOCKED 4H BIAS] Mandiri 15M " + sig15m.patternName + " (" + sig15m.side + ") berlawanan pola aktif 4H (" + sig4h.patternName + " " + sig4h.side + ")");
      } else {
        sig15m.timeframe = "15m";
        sig15m.reason = "[MANDIRI 15M] " + sig15m.patternName + " (" + sig15m.side + ") valid Scott Carney (±3.5% + RSI BAMM) · PRZ " + sig15m.przScore + "/100 · RR 1:" + sig15m.rr.toFixed(2);
        return { signal: sig15m, allSignals, logs: allLogs };
      }
    }

    // JALUR D: 5M DILARANG eksekusi mandiri — wajib ditopang struktur Harmonic aktif 4H atau 1H searah
    if (sig5m) {
      const has4hSupport = Boolean(sig4h && sig4h.side === sig5m.side);
      const has1hSupport = Boolean(sig1h && sig1h.side === sig5m.side);
      const opposed4h = Boolean(sig4h && sig4h.side !== sig5m.side);
      const opposed1h = Boolean(sig1h && sig1h.side !== sig5m.side);

      if ((has4hSupport || has1hSupport) && !opposed4h && !opposed1h) {
        const anchor = has4hSupport && has1hSupport
          ? `4H ${sig4h.patternName} + 1H ${sig1h.patternName}`
          : (has4hSupport ? `4H ${sig4h.patternName}` : `1H ${sig1h.patternName}`);
        sig5m.timeframe = "5m";
        sig5m.mtfConfirmed = true;
        sig5m.reason = `[MTF SNIPER 5M] ${sig5m.patternName} (${sig5m.side}) ditopang struktur ${anchor} · PRZ ${sig5m.przScore}/100 · RR 1:${sig5m.rr.toFixed(2)}`;
        return { signal: sig5m, allSignals, logs: allLogs };
      } else {
        allLogs.push(`[BLOCKED 5M MANDIRI] ${sig5m.patternName} (${sig5m.side}) ditahan: 5M wajib ditopang struktur Harmonic aktif 4H/1H searah`);
      }
    }

    // 4H tidak pernah dieksekusi langsung
    return { signal: null, allSignals, logs: allLogs };
  }

  return { analyzeSingleTimeframe, evaluateMultiTimeframe };
});
