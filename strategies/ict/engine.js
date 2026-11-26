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

function evaluateIctVolumeDeltaMTF({ symbol = "UNKNOWN", scannerId = "termux-live", candles1h, candles15m, candles5m, vdCandles1m, rawAggTrades1m, config = {} }) {
  const cfg = mergeConfig(config);

  if (!Array.isArray(candles15m) || candles15m.length < 25 || !Array.isArray(candles5m) || candles5m.length < 25) {
    return {
      ready: false,
      strategy: cfg.strategyId,
      symbol,
      signal: "WAIT",
      category: "WAIT",
      score: 0,
      dataQuality: "DATA_INCOMPLETE",
      reason: "Data candle 1h, 15m, atau 5m belum mencukupi untuk analisis ICT + VD."
    };
  }

  const has1h = Array.isArray(candles1h) && candles1h.length >= 25;
  const st1h = has1h ? analyzeMarketStructure(candles1h, cfg.swing) : analyzeMarketStructure(candles15m, cfg.swing);
  const st15 = analyzeMarketStructure(candles15m, cfg.swing);
  const st5 = analyzeMarketStructure(candles5m, cfg.swing);

  const liq15 = analyzeLiquidity(candles15m, st15, cfg.liquidity);
  const fvg15 = analyzeFVG(candles15m, cfg.fvg);
  const ob15 = analyzeOrderBlocks(candles15m, st15, cfg.orderBlock);
  const ctx15 = analyzePremiumDiscountAndContext(candles15m, st15, ob15, liq15, cfg);

  const liq5 = analyzeLiquidity(candles5m, st5, cfg.liquidity);
  const fvg5 = analyzeFVG(candles5m, cfg.fvg);
  const ob5 = analyzeOrderBlocks(candles5m, st5, cfg.orderBlock);
  const disp5 = analyzeDisplacement(candles5m, cfg.displacement);
  const ctx5 = analyzePremiumDiscountAndContext(candles5m, st5, ob5, liq5, cfg);

  let resolvedLegacy1m = Array.isArray(vdCandles1m) ? vdCandles1m : [];
  let aggMeta = { dataQuality: "VALID", duplicateCount: 0, missingIdGaps: 0 };
  if (Array.isArray(rawAggTrades1m) && rawAggTrades1m.length > 0) {
    const agg = aggregateTradesToCandles(rawAggTrades1m, 60000);
    resolvedLegacy1m = agg.candles;
    aggMeta = { dataQuality: agg.dataQuality, duplicateCount: agg.duplicateCount, missingIdGaps: agg.missingIdGaps };
  }

  const of1h = has1h ? analyzeOrderFlow(candles1h, cfg.volumeDelta) : null;
  const of15 = analyzeOrderFlow(candles15m, cfg.volumeDelta);
  const of5 = analyzeOrderFlow(candles5m, cfg.volumeDelta);
  const ofLegacy1m = resolvedLegacy1m.length ? analyzeOrderFlow(resolvedLegacy1m, cfg.volumeDelta) : null;

  const activePrimaryOf = (of1h && of1h.valid) ? of1h : ((of15 && of15.valid) ? of15 : ofLegacy1m);
  const effectiveDataQuality = aggMeta.dataQuality !== "VALID"
    ? aggMeta.dataQuality
    : (activePrimaryOf ? activePrimaryOf.dataQuality : "DATA_INCOMPLETE");

  const scored = evaluateSignalScore({
    structure1h: st1h,
    structure15m: st15,
    structure5m: st5,
    liquidity15m: liq15,
    fvg15m: fvg15,
    orderBlocks15m: ob15,
    context15m: ctx15,
    liquidity5m: liq5,
    fvg5m: fvg5,
    orderBlocks5m: ob5,
    displacement5m: disp5,
    context5m: ctx5,
    orderFlow1h: of1h,
    orderFlow15m: of15,
    orderFlow5m: of5,
    orderFlow1m: ofLegacy1m || activePrimaryOf
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

  const tfTag = has1h ? "1h/15m/5m" : "15m/5m/1m";
  const signalId = `${scannerId}_${symbol}_5m_${last5m.time}_${cfg.strategyId}`;
  const vdMain = (of1h && of1h.valid) ? of1h : ((of15 && of15.valid) ? of15 : (ofLegacy1m || {}));

  return {
    ready: true,
    signalId,
    scannerId,
    strategy: cfg.strategyId,
    strategyLabel: cfg.strategyLabel,
    symbol,
    timeframe: tfTag,
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
      marketDirection1h: st1h.direction,
      marketDirection15m: st15.direction,
      marketStructure5m: st5.direction,
      structureLabel1h: st1h.lastStructureLabel,
      structureLabel15m: st15.lastStructureLabel,
      structureLabel5m: st5.lastStructureLabel,
      bos: st5.bos ? st5.bos.type : (st15.bos ? st15.bos.type : "NONE"),
      choch: st5.choch ? st5.choch.type : (st15.choch ? st15.choch.type : "NONE"),
      mss: st5.mss ? st5.mss.type : "NONE",
      liquidityStatus: liq15.recentSweep ? liq15.recentSweep.type : (liq5.recentSweep ? liq5.recentSweep.type : "NO_RECENT_SWEEP"),
      bsl: liq15.bsl || liq5.bsl,
      ssl: liq15.ssl || liq5.ssl,
      fvg: (activeSide === "BUY" ? (fvg15.activeBullish || fvg5.activeBullish) : (fvg15.activeBearish || fvg5.activeBearish))?.type || "NONE",
      orderBlock: (activeSide === "BUY" ? (ob15.activeBullish || ob5.activeBullish) : (ob15.activeBearish || ob5.activeBearish))?.type || "NONE",
      displacement: disp5.detected ? `${disp5.direction} (${disp5.recent.bodyToAtr}x ATR)` : "NONE",
      premiumDiscount: `${ctx15.dealingRange.zone} (${ctx15.dealingRange.rangePct}%)`,
      breakerBlock: ctx15.breakerBlock ? ctx15.breakerBlock.type : "NONE",
      oteAligned: activeSide === "BUY" ? ctx15.ote.inBullishOte : ctx15.ote.inBearishOte,
      session: ctx5.sessionInfo.session,
      judasSwing: ctx15.judasSwing ? ctx15.judasSwing.type : "NONE"
    },
    volumeDeltaEvidence: {
      delta: vdMain.delta ?? 0,
      deltaPct: vdMain.deltaPct ?? 0,
      buyVolume: vdMain.buyVolume ?? 0,
      sellVolume: vdMain.sellVolume ?? 0,
      deltaRatio: vdMain.deltaRatio ?? 0,
      imbalance: vdMain.imbalance || "NONE",
      cvd: vdMain.cvd ?? 0,
      cvdDirection: vdMain.cvdDirection || "NEUTRAL",
      cvdSlope: vdMain.cvdSlope || "FLAT",
      divergence: (of15?.divergence?.type || of5?.divergence?.type || vdMain.divergence?.type || "NONE"),
      absorption: (of15?.absorption?.type || of5?.absorption?.type || vdMain.absorption?.type || "NONE"),
      vd1h: of1h && of1h.valid ? { direction: of1h.direction, deltaPct: of1h.deltaPct, buyPct: of1h.buyPct, cvdDirection: of1h.cvdDirection } : null,
      vd15m: of15 && of15.valid ? { direction: of15.direction, deltaPct: of15.deltaPct, buyPct: of15.buyPct, cvdDirection: of15.cvdDirection } : null,
      vd5m: of5 && of5.valid ? { direction: of5.direction, deltaPct: of5.deltaPct, buyPct: of5.buyPct, cvdDirection: of5.cvdDirection } : null
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
