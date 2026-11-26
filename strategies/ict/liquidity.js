"use strict";

function detectEqualLevels(swings, tolerancePct = 0.0015) {
  const clusters = [];
  for (let i = 1; i < swings.length; i++) {
    const prev = swings[i - 1];
    const cur = swings[i];
    const diffPct = Math.abs(cur.price - prev.price) / Math.max(prev.price, 1e-9);
    if (diffPct <= tolerancePct) {
      clusters.push({
        type: cur.type === "HIGH" ? "EQH" : "EQL",
        price: (cur.price + prev.price) / 2,
        firstTime: prev.time,
        secondTime: cur.time,
        firstIndex: prev.index,
        secondIndex: cur.index,
        confirmedAt: cur.confirmedAt
      });
    }
  }
  return clusters;
}

function analyzeLiquidity(candles, structure, opts = {}) {
  const tolPct = opts.eqTolerancePct ?? 0.0015;
  const maxSweepAge = opts.maxSweepAgeBars ?? 12;
  const n = candles.length;

  if (!structure || !structure.valid || n < 10) {
    return {
      valid: false,
      bsl: null,
      ssl: null,
      eqh: [],
      eql: [],
      previousSwingHigh: null,
      previousSwingLow: null,
      recentSweep: null,
      breakoutBeyondLiquidity: null,
      nearestTarget: null
    };
  }

  const lastBar = candles[n - 1];
  const price = lastBar.close;
  const eqh = detectEqualLevels(structure.swingHighs, tolPct);
  const eql = detectEqualLevels(structure.swingLows, tolPct);

  const prevHighs = structure.swingHighs.slice(-4);
  const prevLows = structure.swingLows.slice(-4);

  const bslCandidates = [
    ...prevHighs.map(h => ({ kind: "BSL_SWING", price: h.price, index: h.index, confirmedAt: h.confirmedAt, time: h.time })),
    ...eqh.slice(-2).map(e => ({ kind: "EQH", price: e.price, index: e.secondIndex, confirmedAt: e.confirmedAt, time: e.secondTime }))
  ];
  const sslCandidates = [
    ...prevLows.map(l => ({ kind: "SSL_SWING", price: l.price, index: l.index, confirmedAt: l.confirmedAt, time: l.time })),
    ...eql.slice(-2).map(e => ({ kind: "EQL", price: e.price, index: e.secondIndex, confirmedAt: e.confirmedAt, time: e.secondTime }))
  ];

  let recentSweep = null;
  let breakoutBeyondLiquidity = null;
  const scanStart = Math.max(1, n - maxSweepAge);

  for (let i = scanStart; i < n; i++) {
    const bar = candles[i];
    const body = Math.abs(bar.close - bar.open);

    // Bullish SSL Sweep: wick pierces below SSL, candle CLOSES back above SSL
    for (const lvl of sslCandidates) {
      if (i <= lvl.confirmedAt) continue;
      if (bar.low < lvl.price) {
        const lowerWick = Math.min(bar.open, bar.close) - bar.low;
        const pierceDepth = lvl.price - bar.low;
        if (bar.close > lvl.price && lowerWick >= pierceDepth * 0.6 && lowerWick > body * 0.25) {
          recentSweep = {
            type: "BULLISH_SSL_SWEEP",
            side: "BUY",
            levelKind: lvl.kind,
            levelPrice: lvl.price,
            sweepExtreme: bar.low,
            closePrice: bar.close,
            barIndex: i,
            barsAgo: n - 1 - i,
            timestamp: bar.time,
            swept: true
          };
        } else if (bar.close < lvl.price) {
          breakoutBeyondLiquidity = {
            type: "BEARISH_SSL_BREAKOUT",
            levelKind: lvl.kind,
            levelPrice: lvl.price,
            barIndex: i,
            timestamp: bar.time
          };
        }
      }
    }

    // Bearish BSL Sweep: wick pierces above BSL, candle CLOSES back below BSL
    for (const lvl of bslCandidates) {
      if (i <= lvl.confirmedAt) continue;
      if (bar.high > lvl.price) {
        const upperWick = bar.high - Math.max(bar.open, bar.close);
        const pierceDepth = bar.high - lvl.price;
        if (bar.close < lvl.price && upperWick >= pierceDepth * 0.6 && upperWick > body * 0.25) {
          recentSweep = {
            type: "BEARISH_BSL_SWEEP",
            side: "SELL",
            levelKind: lvl.kind,
            levelPrice: lvl.price,
            sweepExtreme: bar.high,
            closePrice: bar.close,
            barIndex: i,
            barsAgo: n - 1 - i,
            timestamp: bar.time,
            swept: true
          };
        } else if (bar.close > lvl.price) {
          breakoutBeyondLiquidity = {
            type: "BULLISH_BSL_BREAKOUT",
            levelKind: lvl.kind,
            levelPrice: lvl.price,
            barIndex: i,
            timestamp: bar.time
          };
        }
      }
    }
  }

  const aboveBsl = bslCandidates.filter(x => x.price > price).sort((a, b) => a.price - b.price)[0] || structure.swingHigh;
  const belowSsl = sslCandidates.filter(x => x.price < price).sort((a, b) => b.price - a.price)[0] || structure.swingLow;

  const nearestTarget = recentSweep
    ? (recentSweep.side === "BUY" ? aboveBsl : belowSsl)
    : (structure.direction === "BULLISH" ? aboveBsl : belowSsl);

  return {
    valid: true,
    bsl: aboveBsl ? aboveBsl.price : null,
    ssl: belowSsl ? belowSsl.price : null,
    eqh,
    eql,
    previousSwingHigh: structure.swingHigh ? structure.swingHigh.price : null,
    previousSwingLow: structure.swingLow ? structure.swingLow.price : null,
    recentSweep,
    breakoutBeyondLiquidity,
    nearestTarget: nearestTarget ? { price: nearestTarget.price, kind: nearestTarget.kind || nearestTarget.type } : null
  };
}

module.exports = { detectEqualLevels, analyzeLiquidity };
