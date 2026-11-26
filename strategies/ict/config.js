"use strict";

const DEFAULT_ICT_CONFIG = {
  strategyId: "ICT_SMC_VD_EXPERT",
  strategyLabel: "ICT + SMC + Volume Delta Expert",
  timeframes: {
    bias: "1h",
    setup: "15m",
    entry: "5m"
  },
  weights: {
    marketStructure: 20,
    liquiditySweep: 20,
    fvgOrderBlock: 15,
    displacement: 15,
    volumeDelta: 20,
    cvdDivergence: 10
  },
  thresholds: {
    strongSetup: 85,
    validSetup: 70,
    watchlist: 55
  },
  swing: {
    leftBars: 3,
    rightBars: 2
  },
  liquidity: {
    eqTolerancePct: 0.0015,
    maxSweepAgeBars: 12
  },
  displacement: {
    minBodyToRange: 0.62,
    minBodyToAvgMult: 1.75,
    minAtrMult: 1.15
  },
  fvg: {
    minWidthAtrMult: 0.12,
    maxActiveZones: 6
  },
  orderBlock: {
    maxActiveZones: 6
  },
  ote: {
    levels: [0.62, 0.705, 0.79],
    tolerancePct: 0.0025
  },
  volumeDelta: {
    lookbackBars: 20,
    spikeMult: 2.0,
    extremeMult: 2.8,
    imbalanceBuyPct: 63,
    imbalanceSellPct: 37,
    absorptionMinDeltaPct: 22,
    absorptionMaxPriceMoveAtr: 0.45,
    divergenceLookbackBars: 25
  },
  risk: {
    riskPerTradePct: 0.5,
    maxConcurrentPositions: 2,
    dailyMaxLossPct: 2.0,
    minRR: 1.5,
    tp1RR: 1.5,
    tp2RR: 2.5,
    atrSlBufferMult: 0.35,
    feePctRoundTrip: 0.001,
    slippagePct: 0.0005,
    fundingBufferPct: 0.0002
  },
  ws: {
    maxWatchlistSymbols: 25,
    reconnectBaseMs: 1500,
    reconnectMaxMs: 30000
  }
};

function mergeConfig(custom = {}) {
  return {
    ...DEFAULT_ICT_CONFIG,
    ...custom,
    timeframes: { ...DEFAULT_ICT_CONFIG.timeframes, ...(custom.timeframes || {}) },
    weights: { ...DEFAULT_ICT_CONFIG.weights, ...(custom.weights || {}) },
    thresholds: { ...DEFAULT_ICT_CONFIG.thresholds, ...(custom.thresholds || {}) },
    swing: { ...DEFAULT_ICT_CONFIG.swing, ...(custom.swing || {}) },
    liquidity: { ...DEFAULT_ICT_CONFIG.liquidity, ...(custom.liquidity || {}) },
    displacement: { ...DEFAULT_ICT_CONFIG.displacement, ...(custom.displacement || {}) },
    fvg: { ...DEFAULT_ICT_CONFIG.fvg, ...(custom.fvg || {}) },
    orderBlock: { ...DEFAULT_ICT_CONFIG.orderBlock, ...(custom.orderBlock || {}) },
    ote: { ...DEFAULT_ICT_CONFIG.ote, ...(custom.ote || {}) },
    volumeDelta: { ...DEFAULT_ICT_CONFIG.volumeDelta, ...(custom.volumeDelta || {}) },
    risk: { ...DEFAULT_ICT_CONFIG.risk, ...(custom.risk || {}) },
    ws: { ...DEFAULT_ICT_CONFIG.ws, ...(custom.ws || {}) }
  };
}

module.exports = { DEFAULT_ICT_CONFIG, mergeConfig };
