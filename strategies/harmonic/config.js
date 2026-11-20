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
      dXa: [1.27, 1.618],
      dBc: [1.618, 2.618],
      dXc: null
    },
    CRAB: {
      enabled: true,
      label: "Crab",
      beyondX: true,
      bRange: [0.382, 0.618],
      cRange: [0.382, 0.886],
      dXa: [1.618, 1.618],
      dBc: [2.24, 3.618],
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
      label: "Cypher",
      enabled: true,
      bMin: 0.382, bMax: 0.618,
      cMin: 1.13,  cMax: 1.414,
      dXaMin: 0.786, dXaMax: 0.786,
      dBcMin: 1.272, dBcMax: 2.0
    },
    SHARK: {
      label: "Shark",
      enabled: true,
      bMin: 0.382, bMax: 0.618,
      cMin: 1.13,  cMax: 1.618,
      dXaMin: 0.886, dXaMax: 1.13,
      dBcMin: 1.618, dBcMax: 2.24
    },
    FIVE_O: {
      label: "5-0",
      enabled: true,
      bMin: 1.13,  bMax: 1.618,
      cMin: 1.618, cMax: 2.24,
      dXaMin: 0.50,  dXaMax: 0.50,
      dBcMin: 0.50,  dBcMax: 0.50
    },
    RECIPROCAL_ABCD: {
      label: "Reciprocal AB=CD",
      enabled: true,
      bMin: 0.382, bMax: 0.886,
      cMin: 1.13,  cMax: 2.618,
      dXaMin: 0.618, dXaMax: 1.272,
      dBcMin: 1.00,  dBcMax: 1.618
    },
    ALTERNATE_ABCD: {
      label: "Alternate AB=CD",
      enabled: true,
      bMin: 0.382, bMax: 0.786,
      cMin: 1.13,  cMax: 1.618,
      dXaMin: 1.272, dXaMax: 1.618,
      dBcMin: 1.272, dBcMax: 2.00
    }
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    paperTrading: true,
    timeframes: ["4h", "1h", "15m"], // urutan wajib: 4h -> 1h -> 15m
    ratioTolerance: 0.035,            // ±3% standar Scott Carney
    swingDepth: 2,
    minDeviationPct: 0.15,
    atrPeriod: 14,
    minLegAtrMult: 0.35,
    minPrzConfluence: 3,
    maxPrzWidthAtrMult: 2.2,
    maxPrzWidthPct: 3.5,
    minPrzScore: 45,
    rsiPeriod: 14,
    rsiOversold: 42,
    rsiOverbought: 58,
    rsiMode: "both",                 // "level" | "divergence" | "both"
    requireReversalCandle: false,
    slAtrBufferMult: 0.35,
    tp1Fib: 0.382,
    tp2Fib: 0.618,
    tp1CloseRatio: 0.5,
    minRR: 2.0,
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
