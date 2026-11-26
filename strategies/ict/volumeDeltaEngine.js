"use strict";

const { detectConfirmedSwings } = require("./structure");

/**
 * True Volume Delta from actual Binance Futures aggTrades:
 * m === false -> Buyer is Taker -> Aggressive Buy
 * m === true  -> Seller is Taker -> Aggressive Sell
 */
function aggregateTradesToCandles(trades, intervalMs = 60000) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { candles: [], dataQuality: "DATA_UNAVAILABLE", duplicateCount: 0, missingIdGaps: 0 };
  }

  const sorted = [...trades].sort((a, b) => (Number(a.T) - Number(b.T)) || (Number(a.a) - Number(b.a)));
  const seenIds = new Set();
  let duplicateCount = 0;
  let missingIdGaps = 0;
  let prevId = null;

  const buckets = new Map();

  for (const t of sorted) {
    const id = t.a != null ? Number(t.a) : null;
    const price = Number(t.p);
    const qty = Number(t.q);
    const ts = Number(t.T);
    const isBuyerMaker = Boolean(t.m);

    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(ts) || ts <= 0) {
      continue;
    }

    if (id !== null && Number.isFinite(id)) {
      if (seenIds.has(id)) {
        duplicateCount++;
        continue;
      }
      seenIds.add(id);
      if (prevId !== null && id > prevId + 1) {
        missingIdGaps += (id - prevId - 1);
      }
      prevId = id;
    }

    const openTime = Math.floor(ts / intervalMs) * intervalMs;
    let b = buckets.get(openTime);
    if (!b) {
      b = {
        time: openTime,
        closeTime: openTime + intervalMs - 1,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
        tradeCount: 0
      };
      buckets.set(openTime, b);
    }

    if (price > b.high) b.high = price;
    if (price < b.low) b.low = price;
    b.close = price;
    b.volume += qty;
    if (isBuyerMaker) b.sellVolume += qty;
    else b.buyVolume += qty;
    b.tradeCount += 1;
  }

  const candles = [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .map(b => {
      const delta = b.buyVolume - b.sellVolume;
      const deltaPct = b.volume > 0 ? (delta / b.volume) * 100 : 0;
      return {
        ...b,
        delta,
        positiveDelta: delta > 0 ? delta : 0,
        negativeDelta: delta < 0 ? Math.abs(delta) : 0,
        deltaPct: Number(deltaPct.toFixed(2)),
        dataQuality: b.tradeCount > 0 ? "VALID" : "DATA_UNAVAILABLE"
      };
    });

  const dataQuality = candles.length === 0
    ? "DATA_UNAVAILABLE"
    : (missingIdGaps > 5 ? "DATA_INCOMPLETE" : "VALID");

  return { candles, dataQuality, duplicateCount, missingIdGaps };
}

function analyzeOrderFlow(vdCandles, opts = {}) {
  const lookback = opts.lookbackBars ?? 20;
  const spikeMult = opts.spikeMult ?? 2.0;
  const extremeMult = opts.extremeMult ?? 2.8;
  const imbBuyPct = opts.imbalanceBuyPct ?? 63;
  const imbSellPct = opts.imbalanceSellPct ?? 37;
  const absMinDeltaPct = opts.absorptionMinDeltaPct ?? 22;
  const divLookback = opts.divergenceLookbackBars ?? 25;

  if (!Array.isArray(vdCandles) || vdCandles.length < lookback + 2) {
    return {
      valid: false,
      dataQuality: !vdCandles || vdCandles.length === 0 ? "DATA_UNAVAILABLE" : "DATA_INCOMPLETE",
      direction: "NEUTRAL",
      delta: 0,
      deltaPct: 0,
      buyVolume: 0,
      sellVolume: 0,
      deltaRatio: 0,
      isSpike: false,
      isExtreme: false,
      imbalance: "NONE",
      cvd: 0,
      cvdDirection: "NEUTRAL",
      cvdSlope: "FLAT",
      divergence: null,
      absorption: null
    };
  }

  const normalizedBars = vdCandles.map(c => {
    const vol = Number(c.volume);
    let buyVol = Number(c.buyVolume ?? c.buyVol);
    let sellVol = Number(c.sellVolume ?? c.sellVol);
    const takerBuy = Number(c.takerBuyBase ?? c.takerBuyVolume);
    if (!Number.isFinite(buyVol) && Number.isFinite(takerBuy) && Number.isFinite(vol)) {
      buyVol = takerBuy;
      sellVol = Math.max(0, vol - buyVol);
    }
    return { ...c, volume: vol, buyVolume: buyVol, sellVolume: sellVol };
  });
  const validBars = normalizedBars.filter(c => Number.isFinite(c.buyVolume) && Number.isFinite(c.sellVolume) && c.volume > 0);
  if (validBars.length < lookback + 2) {
    return {
      valid: false,
      dataQuality: "DATA_INCOMPLETE",
      direction: "NEUTRAL",
      delta: 0,
      deltaPct: 0,
      buyVolume: 0,
      sellVolume: 0,
      deltaRatio: 0,
      isSpike: false,
      isExtreme: false,
      imbalance: "NONE",
      cvd: 0,
      cvdDirection: "NEUTRAL",
      cvdSlope: "FLAT",
      divergence: null,
      absorption: null
    };
  }

  // Build CVD series
  let runningCvd = 0;
  const enriched = validBars.map(c => {
    const delta = c.buyVolume - c.sellVolume;
    runningCvd += delta;
    const buyPct = c.volume > 0 ? (c.buyVolume / c.volume) * 100 : 50;
    const deltaPct = c.volume > 0 ? (delta / c.volume) * 100 : 0;
    return {
      ...c,
      delta,
      buyPct,
      deltaPct,
      cvd: runningCvd
    };
  });

  const n = enriched.length;
  const cur = enriched[n - 1];
  const prev = enriched[n - 2];
  const baseSlice = enriched.slice(-(lookback + 1), -1);
  const avgAbsDelta = baseSlice.reduce((s, x) => s + Math.abs(x.delta), 0) / baseSlice.length;
  const avgVol = baseSlice.reduce((s, x) => s + x.volume, 0) / baseSlice.length;
  const baseline = Math.max(avgAbsDelta, avgVol * 0.15, 1e-9);

  const deltaRatio = Math.abs(cur.delta) / baseline;
  const isSpike = deltaRatio >= spikeMult;
  const isExtreme = deltaRatio >= extremeMult;
  const direction = cur.delta > 0 ? "BULLISH" : (cur.delta < 0 ? "BEARISH" : "NEUTRAL");

  let imbalance = "NONE";
  if (cur.buyPct >= imbBuyPct && isSpike) imbalance = "BUY_IMBALANCE";
  else if (cur.buyPct <= imbSellPct && isSpike) imbalance = "SELL_IMBALANCE";

  const cvdLookback = enriched[Math.max(0, n - 6)].cvd;
  const cvdSlope = cur.cvd > cvdLookback ? "INCREASING" : (cur.cvd < cvdLookback ? "DECREASING" : "FLAT");
  const cvdDirection = cur.cvd >= 0 && cvdSlope === "INCREASING"
    ? "BULLISH"
    : (cur.cvd <= 0 && cvdSlope === "DECREASING" ? "BEARISH" : (cvdSlope === "INCREASING" ? "BULLISH" : cvdSlope === "DECREASING" ? "BEARISH" : "NEUTRAL"));

  // CVD Divergence using confirmed swings on recent slice
  let divergence = null;
  const sliceDiv = enriched.slice(-divLookback);
  const priceSwings = detectConfirmedSwings(sliceDiv, 2, 1);
  if (priceSwings.swingLows.length >= 2) {
    const l1 = priceSwings.swingLows[priceSwings.swingLows.length - 2];
    const l2 = priceSwings.swingLows[priceSwings.swingLows.length - 1];
    const cvd1 = sliceDiv[l1.index].cvd;
    const cvd2 = sliceDiv[l2.index].cvd;
    if (l2.price < l1.price && cvd2 > cvd1 && (sliceDiv.length - 1 - l2.index) <= 6) {
      divergence = {
        type: "BULLISH_CVD_DIVERGENCE",
        side: "BUY",
        priceLow1: l1.price,
        priceLow2: l2.price,
        cvd1: Number(cvd1.toFixed(2)),
        cvd2: Number(cvd2.toFixed(2))
      };
    }
  }
  if (!divergence && priceSwings.swingHighs.length >= 2) {
    const h1 = priceSwings.swingHighs[priceSwings.swingHighs.length - 2];
    const h2 = priceSwings.swingHighs[priceSwings.swingHighs.length - 1];
    const cvd1 = sliceDiv[h1.index].cvd;
    const cvd2 = sliceDiv[h2.index].cvd;
    if (h2.price > h1.price && cvd2 < cvd1 && (sliceDiv.length - 1 - h2.index) <= 6) {
      divergence = {
        type: "BEARISH_CVD_DIVERGENCE",
        side: "SELL",
        priceHigh1: h1.price,
        priceHigh2: h2.price,
        cvd1: Number(cvd1.toFixed(2)),
        cvd2: Number(cvd2.toFixed(2))
      };
    }
  }

  // Absorption indication (heavy aggressive flow absorbed with limited price follow-through)
  let absorption = null;
  const recentTwo = [prev, cur];
  for (const bar of recentTwo) {
    const range = Math.max(bar.high - bar.low, 1e-9);
    const body = Math.abs(bar.close - bar.open);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const upperWick = bar.high - Math.max(bar.open, bar.close);

    // Heavy aggressive selling absorbed by passive buyers
    if (bar.deltaPct <= -absMinDeltaPct && bar.volume >= avgVol * 1.2 && lowerWick >= range * 0.45 && bar.close >= bar.low + range * 0.55) {
      absorption = {
        type: "BUYER_ABSORPTION_INDICATION",
        side: "BUY",
        deltaPct: Number(bar.deltaPct.toFixed(2)),
        volumeMult: Number((bar.volume / Math.max(avgVol, 1e-9)).toFixed(2))
      };
    }
    // Heavy aggressive buying absorbed by passive sellers
    if (bar.deltaPct >= absMinDeltaPct && bar.volume >= avgVol * 1.2 && upperWick >= range * 0.45 && bar.close <= bar.high - range * 0.55) {
      absorption = {
        type: "SELLER_ABSORPTION_INDICATION",
        side: "SELL",
        deltaPct: Number(bar.deltaPct.toFixed(2)),
        volumeMult: Number((bar.volume / Math.max(avgVol, 1e-9)).toFixed(2))
      };
    }
  }

  return {
    valid: true,
    dataQuality: "VALID",
    direction,
    delta: Number(cur.delta.toFixed(4)),
    deltaPct: Number(cur.deltaPct.toFixed(2)),
    buyVolume: Number(cur.buyVolume.toFixed(4)),
    sellVolume: Number(cur.sellVolume.toFixed(4)),
    buyPct: Number(cur.buyPct.toFixed(1)),
    deltaRatio: Number(deltaRatio.toFixed(2)),
    isSpike,
    isExtreme,
    imbalance,
    cvd: Number(cur.cvd.toFixed(4)),
    cvdDirection,
    cvdSlope,
    divergence,
    absorption,
    series: enriched
  };
}

module.exports = { aggregateTradesToCandles, analyzeOrderFlow };
