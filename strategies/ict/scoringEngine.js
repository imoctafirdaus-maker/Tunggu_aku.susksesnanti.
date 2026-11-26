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

  // 1. Struktur Mikro 5m & Konteks MTF (Syarat Wajib #1)
  let structurePts = 0;
  const bias1hAligned = isBuy ? st1h.direction === "BULLISH" : st1h.direction === "BEARISH";
  const val15Aligned = isBuy
    ? (st15.direction === "BULLISH" || st15.bos?.type === "BULLISH_BOS" || st15.choch?.type === "BULLISH_CHOCH")
    : (st15.direction === "BEARISH" || st15.bos?.type === "BEARISH_BOS" || st15.choch?.type === "BEARISH_CHOCH");
  const exec5Trigger = isBuy
    ? (st5.bos?.type === "BULLISH_BOS" || st5.choch?.type === "BULLISH_CHOCH" || st5.mss?.type === "BULLISH_MSS")
    : (st5.bos?.type === "BEARISH_BOS" || st5.choch?.type === "BEARISH_CHOCH" || st5.mss?.type === "BEARISH_MSS");

  const trigger5mLabel = isBuy
    ? (st5.mss?.type === "BULLISH_MSS" ? "BULLISH_MSS" : (st5.choch?.type === "BULLISH_CHOCH" ? "BULLISH_CHOCH" : (st5.bos?.type === "BULLISH_BOS" ? "BULLISH_BOS" : (st5.lastEvent?.type || "NONE"))))
    : (st5.mss?.type === "BEARISH_MSS" ? "BEARISH_MSS" : (st5.choch?.type === "BEARISH_CHOCH" ? "BEARISH_CHOCH" : (st5.bos?.type === "BEARISH_BOS" ? "BEARISH_BOS" : (st5.lastEvent?.type || "NONE"))));

  if (bias1hAligned && val15Aligned && exec5Trigger) {
    structurePts = w.marketStructure;
  } else if (bias1hAligned && (val15Aligned || exec5Trigger)) {
    structurePts = Math.round(w.marketStructure * 0.8);
  } else if (val15Aligned && exec5Trigger && st5.mss) {
    structurePts = Math.round(w.marketStructure * 0.75);
  } else if (bias1hAligned) {
    structurePts = Math.round(w.marketStructure * 0.5);
  } else if (exec5Trigger) {
    structurePts = Math.round(w.marketStructure * 0.45);
  }

  // 2. Validasi Liquidity Sweep 15m (Syarat Wajib #2)
  let sweepPts = 0;
  let sweepReason = "";
  const sweep = liq15.recentSweep;
  const hasSweep15m = Boolean(
    (sweep && sweep.side === side && sweep.barsAgo <= 10) ||
    (pd15.judasSwing && ((isBuy && pd15.judasSwing.type === "BULLISH_JUDAS_SWING") || (!isBuy && pd15.judasSwing.type === "BEARISH_JUDAS_SWING")))
  );
  if (sweep && sweep.side === side && sweep.barsAgo <= 10) {
    sweepPts = sweep.barsAgo <= 4 ? w.liquiditySweep : Math.round(w.liquiditySweep * 0.8);
    sweepReason = `Validasi 15m: Liquidity Sweep ${sweep.type} di $${sweep.levelPrice} (${sweep.barsAgo} bar lalu)`;
  } else if (hasSweep15m) {
    sweepPts = w.liquiditySweep;
    sweepReason = `Validasi 15m: Judas Swing ${pd15.judasSwing.session} menyapu likuiditas`;
  }

  // 3. Validasi POI 15m: FVG / Order Block / Breaker (Syarat Wajib #3)
  let zonePts = 0;
  let poi15Reason = "";
  const activeFvg15 = isBuy ? fvg15.activeBullish : fvg15.activeBearish;
  const activeOb15 = isBuy ? ob15.activeBullish : ob15.activeBearish;
  const activeFvg5 = isBuy ? fvg5.activeBullish : fvg5.activeBearish;
  const activeOb5 = isBuy ? ob5.activeBullish : ob5.activeBearish;
  const breaker = pd15.breakerBlock && pd15.breakerBlock.side === side ? pd15.breakerBlock : null;

  const has15Poi = Boolean((activeFvg15 && (activeFvg15.priceInside || activeFvg15.touched)) || (activeOb15 && (activeOb15.priceInside || activeOb15.retested)));
  const has5Poi = Boolean((activeFvg5 && (activeFvg5.priceInside || activeFvg5.touched)) || (activeOb5 && (activeOb5.priceInside || activeOb5.retested)));
  const hasPoi15m = Boolean(has15Poi || breaker);

  if (has15Poi && has5Poi) {
    zonePts = w.fvgOrderBlock;
    const label15 = activeFvg15 && (activeFvg15.priceInside || activeFvg15.touched) ? `${activeFvg15.type} 15m` : `${activeOb15.type} 15m`;
    poi15Reason = `Validasi POI ${label15}`;
  } else if (has15Poi) {
    zonePts = Math.round(w.fvgOrderBlock * 0.85);
    const label15 = activeFvg15 && (activeFvg15.priceInside || activeFvg15.touched) ? `${activeFvg15.type} 15m` : `${activeOb15.type} 15m`;
    poi15Reason = `Validasi POI ${label15}`;
  } else if (breaker) {
    zonePts = Math.round(w.fvgOrderBlock * 0.8);
    poi15Reason = `Validasi POI ${breaker.type} 15m`;
  } else if (has5Poi) {
    zonePts = Math.round(w.fvgOrderBlock * 0.75);
  }

  // 4. Displacement 5m (Pendukung Eksekusi)
  let dispPts = 0;
  const dispMatch = disp5.detected && ((isBuy && disp5.direction === "BULLISH") || (!isBuy && disp5.direction === "BEARISH"));
  if (dispMatch && disp5.recent.barsAgo <= 6) {
    dispPts = disp5.recent.createdFvg ? w.displacement : Math.round(w.displacement * 0.8);
  }

  // 5. Positif VD MTF Penuh: 1h + 15m + 5m (Syarat Wajib #4)
  let vdPts = 0;
  let vdPenalty = 0;
  const vd1hOk = isVdAligned(of1h, isBuy);
  const vd15Ok = isVdAligned(of15, isBuy);
  const vd5Ok = isVdAligned(of5, isBuy);
  const hasFullMtfVd = Boolean(vd1hOk && vd15Ok && vd5Ok);

  if (hasFullMtfVd) {
    vdPts = w.volumeDelta;
  } else if (vd1hOk && (vd15Ok || vd5Ok)) {
    vdPts = Math.round(w.volumeDelta * 0.85);
  } else if (vd1hOk) {
    vdPts = Math.round(w.volumeDelta * 0.6);
  } else if (vd15Ok && vd5Ok) {
    vdPts = Math.round(w.volumeDelta * 0.55);
  }

  if (isVdOpposing(of1h, isBuy) && (of1h.isExtreme || of1h.isSpike)) vdPenalty += 12;
  if (isVdOpposing(of5, isBuy) && of5.isExtreme) vdPenalty += 6;

  // 6. CVD 1h Searah Tren Utama (Syarat Wajib #5)
  let cvdPts = 0;
  const cvd1hAligned = Boolean(of1h && of1h.valid && ((isBuy && of1h.cvdDirection === "BULLISH") || (!isBuy && of1h.cvdDirection === "BEARISH")));
  const divMatch = (of15?.divergence && of15.divergence.side === side) || (of5?.divergence && of5.divergence.side === side);
  const absMatch = (of15?.absorption && of15.absorption.side === side) || (of5?.absorption && of5.absorption.side === side);

  if (cvd1hAligned && (divMatch || absMatch)) {
    cvdPts = w.cvdDivergence;
  } else if (cvd1hAligned) {
    cvdPts = Math.round(w.cvdDivergence * 0.7);
  } else if (divMatch || absMatch) {
    cvdPts = Math.round(w.cvdDivergence * 0.6);
  }

  // 7. Validasi 15m: Premium/Discount Zone & Fibonacci OTE 0.62-0.79 (Syarat Wajib #6 & #7)
  let contextBonus = 0;
  const hasZone15m = isBuy ? pd15.dealingRange.zone === "DISCOUNT" : pd15.dealingRange.zone === "PREMIUM";
  const hasOte15m = Boolean((isBuy && pd15.ote.inBullishOte) || (!isBuy && pd15.ote.inBearishOte));
  if (hasZone15m) contextBonus += 3;
  if (hasOte15m) contextBonus += 3;

  const missingConfluence = [];
  if (!exec5Trigger) missingConfluence.push("Trigger struktur mikro 5m");
  if (!hasSweep15m) missingConfluence.push("Validasi 15m Liquidity Sweep");
  if (!hasPoi15m) missingConfluence.push("Validasi POI FVG/OB 15m");
  if (!hasFullMtfVd || vdPenalty > 0) missingConfluence.push("Positif VD MTF penuh (1h+15m+5m)");
  if (!cvd1hAligned) missingConfluence.push("CVD 1h searah tren utama");
  if (!hasZone15m) missingConfluence.push(isBuy ? "Validasi 15m Discount Zone" : "Validasi 15m Premium Zone");
  if (!hasOte15m) missingConfluence.push("Validasi 15m Area Fibonacci OTE (0.62–0.79)");

  const strict7Confluence = missingConfluence.length === 0;
  const reasons = strict7Confluence
    ? [
        `Trigger struktur mikro 5m (${trigger5mLabel})`,
        sweepReason,
        poi15Reason,
        `Positif VD MTF penuh: 1h (${of1h.deltaPct}%) + 15m (${of15.deltaPct}%) + 5m (${of5.deltaPct}%)`,
        `CVD 1h ${of1h.cvdSlope} searah tren utama`,
        `Validasi 15m: ${isBuy ? "Discount" : "Premium"} Zone (${pd15.dealingRange.rangePct}%)`,
        "Validasi 15m: Area Fibonacci OTE (0.62–0.79)"
      ]
    : [`Belum lengkap 7 syarat konfluensi: kurang ${missingConfluence.join(", ")}`];

  const rawTotal = structurePts + sweepPts + zonePts + dispPts + vdPts + cvdPts + contextBonus - vdPenalty;
  const totalScore = Math.max(0, Math.min(100, Math.round(rawTotal)));
  const isCountertrend = !bias1hAligned && exec5Trigger;

  return {
    side,
    totalScore,
    category: strict7Confluence ? classifyScore(totalScore, cfg.thresholds) : "WAIT",
    isCountertrend,
    strict7Confluence,
    missingConfluence,
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
      strict7Confluence: false,
      reason: "DATA_UNAVAILABLE: Data Volume Delta tidak tersedia.",
      reasons: ["DATA_UNAVAILABLE: Menunggu data kline & Volume Delta."],
      buyEval: null,
      sellEval: null
    };
  }

  const buyEval = scoreDirectionalSide("BUY", ctx, cfg);
  const sellEval = scoreDirectionalSide("SELL", ctx, cfg);

  const best = buyEval.strict7Confluence && !sellEval.strict7Confluence
    ? buyEval
    : (sellEval.strict7Confluence && !buyEval.strict7Confluence
        ? sellEval
        : (buyEval.totalScore >= sellEval.totalScore ? buyEval : sellEval));

  const minActionableScore = Math.max(cfg.thresholds.validSetup, 75);
  const isActionable = best.strict7Confluence && best.totalScore >= minActionableScore && primaryOf.dataQuality === "VALID";

  const signal = isActionable ? best.side : "WAIT";
  const summaryReason = best.strict7Confluence
    ? best.reasons.join(" | ")
    : (best.reasons[0] || "Menunggu 7 konfluensi wajib ICT + Volume Delta.");

  return {
    signal,
    category: isActionable ? best.category : "WAIT",
    score: best.totalScore,
    isCountertrend: best.isCountertrend,
    strict7Confluence: best.strict7Confluence,
    missingConfluence: best.missingConfluence,
    breakdown: best.breakdown,
    reason: summaryReason,
    reasons: best.reasons,
    buyEval,
    sellEval
  };
}

module.exports = { classifyScore, scoreDirectionalSide, evaluateSignalScore };
