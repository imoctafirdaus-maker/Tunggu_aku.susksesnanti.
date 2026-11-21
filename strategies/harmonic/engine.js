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
      if (D_swing && (lastIdx - D_swing.idx) > 4) continue;

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

        // Mode Pure Scott Carney: PRZ terkonfirmasi tetap valid tanpa wajib RSI oversold/overbought
        if (!rsiCheck.valid) {
          logs.push(`[${timeframe}] ${pCfg.label} PRZ Valid (Scott Carney) · Catatan RSI: ${rsiCheck.reason}`);
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
  function check1hStructureConfirm(cs1h, side) {
    if (!Array.isArray(cs1h) || cs1h.length < 25) return { ok: false, reason: "Data 1H kurang" };
    const closes = cs1h.map(c => c.close);
    const mult = 2 / (21 + 1);
    let ema21 = closes.slice(0, 21).reduce((a, b) => a + b, 0) / 21;
    for (let i = 21; i < closes.length; i++) ema21 = (closes[i] - ema21) * mult + ema21;

    let gains = 0, losses = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    const rsi14 = 100 - (100 / (1 + rs));
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];

    if (side === "BUY") {
      const ok = (lastClose >= ema21 || lastClose > prevClose) && rsi14 >= 42 && rsi14 <= 72;
      return { ok, reason: `1H Close=${lastClose.toFixed(4)} vs EMA21=${ema21.toFixed(4)}, RSI=${rsi14.toFixed(1)}` };
    } else {
      const ok = (lastClose <= ema21 || lastClose < prevClose) && rsi14 <= 58 && rsi14 >= 28;
      return { ok, reason: `1H Close=${lastClose.toFixed(4)} vs EMA21=${ema21.toFixed(4)}, RSI=${rsi14.toFixed(1)}` };
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

    // JALUR B: Eksekusi Mandiri 1H jika 1H membentuk pola Harmonic valid sesuai syarat & toleransi Scott Carney
    if (sig1h) {
      sig1h.timeframe = "1h";
      sig1h.reason = `[MANDIRI 1H] ${sig1h.patternName} (${sig1h.side}) valid Scott Carney · PRZ ${sig1h.przScore}/100 · RR 1:${sig1h.rr.toFixed(2)}`;
      return { signal: sig1h, allSignals, logs: allLogs };
    }

    // JALUR C: Eksekusi Mandiri 15M jika 15M membentuk pola Harmonic valid sesuai syarat & toleransi Scott Carney
    if (sig15m) {
      sig15m.timeframe = "15m";
      sig15m.reason = `[MANDIRI 15M] ${sig15m.patternName} (${sig15m.side}) valid Scott Carney · PRZ ${sig15m.przScore}/100 · RR 1:${sig15m.rr.toFixed(2)}`;
      return { signal: sig15m, allSignals, logs: allLogs };
    }

    // 4H tidak pernah dieksekusi langsung
    return { signal: null, allSignals, logs: allLogs };
  }

  return { analyzeSingleTimeframe, evaluateMultiTimeframe };
});
