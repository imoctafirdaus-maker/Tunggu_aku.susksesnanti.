"use strict";

const { DEFAULT_ICT_CONFIG, mergeConfig } = require("./config");
const { analyzeMarketStructure } = require("./structure");
const { analyzeLiquidity } = require("./liquidity");
const { analyzeFVG } = require("./fvg");
const { analyzeOrderBlocks } = require("./orderBlock");
const { analyzeDisplacement } = require("./displacement");
const { analyzePremiumDiscountAndContext } = require("./premiumDiscount");
const { aggregateTradesToCandles, analyzeOrderFlow } = require("./volumeDeltaEngine");
const { evaluateSignalScore } = require("./scoringEngine");
const { buildTradePlan, validateRiskGuards } = require("./riskManager");
const { runIctBacktest } = require("./backtester");

function evaluateIctVolumeDeltaMTF({ symbol = "UNKNOWN", scannerId = "termux-live", candles15m, candles5m, vdCandles1m, rawAggTrades1m, config = {} }) {
  const cfg = mergeConfig(config);

  let resolvedVd1m = Array.isArray(vdCandles1m) ? vdCandles1m : [];
  let aggMeta = { dataQuality: resolvedVd1m.length ? "VALID" : "DATA_UNAVAILABLE", duplicateCount: 0, missingIdGaps: 0 };

  if (Array.isArray(rawAggTrades1m) && rawAggTrades1m.length > 0) {
    const agg = aggregateTradesToCandles(rawAggTrades1m, 60000);
    resolvedVd1m = agg.candles;
    aggMeta = {
      dataQuality: agg.dataQuality,
      duplicateCount: agg.duplicateCount,
      missingIdGaps: agg.missingIdGaps
    };
  }

  if (!Array.isArray(candles15m) || candles15m.length < 25 || !Array.isArray(candles5m) || candles5m.length < 25) {
    return {
      ready: false,
      strategy: cfg.strategyId,
      symbol,
      signal: "WAIT",
      category: "WAIT",
      score: 0,
      dataQuality: "DATA_INCOMPLETE",
      reason: "Data candle 15m atau 5m belum mencukupi untuk analisis struktur ICT."
    };
  }

  const st15 = analyzeMarketStructure(candles15m, cfg.swing);
  const st5 = analyzeMarketStructure(candles5m, cfg.swing);
  const liq5 = analyzeLiquidity(candles5m, st5, cfg.liquidity);
  const fvg5 = analyzeFVG(candles5m, cfg.fvg);
  const ob5 = analyzeOrderBlocks(candles5m, st5, cfg.orderBlock);
  const disp5 = analyzeDisplacement(candles5m, cfg.displacement);
  const ctx5 = analyzePremiumDiscountAndContext(candles5m, st5, ob5, liq5, cfg);
  const of1 = analyzeOrderFlow(resolvedVd1m, cfg.volumeDelta);

  const effectiveDataQuality = aggMeta.dataQuality !== "VALID" ? aggMeta.dataQuality : of1.dataQuality;

  const scored = evaluateSignalScore({
    structure15m: st15,
    structure5m: st5,
    liquidity5m: liq5,
    fvg5m: fvg5,
    orderBlocks5m: ob5,
    displacement5m: disp5,
    context5m: ctx5,
    orderFlow1m: { ...of1, dataQuality: effectiveDataQuality }
  }, cfg);

  const last5m = candles5m[candles5m.length - 1];
  const activeSide = scored.signal === "SELL" ? "SELL" : (scored.signal === "BUY" ? "BUY" : (scored.buyEval && scored.sellEval && scored.sellEval.totalScore > scored.buyEval.totalScore ? "SELL" : "BUY"));

  const plan = buildTradePlan({
    side: activeSide,
    candles5m,
    structure5m: st5,
    liquidity5m: liq5,
    fvg5m: fvg5,
    orderBlocks5m: ob5,
    cfg
  });

  const signalId = `${scannerId}_${symbol}_5m_${last5m.time}_${cfg.strategyId}`;

  return {
    ready: true,
    signalId,
    scannerId,
    strategy: cfg.strategyId,
    strategyLabel: cfg.strategyLabel,
    symbol,
    timeframe: "15m/5m/1m",
    candleTime: last5m.time,
    updatedAt: Date.now(),
    signal: scored.signal,
    category: scored.category,
    score: scored.score,
    isCountertrend: scored.isCountertrend,
    dataQuality: effectiveDataQuality,
    reason: scored.reason,
    reasons: scored.reasons,
    breakdown: scored.breakdown,
    entryZone: plan.entryZone,
    entryPrice: scored.signal !== "WAIT" ? plan.entryPrice : null,
    stopLoss: scored.signal !== "WAIT" ? plan.stopLoss : null,
    takeProfit: scored.signal !== "WAIT" ? plan.takeProfit1 : null,
    takeProfit1: scored.signal !== "WAIT" ? plan.takeProfit1 : null,
    takeProfit2: scored.signal !== "WAIT" ? plan.takeProfit2 : null,
    riskReward: plan.netRR,
    grossRR: plan.grossRR,
    invalidation: plan.invalidation,
    ictEvidence: {
      marketDirection15m: st15.direction,
      marketStructure5m: st5.direction,
      structureLabel5m: st5.lastStructureLabel,
      bos: st5.bos ? st5.bos.type : "NONE",
      choch: st5.choch ? st5.choch.type : "NONE",
      mss: st5.mss ? st5.mss.type : "NONE",
      liquidityStatus: liq5.recentSweep ? liq5.recentSweep.type : "NO_RECENT_SWEEP",
      bsl: liq5.bsl,
      ssl: liq5.ssl,
      fvg: (activeSide === "BUY" ? fvg5.activeBullish : fvg5.activeBearish)?.type || "NONE",
      orderBlock: (activeSide === "BUY" ? ob5.activeBullish : ob5.activeBearish)?.type || "NONE",
      displacement: disp5.detected ? `${disp5.direction} (${disp5.recent.bodyToAtr}x ATR)` : "NONE",
      premiumDiscount: `${ctx5.dealingRange.zone} (${ctx5.dealingRange.rangePct}%)`,
      breakerBlock: ctx5.breakerBlock ? ctx5.breakerBlock.type : "NONE",
      oteAligned: activeSide === "BUY" ? ctx5.ote.inBullishOte : ctx5.ote.inBearishOte,
      session: ctx5.sessionInfo.session,
      judasSwing: ctx5.judasSwing ? ctx5.judasSwing.type : "NONE"
    },
    volumeDeltaEvidence: {
      delta: of1.delta,
      deltaPct: of1.deltaPct,
      buyVolume: of1.buyVolume,
      sellVolume: of1.sellVolume,
      deltaRatio: of1.deltaRatio,
      imbalance: of1.imbalance,
      cvd: of1.cvd,
      cvdDirection: of1.cvdDirection,
      cvdSlope: of1.cvdSlope,
      divergence: of1.divergence ? of1.divergence.type : "NONE",
      absorption: of1.absorption ? of1.absorption.type : "NONE"
    }
  };
}

module.exports = {
  DEFAULT_ICT_CONFIG,
  mergeConfig,
  evaluateIctVolumeDeltaMTF,
  validateRiskGuards,
  runIctBacktest
};
