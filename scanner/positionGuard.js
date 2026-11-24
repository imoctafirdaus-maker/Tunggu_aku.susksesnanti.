"use strict";
const { getFuturesSnapshot, manageOpenPositions } = require("./autoTrader");
const { managePendingHarmonicLimits, manageHarmonicVdPositions, loadPaperState } = require("./harmonicRunner");

const DB_BASE = "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app";

async function syncFuturesPortfolioToFirebase(freshSnap) {
  if (!freshSnap || !freshSnap.ok) return;
  const fPayload = {
    totalMargin: freshSnap.totalMargin,
    available: freshSnap.available,
    availableBalance: freshSnap.available,
    unrealizedPnl: freshSnap.unrealizedPnl,
    leverage: freshSnap.leverage || 50,
    riskPct: freshSnap.riskPct || 1.0,
    openPositions: freshSnap.openPositions || [],
    updatedAt: Date.now()
  };
  await Promise.all([
    fetch(`${DB_BASE}/futuresPortfolio.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fPayload)
    }),
    fetch(`${DB_BASE}/scannerStatus/futures.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fPayload)
    }),
    fetch(`${DB_BASE}/emaSignals/_futuresPortfolio.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fPayload)
    })
  ]).catch(() => {});
}

async function syncPendingLimitsToFirebase() {
  try {
    const st = loadPaperState();
    const serializedLimits = (Array.isArray(st.pendingLimits) ? st.pendingLimits : []).map(x => ({
      orderId: x.orderId,
      symbol: x.symbol,
      timeframe: x.timeframe,
      patternName: x.patternName,
      side: x.side,
      limitPrice: x.limitPrice,
      slPrice: x.slPrice,
      tp1Price: x.tp1Price,
      tp2Price: x.tp2Price,
      appliedLev: x.appliedLev,
      przScore: x.przScore,
      rr: x.rr,
      placedAt: x.placedAt,
      expiresAt: x.expiresAt
    }));
    await fetch(`${DB_BASE}/harmonicStatus.json`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pendingLimitsCount: serializedLimits.length,
        pendingLimits: serializedLimits,
        activePositions: Array.isArray(st.activePositions) ? st.activePositions : [],
        updatedAt: Date.now()
      })
    }).catch(() => {});
  } catch (_) {}
}

(async () => {
  try {
    let limitRes = null;
    try {
      limitRes = await managePendingHarmonicLimits();
      if (limitRes && (limitRes.filled > 0 || limitRes.canceled > 0)) {
        await syncPendingLimitsToFirebase();
      }
    } catch (_) {}

    const snap = await getFuturesSnapshot();
    if (limitRes && (limitRes.filled > 0 || limitRes.canceled > 0)) {
      await syncFuturesPortfolioToFirebase(snap);
    }

    if (!snap || !snap.ok || !snap.autoTrade) process.exit(0);
    if (!Array.isArray(snap.openPositions) || snap.openPositions.length === 0) process.exit(0);

    const vdActions = await manageHarmonicVdPositions(snap).catch(() => []);
    if (vdActions && vdActions.length) {
      console.log(`📊 [VD-GUARD 20s] Aksi penjaga Volume Delta:`, vdActions.join(", "));
      await syncPendingLimitsToFirebase();
    }
    const stAfterVd = loadPaperState();
    const vdExtSymbols = new Set(
      (Array.isArray(stAfterVd.activePositions) ? stAfterVd.activePositions : [])
        .filter(p => p && p.symbol && p.vdExtended)
        .map(p => p.symbol)
    );
    const snapForEma = vdExtSymbols.size > 0
      ? { ...snap, openPositions: snap.openPositions.filter(p => !vdExtSymbols.has(p.symbol)) }
      : snap;
    const closed = await manageOpenPositions(snapForEma);
    if (closed && closed.length) {
      console.log(
        `⚡ [FAST-GUARD 20s] Auto TP menutup ${closed.length} posisi:`,
        closed.map(x => `${x.symbol} (+$${x.pnl.toFixed(2)} | +${x.roiPct.toFixed(1)}%)`).join(", ")
      );
      const freshSnap = await getFuturesSnapshot();
      await syncFuturesPortfolioToFirebase(freshSnap);
    }
  } catch (e) {
    console.error("[FAST-GUARD 20s] Error:", e.message);
  }
})();
