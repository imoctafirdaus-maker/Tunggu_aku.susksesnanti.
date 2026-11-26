"use strict";

function classifyScore(score, thresholds) {
  if (score >= thresholds.strongSetup) return "STRONG_SETUP";
  if (score >= thresholds.validSetup) return "VALID_SETUP";
  if (score >= thresholds.watchlist) return "WATCHLIST";
  return "WAIT";
}

function scoreDirectionalSide(side, ctx, cfg) {
  const isBuy = side === "BUY";
  const w = cfg.weights;
  const reasons = [];

  const st15 = ctx.structure15m;
  const st5 = ctx.structure5m;
  const liq5 = ctx.liquidity5m;
  const fvg5 = ctx.fvg5m;
  const ob5 = ctx.orderBlocks5m;
  const disp5 = ctx.displacement5m;
  const pd5 = ctx.context5m;
  const of1 = ctx.orderFlow1m;

  // 1. Market Structure (max 20)
  let structurePts = 0;
  const biasAligned = isBuy ? st15.direction === "BULLISH" : st15.direction === "BEARISH";
  const setupBos = isBuy
    ? (st5.bos?.type === "BULLISH_BOS" || st5.choch?.type === "BULLISH_CHOCH" || st5.mss?.type === "BULLISH_MSS")
    : (st5.bos?.type === "BEARISH_BOS" || st5.choch?.type === "BEARISH_CHOCH" || st5.mss?.type === "BEARISH_MSS");

  if (biasAligned && setupBos) {
    structurePts = w.marketStructure;
    reasons.push(`Struktur 15m ${st15.direction} selaras dengan ${st5.lastEvent?.type || "BOS/CHoCH"} 5m`);
  } else if (setupBos && st5.mss) {
    structurePts = Math.round(w.marketStructure * 0.8);
    reasons.push(`MSS Countertrend terkonfirmasi di 5m (${st5.mss.type})`);
  } else if (biasAligned) {
    structurePts = Math.round(w.marketStructure * 0.55);
    reasons.push(`Bias struktur 15m ${st15.direction}`);
  } else if (setupBos) {
    structurePts = Math.round(w.marketStructure * 0.5);
    reasons.push(`Pergeseran struktur 5m (${st5.lastEvent?.type})`);
  }

  // 2. Liquidity Sweep (max 20)
  let sweepPts = 0;
  const sweep = liq5.recentSweep;
  if (sweep && sweep.side === side && sweep.barsAgo <= 8) {
    sweepPts = sweep.barsAgo <= 3 ? w.liquiditySweep : Math.round(w.liquiditySweep * 0.8);
    reasons.push(`Liquidity Sweep ${sweep.type} pada $${sweep.levelPrice} (${sweep.barsAgo} bar lalu)`);
  } else if (pd5.judasSwing && ((isBuy && pd5.judasSwing.type === "BULLISH_JUDAS_SWING") || (!isBuy && pd5.judasSwing.type === "BEARISH_JUDAS_SWING"))) {
    sweepPts = w.liquiditySweep;
    reasons.push(`Judas Swing ${pd5.judasSwing.session} menyapu likuiditas`);
  }

  // 3. FVG / Order Block / Breaker + Correlation Damping (max 15)
  let zonePts = 0;
  const activeFvg = isBuy ? fvg5.activeBullish : fvg5.activeBearish;
  const activeOb = isBuy ? ob5.activeBullish : ob5.activeBearish;
  const breaker = pd5.breakerBlock && pd5.breakerBlock.side === side ? pd5.breakerBlock : null;

  const hasFvgTouch = Boolean(activeFvg && (activeFvg.priceInside || activeFvg.touched));
  const hasObTouch = Boolean(activeOb && (activeOb.priceInside || activeOb.retested));

  if (hasFvgTouch && hasObTouch) {
    // Correlation damping: FVG & OB from the same impulse are correlated, so cap at 100% weight instead of doubling
    zonePts = w.fvgOrderBlock;
    reasons.push(`Konfluensi FVG (${activeFvg.status}) + Order Block (${activeOb.status})`);
  } else if (hasFvgTouch) {
    zonePts = Math.round(w.fvgOrderBlock * (activeFvg.hasDisplacement ? 0.9 : 0.75));
    reasons.push(`Harga merespons ${activeFvg.type} (CE $${activeFvg.ce.toFixed(4)})`);
  } else if (hasObTouch) {
    zonePts = Math.round(w.fvgOrderBlock * (activeOb.causedStructureShift ? 0.9 : 0.75));
    reasons.push(`Retest ${activeOb.type}`);
  } else if (breaker) {
    zonePts = Math.round(w.fvgOrderBlock * 0.8);
    reasons.push(`Konfirmasi ${breaker.type}`);
  }

  // 4. Displacement (max 15)
  let dispPts = 0;
  const dispMatch = disp5.detected && ((isBuy && disp5.direction === "BULLISH") || (!isBuy && disp5.direction === "BEARISH"));
  if (dispMatch && disp5.recent.barsAgo <= 6) {
    dispPts = disp5.recent.createdFvg ? w.displacement : Math.round(w.displacement * 0.8);
    reasons.push(`Displacement ${disp5.direction} (${disp5.recent.bodyToAtr}x ATR, body ${(disp5.recent.bodyToRange * 100).toFixed(0)}%)`);
  }

  // 5. True Volume Delta 1m (max 20, non-blocking when neutral, penalized when strongly opposing)
  let vdPts = 0;
  let vdPenalty = 0;
  if (of1.valid) {
    const vdAligned = (isBuy && of1.direction === "BULLISH") || (!isBuy && of1.direction === "BEARISH");
    const vdOpposing = (isBuy && of1.direction === "BEARISH") || (!isBuy && of1.direction === "BULLISH");

    if (vdAligned) {
      if (of1.isExtreme || of1.imbalance !== "NONE") {
        vdPts = w.volumeDelta;
        reasons.push(`True VD ${of1.direction} kuat (${of1.deltaRatio}x avg · Buy ${of1.buyPct}%)`);
      } else if (of1.isSpike) {
        vdPts = Math.round(w.volumeDelta * 0.85);
        reasons.push(`Lonjakan True VD ${of1.direction} (${of1.deltaRatio}x avg)`);
      } else {
        vdPts = Math.round(w.volumeDelta * 0.55);
        reasons.push(`Aliran True VD positif searah (${of1.deltaPct}%)`);
      }
    } else if (vdOpposing && of1.isExtreme) {
      vdPenalty = 15;
      reasons.push(`Penalti: Tekanan True VD berlawanan ekstrem (${of1.deltaRatio}x avg)`);
    } else if (vdOpposing && of1.isSpike) {
      vdPenalty = 8;
      reasons.push(`Peringatan: Lonjakan VD berlawanan (${of1.deltaRatio}x avg)`);
    }
  }

  // 6. CVD Trend, Divergence & Absorption (max 10)
  let cvdPts = 0;
  if (of1.valid) {
    const divMatch = of1.divergence && of1.divergence.side === side;
    const absMatch = of1.absorption && of1.absorption.side === side;
    const cvdAligned = (isBuy && of1.cvdDirection === "BULLISH") || (!isBuy && of1.cvdDirection === "BEARISH");

    if (divMatch || absMatch) {
      cvdPts = w.cvdDivergence;
      if (divMatch) reasons.push(`Divergensi ${of1.divergence.type} terkonfirmasi`);
      if (absMatch) reasons.push(`Indikasi ${of1.absorption.type} (${of1.absorption.deltaPct}%)`);
    } else if (cvdAligned) {
      cvdPts = Math.round(w.cvdDivergence * 0.65);
      reasons.push(`CVD ${of1.cvdSlope} searah tren`);
    }
  }

  // Contextual Bonus (Premium/Discount & OTE — non-mandatory)
  let contextBonus = 0;
  if (isBuy && pd5.dealingRange.zone === "DISCOUNT") {
    contextBonus += 3;
    reasons.push(`Harga di Discount Zone (${pd5.dealingRange.rangePct}%)`);
  } else if (!isBuy && pd5.dealingRange.zone === "PREMIUM") {
    contextBonus += 3;
    reasons.push(`Harga di Premium Zone (${pd5.dealingRange.rangePct}%)`);
  }
  if ((isBuy && pd5.ote.inBullishOte) || (!isBuy && pd5.ote.inBearishOte)) {
    contextBonus += 3;
    reasons.push(`Berada di area Fibonacci OTE (0.62–0.79)`);
  }

  const rawTotal = structurePts + sweepPts + zonePts + dispPts + vdPts + cvdPts + contextBonus - vdPenalty;
  const totalScore = Math.max(0, Math.min(100, Math.round(rawTotal)));
  const isCountertrend = !biasAligned && setupBos;

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
  if (!ctx.orderFlow1m || ctx.orderFlow1m.dataQuality === "DATA_UNAVAILABLE") {
    return {
      signal: "WAIT",
      category: "WAIT",
      score: 0,
      isCountertrend: false,
      reason: "DATA_UNAVAILABLE: Data transaksi aggTrade Volume Delta tidak tersedia.",
      reasons: ["DATA_UNAVAILABLE: Menunggu stream aggTrade Binance Futures."],
      buyEval: null,
      sellEval: null
    };
  }

  const buyEval = scoreDirectionalSide("BUY", ctx, cfg);
  const sellEval = scoreDirectionalSide("SELL", ctx, cfg);

  const best = buyEval.totalScore >= sellEval.totalScore ? buyEval : sellEval;
  const other = best.side === "BUY" ? sellEval : buyEval;

  // Avoid ambiguous market when both sides conflict closely
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

  // Countertrend setups require VALID_SETUP (>= 70)
  const minActionableScore = best.isCountertrend ? Math.max(cfg.thresholds.validSetup, 72) : cfg.thresholds.validSetup;
  const isActionable = best.totalScore >= minActionableScore && ctx.orderFlow1m.dataQuality === "VALID";

  const signal = isActionable ? best.side : "WAIT";
  const summaryReason = best.reasons.length
    ? best.reasons.slice(0, 3).join(" • ")
    : "Belum ada konfluensi struktur ICT & Volume Delta yang memadai.";

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
