"use strict";

function classifyScore(score, thresholds) {
  if (score >= thresholds.strongSetup) return "STRONG_SETUP";
  if (score >= thresholds.validSetup) return "VALID_SETUP";
  if (score >= thresholds.watchlist) return "WATCHLIST";
  return "WAIT";
}

function isVdAligned(ofObj, isBuy) {
  if (!ofObj || !ofObj.valid) return false;
  return isBuy
    ? (ofObj.direction === "BULLISH" || (ofObj.delta > 0 && ofObj.cvdDirection === "BULLISH"))
    : (ofObj.direction === "BEARISH" || (ofObj.delta < 0 && ofObj.cvdDirection === "BEARISH"));
}

function isVdOpposing(ofObj, isBuy) {
  if (!ofObj || !ofObj.valid) return false;
  return isBuy ? ofObj.direction === "BEARISH" : ofObj.direction === "BULLISH";
}

function scoreDirectionalSide(side, ctx, cfg) {
  const isBuy = side === "BUY";
  const w = cfg.weights;
  const reasons = [];

  const st1h = ctx.structure1h || ctx.structure15m;
  const st15 = ctx.structure15m;
  const st5 = ctx.structure5m;

  const liq15 = ctx.liquidity15m || ctx.liquidity5m;
  const fvg15 = ctx.fvg15m || ctx.fvg5m;
  const ob15 = ctx.orderBlocks15m || ctx.orderBlocks5m;
  const pd15 = ctx.context15m || ctx.context5m;

  const fvg5 = ctx.fvg5m;
  const ob5 = ctx.orderBlocks5m;
  const disp5 = ctx.displacement5m;

  const of1h = ctx.orderFlow1h || ctx.orderFlow1m;
  const of15 = ctx.orderFlow15m || ctx.orderFlow1m;
  const of5 = ctx.orderFlow5m || ctx.orderFlow1m;

  // 1. Market Structure MTF: 1h Bias -> 15m Validasi -> 5m Eksekusi (max 20)
  let structurePts = 0;
  const bias1hAligned = isBuy ? st1h.direction === "BULLISH" : st1h.direction === "BEARISH";
  const val15Aligned = isBuy
    ? (st15.direction === "BULLISH" || st15.bos?.type === "BULLISH_BOS" || st15.choch?.type === "BULLISH_CHOCH")
    : (st15.direction === "BEARISH" || st15.bos?.type === "BEARISH_BOS" || st15.choch?.type === "BEARISH_CHOCH");
  const exec5Trigger = isBuy
    ? (st5.bos?.type === "BULLISH_BOS" || st5.choch?.type === "BULLISH_CHOCH" || st5.mss?.type === "BULLISH_MSS")
    : (st5.bos?.type === "BEARISH_BOS" || st5.choch?.type === "BEARISH_CHOCH" || st5.mss?.type === "BEARISH_MSS");

  if (bias1hAligned && val15Aligned && exec5Trigger) {
    structurePts = w.marketStructure;
    reasons.push(`Struktur 1h ${st1h.direction} -> validasi 15m -> trigger ${st5.lastEvent?.type || "BOS/CHoCH"} 5m`);
  } else if (bias1hAligned && (val15Aligned || exec5Trigger)) {
    structurePts = Math.round(w.marketStructure * 0.8);
    reasons.push(`Struktur utama 1h ${st1h.direction} terkonfirmasi (${val15Aligned ? "15m valid" : "5m trigger"})`);
  } else if (val15Aligned && exec5Trigger && st5.mss) {
    structurePts = Math.round(w.marketStructure * 0.75);
    reasons.push(`MSS Reversal 15m->5m terkonfirmasi (${st5.mss.type})`);
  } else if (bias1hAligned) {
    structurePts = Math.round(w.marketStructure * 0.5);
    reasons.push(`Bias struktur 1h ${st1h.direction}`);
  } else if (exec5Trigger) {
    structurePts = Math.round(w.marketStructure * 0.45);
    reasons.push(`Trigger struktur mikro 5m (${st5.lastEvent?.type})`);
  }

  // 2. Validasi Liquidity Sweep 15m (max 20)
  let sweepPts = 0;
  const sweep = liq15.recentSweep;
  if (sweep && sweep.side === side && sweep.barsAgo <= 10) {
    sweepPts = sweep.barsAgo <= 4 ? w.liquiditySweep : Math.round(w.liquiditySweep * 0.8);
    reasons.push(`Validasi 15m: Liquidity Sweep ${sweep.type} di $${sweep.levelPrice} (${sweep.barsAgo} bar lalu)`);
  } else if (pd15.judasSwing && ((isBuy && pd15.judasSwing.type === "BULLISH_JUDAS_SWING") || (!isBuy && pd15.judasSwing.type === "BEARISH_JUDAS_SWING"))) {
    sweepPts = w.liquiditySweep;
    reasons.push(`Validasi 15m: Judas Swing ${pd15.judasSwing.session} menyapu likuiditas`);
  }

  // 3. Validasi POI 15m & Eksekusi Zona 5m: FVG / Order Block / Breaker (max 15)
  let zonePts = 0;
  const activeFvg15 = isBuy ? fvg15.activeBullish : fvg15.activeBearish;
  const activeOb15 = isBuy ? ob15.activeBullish : ob15.activeBearish;
  const activeFvg5 = isBuy ? fvg5.activeBullish : fvg5.activeBearish;
  const activeOb5 = isBuy ? ob5.activeBullish : ob5.activeBearish;
  const breaker = pd15.breakerBlock && pd15.breakerBlock.side === side ? pd15.breakerBlock : null;

  const has15Poi = Boolean((activeFvg15 && (activeFvg15.priceInside || activeFvg15.touched)) || (activeOb15 && (activeOb15.priceInside || activeOb15.retested)));
  const has5Poi = Boolean((activeFvg5 && (activeFvg5.priceInside || activeFvg5.touched)) || (activeOb5 && (activeOb5.priceInside || activeOb5.retested)));

  if (has15Poi && has5Poi) {
    zonePts = w.fvgOrderBlock;
    reasons.push("Konfluensi POI 15m + zona eksekusi FVG/OB 5m");
  } else if (has15Poi) {
    zonePts = Math.round(w.fvgOrderBlock * 0.85);
    const label15 = activeFvg15 && (activeFvg15.priceInside || activeFvg15.touched) ? `${activeFvg15.type} 15m` : `${activeOb15.type} 15m`;
    reasons.push(`Validasi POI ${label15}`);
  } else if (has5Poi) {
    zonePts = Math.round(w.fvgOrderBlock * 0.75);
    const label5 = activeFvg5 && (activeFvg5.priceInside || activeFvg5.touched) ? `${activeFvg5.type} 5m` : `${activeOb5.type} 5m`;
    reasons.push(`Zona eksekusi ${label5}`);
  } else if (breaker) {
    zonePts = Math.round(w.fvgOrderBlock * 0.8);
    reasons.push(`Konfirmasi ${breaker.type} 15m`);
  }

  // 4. Eksekusi Displacement 5m (max 15)
  let dispPts = 0;
  const dispMatch = disp5.detected && ((isBuy && disp5.direction === "BULLISH") || (!isBuy && disp5.direction === "BEARISH"));
  if (dispMatch && disp5.recent.barsAgo <= 6) {
    dispPts = disp5.recent.createdFvg ? w.displacement : Math.round(w.displacement * 0.8);
    reasons.push(`Eksekusi 5m: Displacement ${disp5.direction} (${disp5.recent.bodyToAtr}x ATR, body ${(disp5.recent.bodyToRange * 100).toFixed(0)}%)`);
  }

  // 5. Multi-TF Volume Delta: 1h Positif VD + 15m Validasi VD + 5m Eksekusi VD (max 20)
  let vdPts = 0;
  let vdPenalty = 0;
  const vd1hOk = isVdAligned(of1h, isBuy);
  const vd15Ok = isVdAligned(of15, isBuy);
  const vd5Ok = isVdAligned(of5, isBuy);

  if (vd1hOk && vd15Ok && vd5Ok) {
    vdPts = w.volumeDelta;
    reasons.push(`Positif VD MTF penuh: 1h (${of1h.deltaPct}%) + 15m (${of15.deltaPct}%) + 5m (${of5.deltaPct}%)`);
  } else if (vd1hOk && (vd15Ok || vd5Ok)) {
    vdPts = Math.round(w.volumeDelta * 0.85);
    reasons.push(`VD 1h positif (${of1h.deltaPct}%) + ${vd15Ok ? "15m valid" : "5m eksekusi"} searah`);
  } else if (vd1hOk) {
    vdPts = Math.round(w.volumeDelta * 0.6);
    reasons.push(`VD 1h positif searah (${of1h.deltaPct}% · Buy ${of1h.buyPct}%)`);
  } else if (vd15Ok && vd5Ok) {
    vdPts = Math.round(w.volumeDelta * 0.55);
    reasons.push(`VD 15m (${of15.deltaPct}%) & 5m (${of5.deltaPct}%) searah`);
  }

  if (isVdOpposing(of1h, isBuy) && (of1h.isExtreme || of1h.isSpike)) {
    vdPenalty += 12;
    reasons.push(`Penalti: Volume Delta 1h berlawanan (${of1h.deltaPct}%)`);
  }
  if (isVdOpposing(of5, isBuy) && of5.isExtreme) {
    vdPenalty += 6;
    reasons.push("Peringatan: Tekanan VD 5m berlawanan ekstrem");
  }

  // 6. CVD Trend, Divergence & Absorption (1h & 15m, max 10)
  let cvdPts = 0;
  const cvd1hAligned = of1h && of1h.valid && ((isBuy && of1h.cvdDirection === "BULLISH") || (!isBuy && of1h.cvdDirection === "BEARISH"));
  const divMatch = (of15?.divergence && of15.divergence.side === side) || (of5?.divergence && of5.divergence.side === side);
  const absMatch = (of15?.absorption && of15.absorption.side === side) || (of5?.absorption && of5.absorption.side === side);

  if (cvd1hAligned && (divMatch || absMatch)) {
    cvdPts = w.cvdDivergence;
    reasons.push(`CVD 1h ${of1h.cvdSlope} + ${divMatch ? "Divergensi" : "Absorpsi"} terkonfirmasi`);
  } else if (cvd1hAligned) {
    cvdPts = Math.round(w.cvdDivergence * 0.7);
    reasons.push(`CVD 1h ${of1h.cvdSlope} searah tren utama`);
  } else if (divMatch || absMatch) {
    cvdPts = Math.round(w.cvdDivergence * 0.6);
    reasons.push(divMatch ? "Divergensi CVD terkonfirmasi" : "Absorpsi institusional terdeteksi");
  }

  // Contextual Bonus (Premium/Discount & OTE 15m)
  let contextBonus = 0;
  if (isBuy && pd15.dealingRange.zone === "DISCOUNT") {
    contextBonus += 3;
    reasons.push(`Validasi 15m: Discount Zone (${pd15.dealingRange.rangePct}%)`);
  } else if (!isBuy && pd15.dealingRange.zone === "PREMIUM") {
    contextBonus += 3;
    reasons.push(`Validasi 15m: Premium Zone (${pd15.dealingRange.rangePct}%)`);
  }
  if ((isBuy && pd15.ote.inBullishOte) || (!isBuy && pd15.ote.inBearishOte)) {
    contextBonus += 3;
    reasons.push("Validasi 15m: Area Fibonacci OTE (0.62–0.79)");
  }

  const rawTotal = structurePts + sweepPts + zonePts + dispPts + vdPts + cvdPts + contextBonus - vdPenalty;
  const totalScore = Math.max(0, Math.min(100, Math.round(rawTotal)));
  const isCountertrend = !bias1hAligned && exec5Trigger;

  return {
    side,
    totalScore,
    category: classifyScore(totalScore, cfg.thresholds),
    isCountertrend,
    breakdown: {
      marketStructure: structurePts,
      liquiditySweep: sweepPts,
      fvgOrderBlock: zonePts,
      displacement: dispPts,
      volumeDelta: vdPts,
      cvdDivergence: cvdPts,
      contextBonus,
      vdPenalty
    },
    reasons
  };
}

function evaluateSignalScore(ctx, cfg) {
  const primaryOf = ctx.orderFlow1h || ctx.orderFlow15m || ctx.orderFlow1m;
  if (!primaryOf || primaryOf.dataQuality === "DATA_UNAVAILABLE") {
    return {
      signal: "WAIT",
      category: "WAIT",
      score: 0,
      isCountertrend: false,
      reason: "DATA_UNAVAILABLE: Data Volume Delta tidak tersedia.",
      reasons: ["DATA_UNAVAILABLE: Menunggu data kline & Volume Delta."],
      buyEval: null,
      sellEval: null
    };
  }

  const buyEval = scoreDirectionalSide("BUY", ctx, cfg);
  const sellEval = scoreDirectionalSide("SELL", ctx, cfg);

  const best = buyEval.totalScore >= sellEval.totalScore ? buyEval : sellEval;
  const other = best.side === "BUY" ? sellEval : buyEval;

  if (best.totalScore - other.totalScore < 10 && best.totalScore >= cfg.thresholds.watchlist) {
    return {
      signal: "WAIT",
      category: "WATCHLIST",
      score: best.totalScore,
      isCountertrend: best.isCountertrend,
      reason: `Kondisi pasar belum tegas (Skor BUY ${buyEval.totalScore} vs SELL ${sellEval.totalScore}).`,
      reasons: best.reasons,
      buyEval,
      sellEval
    };
  }

  const minActionableScore = best.isCountertrend ? Math.max(cfg.thresholds.validSetup, 72) : cfg.thresholds.validSetup;
  const isActionable = best.totalScore >= minActionableScore && primaryOf.dataQuality === "VALID";

  const signal = isActionable ? best.side : "WAIT";
  const summaryReason = best.reasons.length
    ? best.reasons.slice(0, 3).join(" • ")
    : "Belum ada konfluensi struktur ICT 1h->15m->5m & Volume Delta yang memadai.";

  return {
    signal,
    category: best.category,
    score: best.totalScore,
    isCountertrend: best.isCountertrend,
    breakdown: best.breakdown,
    reason: summaryReason,
    reasons: best.reasons,
    buyEval,
    sellEval
  };
}

module.exports = { classifyScore, scoreDirectionalSide, evaluateSignalScore };
