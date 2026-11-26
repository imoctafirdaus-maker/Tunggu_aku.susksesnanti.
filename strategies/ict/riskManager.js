"use strict";

const { computeATR } = require("./structure");

function buildTradePlan({ side, candles5m, structure5m, liquidity5m, fvg5m, orderBlocks5m, cfg }) {
  const isBuy = side === "BUY";
  const n = candles5m.length;
  const lastBar = candles5m[n - 1];
  const entry = lastBar.close;
  const atrSeries = computeATR(candles5m, 14);
  const atr = Number.isFinite(atrSeries[n - 1]) ? atrSeries[n - 1] : Math.abs(lastBar.high - lastBar.low);
  const buffer = atr * (cfg.risk.atrSlBufferMult ?? 0.35);

  const sweep = liquidity5m?.recentSweep?.side === side ? liquidity5m.recentSweep : null;
  const activeFvg = isBuy ? fvg5m?.activeBullish : fvg5m?.activeBearish;
  const activeOb = isBuy ? orderBlocks5m?.activeBullish : orderBlocks5m?.activeBearish;

  let sl;
  let invalidationReason;

  if (isBuy) {
    const candidates = [
      sweep ? sweep.sweepExtreme - buffer : null,
      activeOb ? activeOb.bottom - buffer : null,
      activeFvg ? activeFvg.bottom - buffer : null,
      structure5m?.swingLow ? structure5m.swingLow.price - buffer : null
    ].filter(v => Number.isFinite(v) && v < entry);

    sl = candidates.length ? Math.max(...candidates) : (entry - atr * 1.5);
    // Prevent overly tight noise SL (< 0.4 ATR) or overly wide SL (> 3.0 ATR)
    sl = Math.min(sl, entry - atr * 0.45);
    sl = Math.max(sl, entry - atr * 3.0);
    invalidationReason = `Candle ditutup menembus level invalidasi bawah $${sl.toFixed(4)}`;
  } else {
    const candidates = [
      sweep ? sweep.sweepExtreme + buffer : null,
      activeOb ? activeOb.top + buffer : null,
      activeFvg ? activeFvg.top + buffer : null,
      structure5m?.swingHigh ? structure5m.swingHigh.price + buffer : null
    ].filter(v => Number.isFinite(v) && v > entry);

    sl = candidates.length ? Math.min(...candidates) : (entry + atr * 1.5);
    sl = Math.max(sl, entry + atr * 0.45);
    sl = Math.min(sl, entry + atr * 3.0);
    invalidationReason = `Candle ditutup menembus level invalidasi atas $${sl.toFixed(4)}`;
  }

  const riskDist = Math.abs(entry - sl);
  const totalFrictionPct = (cfg.risk.feePctRoundTrip || 0.001) + (cfg.risk.slippagePct || 0.0005) + (cfg.risk.fundingBufferPct || 0.0002);
  const frictionPrice = entry * totalFrictionPct;

  const tp1R = entry + (isBuy ? 1 : -1) * riskDist * (cfg.risk.tp1RR || 1.5);
  const tp2R = entry + (isBuy ? 1 : -1) * riskDist * (cfg.risk.tp2RR || 2.5);

  const oppTarget = liquidity5m?.nearestTarget?.price;
  let tp1 = tp1R;
  let tp2 = tp2R;

  if (Number.isFinite(oppTarget)) {
    if (isBuy && oppTarget > entry + riskDist * 1.2) {
      tp1 = Math.min(oppTarget, tp2R);
      tp2 = Math.max(oppTarget, tp2R);
    } else if (!isBuy && oppTarget < entry - riskDist * 1.2) {
      tp1 = Math.max(oppTarget, tp2R);
      tp2 = Math.min(oppTarget, tp2R);
    }
  }

  const rewardDist = Math.abs(tp1 - entry);
  const netRewardDist = rewardDist - frictionPrice;
  const grossRR = riskDist > 0 ? rewardDist / riskDist : 0;
  const netRR = riskDist > 0 ? netRewardDist / riskDist : 0;

  return {
    entryZone: activeFvg
      ? { low: activeFvg.bottom, high: activeFvg.top }
      : (activeOb ? { low: activeOb.bottom, high: activeOb.top } : { low: entry - atr * 0.15, high: entry + atr * 0.15 }),
    entryPrice: entry,
    stopLoss: sl,
    takeProfit1: tp1,
    takeProfit2: tp2,
    riskDistance: riskDist,
    riskPct: Number(((riskDist / Math.max(entry, 1e-9)) * 100).toFixed(3)),
    grossRR: Number(grossRR.toFixed(2)),
    netRR: Number(netRR.toFixed(2)),
    frictionPct: Number((totalFrictionPct * 100).toFixed(3)),
    feasibleAfterCosts: netRewardDist > 0 && netRR >= (cfg.risk.minRR || 1.2),
    invalidation: invalidationReason
  };
}

function validateRiskGuards({ accountEquity, riskPct, openPositionsCount, dailyPnlPct, dataQuality, setupKey, executedSetupKeys, plan, cfg }) {
  if (dataQuality !== "VALID") {
    return { allowed: false, reason: `Ditolak: Kualitas data pasar tidak valid (${dataQuality})` };
  }
  if (!plan || !Number.isFinite(plan.stopLoss) || plan.riskDistance <= 0) {
    return { allowed: false, reason: "Ditolak: Stop Loss struktural wajib tersedia" };
  }
  if (!plan.feasibleAfterCosts) {
    return { allowed: false, reason: `Ditolak: Net R:R (${plan.netRR}) di bawah batas minimum setelah fee & slippage` };
  }
  const maxPos = Math.min(2, cfg.risk.maxConcurrentPositions || 2);
  if (openPositionsCount >= maxPos) {
    return { allowed: false, reason: `Ditolak: Batas maksimum ${maxPos} posisi bersamaan tercapai` };
  }
  if (Number.isFinite(dailyPnlPct) && dailyPnlPct <= -(cfg.risk.dailyMaxLossPct || 2.0)) {
    return { allowed: false, reason: `Ditolak: Batas kerugian harian (${cfg.risk.dailyMaxLossPct}%) tercapai` };
  }
  if (executedSetupKeys && setupKey && executedSetupKeys.has(setupKey)) {
    return { allowed: false, reason: `Ditolak: Setup duplikat (${setupKey}) — dilarang entry berulang / averaging down` };
  }

  const effectiveRiskPct = Math.min(riskPct || cfg.risk.riskPerTradePct || 0.5, 1.0);
  const riskUsd = Math.max(0, (Number(accountEquity) || 0) * (effectiveRiskPct / 100));
  const positionQty = plan.riskDistance > 0 ? riskUsd / plan.riskDistance : 0;
  const notionalUsd = positionQty * plan.entryPrice;

  return {
    allowed: true,
    riskUsd: Number(riskUsd.toFixed(2)),
    positionQty,
    notionalUsd: Number(notionalUsd.toFixed(2))
  };
}

module.exports = { buildTradePlan, validateRiskGuards };
