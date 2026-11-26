"use strict";

function getLocalHour(tsMs, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hour12: false
    }).formatToParts(new Date(tsMs));
    const hr = parts.find(p => p.type === "hour");
    return hr ? Number(hr.value) % 24 : new Date(tsMs).getUTCHours();
  } catch (_) {
    return new Date(tsMs).getUTCHours();
  }
}

function detectTradingSession(tsMs) {
  const utcDate = new Date(tsMs);
  const utcHour = utcDate.getUTCHours();
  const londonHour = getLocalHour(tsMs, "Europe/London");
  const nyHour = getLocalHour(tsMs, "America/New_York");

  const isLondon = londonHour >= 8 && londonHour < 16;
  const isNewYork = nyHour >= 8 && nyHour < 17;
  const isAsia = utcHour >= 0 && utcHour < 8;

  let session = "OFF_SESSION";
  if (isLondon && isNewYork) session = "LONDON_NY_OVERLAP";
  else if (isLondon) session = "LONDON";
  else if (isNewYork) session = "NEW_YORK";
  else if (isAsia) session = "ASIA";

  return {
    utcIso: utcDate.toISOString(),
    utcHour,
    londonHour,
    nyHour,
    session,
    isLondonKillzone: londonHour >= 7 && londonHour <= 10,
    isNyKillzone: nyHour >= 8 && nyHour <= 11
  };
}

function analyzePremiumDiscountAndContext(candles, structure, orderBlocks, liquidity, opts = {}) {
  const n = candles.length;
  const lastBar = candles[n - 1];
  const price = lastBar.close;

  // 1. Premium / Discount Dealing Range
  let rangeHigh = structure?.swingHigh?.price ?? Math.max(...candles.slice(-30).map(c => c.high));
  let rangeLow = structure?.swingLow?.price ?? Math.min(...candles.slice(-30).map(c => c.low));
  if (rangeHigh <= rangeLow) {
    rangeHigh = Math.max(...candles.slice(-20).map(c => c.high));
    rangeLow = Math.min(...candles.slice(-20).map(c => c.low));
  }
  const span = Math.max(rangeHigh - rangeLow, 1e-9);
  const equilibrium = rangeLow + span * 0.5;
  const rangePct = ((price - rangeLow) / span) * 100;
  const zone = rangePct < 48 ? "DISCOUNT" : (rangePct > 52 ? "PREMIUM" : "EQUILIBRIUM");

  // 2. Optimal Trade Entry (OTE: 0.62 - 0.705 - 0.79 retracement of impulse leg)
  const bullOteLow = rangeHigh - span * 0.79;
  const bullOteHigh = rangeHigh - span * 0.62;
  const bullOteSweet = rangeHigh - span * 0.705;

  const bearOteLow = rangeLow + span * 0.62;
  const bearOteHigh = rangeLow + span * 0.79;
  const bearOteSweet = rangeLow + span * 0.705;

  const inBullishOte = price >= bullOteLow && price <= bullOteHigh;
  const inBearishOte = price >= bearOteLow && price <= bearOteHigh;

  // 3. Breaker Block & Mitigation Block (requires structure shift context)
  let breakerBlock = null;
  let mitigationBlock = null;
  const allObs = orderBlocks?.allOrderBlocks || [];
  const hasBullShift = structure?.direction === "BULLISH" && Boolean(structure?.choch || structure?.mss || structure?.bos);
  const hasBearShift = structure?.direction === "BEARISH" && Boolean(structure?.choch || structure?.mss || structure?.bos);

  for (let i = allObs.length - 1; i >= 0; i--) {
    const ob = allObs[i];
    if (!ob.invalidated) continue;
    // Failed Bearish OB after bullish shift -> Bullish Breaker/Mitigation
    if (ob.side === "SELL" && hasBullShift && price >= ob.bottom) {
      const hadSweep = liquidity?.recentSweep?.side === "BUY";
      const targetObj = {
        type: hadSweep ? "BULLISH_BREAKER" : "BULLISH_MITIGATION",
        side: "BUY",
        top: ob.top,
        bottom: ob.bottom,
        timestamp: ob.timestamp
      };
      if (hadSweep && !breakerBlock) breakerBlock = targetObj;
      if (!hadSweep && !mitigationBlock) mitigationBlock = targetObj;
    }
    // Failed Bullish OB after bearish shift -> Bearish Breaker/Mitigation
    if (ob.side === "BUY" && hasBearShift && price <= ob.top) {
      const hadSweep = liquidity?.recentSweep?.side === "SELL";
      const targetObj = {
        type: hadSweep ? "BEARISH_BREAKER" : "BEARISH_MITIGATION",
        side: "SELL",
        top: ob.top,
        bottom: ob.bottom,
        timestamp: ob.timestamp
      };
      if (hadSweep && !breakerBlock) breakerBlock = targetObj;
      if (!hadSweep && !mitigationBlock) mitigationBlock = targetObj;
    }
  }

  // 4. Session & Contextual Judas Swing
  const sessionInfo = detectTradingSession(lastBar.time);
  let judasSwing = null;
  if ((sessionInfo.isLondonKillzone || sessionInfo.isNyKillzone) && liquidity?.recentSweep && structure?.mss) {
    if (liquidity.recentSweep.side === "BUY" && structure.mss.type === "BULLISH_MSS") {
      judasSwing = { type: "BULLISH_JUDAS_SWING", session: sessionInfo.session, sweepLevel: liquidity.recentSweep.levelPrice };
    } else if (liquidity.recentSweep.side === "SELL" && structure.mss.type === "BEARISH_MSS") {
      judasSwing = { type: "BEARISH_JUDAS_SWING", session: sessionInfo.session, sweepLevel: liquidity.recentSweep.levelPrice };
    }
  }

  return {
    dealingRange: {
      rangeHigh,
      rangeLow,
      equilibrium,
      rangePct: Number(rangePct.toFixed(1)),
      zone
    },
    ote: {
      inBullishOte,
      inBearishOte,
      bullishZone: { low: bullOteLow, sweet: bullOteSweet, high: bullOteHigh },
      bearishZone: { low: bearOteLow, sweet: bearOteSweet, high: bearOteHigh }
    },
    breakerBlock,
    mitigationBlock,
    sessionInfo,
    judasSwing
  };
}

module.exports = { getLocalHour, detectTradingSession, analyzePremiumDiscountAndContext };
