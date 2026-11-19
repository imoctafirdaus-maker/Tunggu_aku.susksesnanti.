"use strict";
const { getFuturesSnapshot, manageOpenPositions } = require("./autoTrader");

(async () => {
  try {
    const snap = await getFuturesSnapshot();
    if (!snap || !snap.ok || !snap.autoTrade) process.exit(0);
    if (!Array.isArray(snap.openPositions) || snap.openPositions.length === 0) process.exit(0);

    const closed = await manageOpenPositions(snap);
    if (closed && closed.length) {
      console.log(
        `⚡ [FAST-GUARD 20s] Auto TP menutup ${closed.length} posisi:`,
        closed.map(x => `${x.symbol} (+$${x.pnl.toFixed(2)} | +${x.roiPct.toFixed(1)}%)`).join(", ")
      );
    }
  } catch (e) {
    console.error("[FAST-GUARD 20s] Error:", e.message);
  }
})();
