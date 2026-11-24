(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HarmonicConfig = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PATTERNS = {
    GARTLEY: {
      enabled: true,
      label: "Gartley",
      beyondX: false,
      bRange: [0.618, 0.618],
      cRange: [0.382, 0.886],
      dXa: [0.786, 0.786],
      dBc: [1.272, 1.618],
      dXc: null
    },
    BAT: {
      enabled: true,
      label: "Bat",
      beyondX: false,
      bRange: [0.382, 0.50],
      cRange: [0.382, 0.886],
      dXa: [0.886, 0.886],
      dBc: [1.618, 2.618],
      dXc: null
    },
    ALT_BAT: {
      enabled: true,
      label: "Alt Bat",
      beyondX: true,
      bRange: [0.382, 0.382],
      cRange: [0.382, 0.886],
      dXa: [1.13, 1.13],
      dBc: [2.0, 3.618],
      dXc: null
    },
    BUTTERFLY: {
      enabled: true,
      label: "Butterfly",
      beyondX: true,
      bRange: [0.786, 0.786],
      cRange: [0.382, 0.886],
      dXa: [1.272, 1.618],
      dBc: [1.618, 2.24],
      dXc: null
    },
    CRAB: {
      enabled: true,
      label: "Crab",
      beyondX: true,
      bRange: [0.382, 0.618],
      cRange: [0.382, 0.886],
      dXa: [1.618, 1.618],
      dBc: [2.618, 3.618],
      dXc: null
    },
    DEEP_CRAB: {
      enabled: true,
      label: "Deep Crab",
      beyondX: true,
      bRange: [0.886, 0.886],
      cRange: [0.382, 0.886],
      dXa: [1.618, 1.618],
      dBc: [2.0, 3.618],
      dXc: null
    },
    CYPHER: {
      enabled: true,
      label: "Cypher",
      beyondX: false,
      cIsXcExtension: true,
      bRange: [0.382, 0.618],
      cRange: [1.13, 1.414],
      dXa: null,
      dXc: [0.786, 0.786],
      dBc: [1.272, 2.0]
    },
    SHARK: {
      enabled: false,
      label: "Shark",
      beyondX: true,
      bRange: [0.382, 0.618],
      cRange: [1.13, 1.618],
      dXa: null,
      dXc: [0.886, 1.13],
      dBc: [1.618, 2.24]
    },
    FIVE_O: {
      enabled: true,
      label: "5-0",
      beyondX: true,
      bRange: [1.13, 1.618],
      cRange: [1.618, 2.24],
      dXa: null,
      dBc: [0.50, 0.50],
      dXc: null
    },
    RECIPROCAL_ABCD: {
      enabled: false,
      label: "Reciprocal AB=CD",
      beyondX: true,
      bRange: [0.382, 0.886],
      cRange: [1.13, 2.618],
      dXa: [0.618, 1.272],
      dBc: [1.00, 1.618],
      dXc: null
    },
    ALTERNATE_ABCD: {
      enabled: false,
      label: "Alternate AB=CD",
      beyondX: true,
      bRange: [0.382, 0.786],
      cRange: [1.13, 1.618],
      dXa: [1.272, 1.618],
      dBc: [1.272, 2.00],
      dXc: null
    }
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    paperTrading: true,
    timeframes: ["4h", "1h", "15m", "5m"], // urutan wajib: 4h -> 1h -> 15m
    ratioTolerance: 0.035,            // ±3.5% standar Scott Carney
    swingDepth: 2,
    minDeviationPct: 0.4,
    atrPeriod: 14,
    minLegAtrMult: 0.35,
    minPrzConfluence: 2,
    maxPrzWidthAtrMult: 1.5,
    maxPrzWidthPct: 1.0,
    minPrzScore: 55,
    rsiPeriod: 14,
    rsiOversold: 40,
    rsiOverbought: 60,
    rsiMode: "both",                 // "level" | "divergence" | "both"
    requireReversalCandle: true,
    slAtrBufferMult: 0.35,
    tp1Fib: 0.382,
    tp2Fib: 0.618,
    tp1CloseRatio: 0.5,
    vdEnabled: true,
    vdLookback: 20,
    vdStrongMult: 2.0,
    vdExhaustionMult: 2.2,
    extTp1Fib: 1.272,
    extTp2Fib: 1.618,
    minRR: 1.5,
    riskPerTradePct: 1.0,
    maxOpenPositions: 3,
    maxDailyDrawdownPct: 5.0,
    patterns: JSON.parse(JSON.stringify(PATTERNS))
  };

  function mergeSettings(custom) {
    const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!custom || typeof custom !== "object") return base;
    for (const k of Object.keys(custom)) {
      if (k === "patterns" && custom.patterns) {
        for (const pKey of Object.keys(custom.patterns)) {
          if (base.patterns[pKey]) {
            base.patterns[pKey] = Object.assign({}, base.patterns[pKey], custom.patterns[pKey]);
          }
        }
      } else if (custom[k] !== undefined) {
        base[k] = custom[k];
      }
    }
    return base;
  }

  return { PATTERNS, DEFAULT_SETTINGS, mergeSettings };
});
