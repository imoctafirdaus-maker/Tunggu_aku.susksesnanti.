"use strict";

const { mergeConfig } = require("./config");
const { analyzeMarketStructure } = require("./structure");
const { analyzeLiquidity } = require("./liquidity");
const { analyzeFVG } = require("./fvg");
const { analyzeOrderBlocks } = require("./orderBlock");
const { analyzeDisplacement } = require("./displacement");
const { analyzePremiumDiscountAndContext } = require("./premiumDiscount");
const { analyzeOrderFlow } = require("./volumeDeltaEngine");
const { evaluateSignalScore } = require("./scoringEngine");
const { buildTradePlan } = require("./riskManager");

function summarizeTrades(trades) {
  const n = trades.length;
  if (!n) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      grossProfitR: 0,
      grossLossR: 0,
      netProfitR: 0,
      profitFactor: 0,
      maxDrawdownR: 0,
      avgR: 0,
      expectancyR: 0,
      avgHoldingBars: 0,
      totalFeeR: 0,
      totalSlippageR: 0
    };
  }

  const wins = trades.filter(t => t.netR > 0);
  const losses = trades.filter(t => t.netR <= 0);
  const grossProfitR = wins.reduce((s, t) => s + t.grossR, 0);
  const grossLossR = Math.abs(losses.reduce((s, t) => s + t.grossR, 0));
  const netProfitR = trades.reduce((s, t) => s + t.netR, 0);
  const totalFeeR = trades.reduce((s, t) => s + t.feeR, 0);
  const totalSlippageR = trades.reduce((s, t) => s + t.slippageR, 0);
  const avgHoldingBars = trades.reduce((s, t) => s + t.holdingBars, 0) / n;

  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const t of trades) {
    equity += t.netR;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownR) maxDrawdownR = dd;
  }

  return {
    totalTrades: n,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: Number(((wins.length / n) * 100).toFixed(2)),
    grossProfitR: Number(grossProfitR.toFixed(2)),
    grossLossR: Number(grossLossR.toFixed(2)),
    netProfitR: Number(netProfitR.toFixed(2)),
    profitFactor: grossLossR > 0 ? Number((grossProfitR / grossLossR).toFixed(2)) : (grossProfitR > 0 ? 99 : 0),
    maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
    avgR: Number((netProfitR / n).toFixed(3)),
    expectancyR: Number((netProfitR / n).toFixed(3)),
    avgHoldingBars: Number(avgHoldingBars.toFixed(1)),
    totalFeeR: Number(totalFeeR.toFixed(2)),
    totalSlippageR: Number(totalSlippageR.toFixed(2))
  };
}

/**
 * Strict Zero-Lookahead Walk-Forward Backtester for ICT + SMC + True Volume Delta
 */
function runIctBacktest({ symbol = "BTCUSDT", candles15m, candles5m, vdCandles1m, config = {} }) {
  const cfg = mergeConfig(config);
  if (!Array.isArray(candles15m) || !Array.isArray(candles5m) || !Array.isArray(vdCandles1m)) {
    return { ok: false, reason: "Data multi-timeframe (15m, 5m, 1m VD) tidak lengkap" };
  }
  if (candles15m.length < 40 || candles5m.length < 50 || vdCandles1m.length < 60) {
    return { ok: false, reason: "Jumlah candle historis belum mencukupi untuk backtest walk-forward" };
  }

  const trades = [];
  let activeTrade = null;
  const usedSetupKeys = new Set();

  for (let i = 45; i < candles5m.length; i++) {
    const cur5m = candles5m[i];
    const cutoffTime = cur5m.closeTime || cur5m.time;

    // 1. Evaluate open trade on closed 5m bar
    if (activeTrade) {
      activeTrade.holdingBars += 1;
      const isBuy = activeTrade.side === "BUY";
      const hitSL = isBuy ? cur5m.low <= activeTrade.stopLoss : cur5m.high >= activeTrade.stopLoss;
      const hitTP = isBuy ? cur5m.high >= activeTrade.takeProfit1 : cur5m.low <= activeTrade.takeProfit1;

      if (hitSL || hitTP) {
        const outcome = hitSL ? "SL" : "TP1";
        const grossR = outcome === "TP1" ? activeTrade.grossRR : -1.0;
        const feeR = (activeTrade.entryPrice * cfg.risk.feePctRoundTrip) / activeTrade.riskDistance;
        const slippageR = (activeTrade.entryPrice * cfg.risk.slippagePct) / activeTrade.riskDistance;
        const netR = grossR - feeR - slippageR;

        trades.push({
          ...activeTrade,
          outcome,
          exitTime: cur5m.time,
          grossR,
          feeR,
          slippageR,
          netR
        });
        activeTrade = null;
      }
      continue;
    }

    // 2. Strict causal slice (only closed candles up to cutoffTime — zero future bars)
    const slice5m = candles5m.slice(Math.max(0, i - 120), i + 1);
    const slice15m = candles15m.filter(c => (c.closeTime || c.time) <= cutoffTime).slice(-120);
    const slice1m = vdCandles1m.filter(c => (c.closeTime || c.time) <= cutoffTime).slice(-90);

    if (slice15m.length < 25 || slice1m.length < 25) continue;

    const st15 = analyzeMarketStructure(slice15m, cfg.swing);
    const st5 = analyzeMarketStructure(slice5m, cfg.swing);
    const liq5 = analyzeLiquidity(slice5m, st5, cfg.liquidity);
    const fvg5 = analyzeFVG(slice5m, cfg.fvg);
    const ob5 = analyzeOrderBlocks(slice5m, st5, cfg.orderBlock);
    const disp5 = analyzeDisplacement(slice5m, cfg.displacement);
    const ctx5 = analyzePremiumDiscountAndContext(slice5m, st5, ob5, liq5, cfg);
    const of1 = analyzeOrderFlow(slice1m, cfg.volumeDelta);

    const scored = evaluateSignalScore({
      structure15m: st15,
      structure5m: st5,
      liquidity5m: liq5,
      fvg5m: fvg5,
      orderBlocks5m: ob5,
      displacement5m: disp5,
      context5m: ctx5,
      orderFlow1m: of1
    }, cfg);

    if (scored.signal === "BUY" || scored.signal === "SELL") {
      const setupKey = `${symbol}_${cur5m.time}_${scored.signal}`;
      if (usedSetupKeys.has(setupKey)) continue;

      const plan = buildTradePlan({
        side: scored.signal,
        candles5m: slice5m,
        structure5m: st5,
        liquidity5m: liq5,
        fvg5m: fvg5,
        orderBlocks5m: ob5,
        cfg
      });

      if (plan.feasibleAfterCosts) {
        usedSetupKeys.add(setupKey);
        activeTrade = {
          symbol,
          side: scored.signal,
          score: scored.score,
          isCountertrend: scored.isCountertrend,
          entryTime: cur5m.time,
          entryPrice: plan.entryPrice,
          stopLoss: plan.stopLoss,
          takeProfit1: plan.takeProfit1,
          takeProfit2: plan.takeProfit2,
          riskDistance: plan.riskDistance,
          grossRR: plan.grossRR,
          holdingBars: 0
        };
      }
    }
  }

  const splitIdx = Math.floor(trades.length * 0.7);
  return {
    ok: true,
    symbol,
    all: summarizeTrades(trades),
    long: summarizeTrades(trades.filter(t => t.side === "BUY")),
    short: summarizeTrades(trades.filter(t => t.side === "SELL")),
    inSample: summarizeTrades(trades.slice(0, splitIdx)),
    outOfSample: summarizeTrades(trades.slice(splitIdx)),
    sampleReady: trades.length >= 200,
    trades
  };
}

module.exports = { summarizeTrades, runIctBacktest };
