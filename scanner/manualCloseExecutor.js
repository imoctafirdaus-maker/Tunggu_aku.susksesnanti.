"use strict";
const fs = require("fs");
const path = require("path");
const { loadBinanceConfig, getFuturesSnapshot, fapiRequest } = require("./autoTrader");

const DB_BASE = "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app";
const PAPER_PATH = path.join(__dirname, ".harmonicPaperState.json");
let isBusy = false;

async function processManualCloseQueue() {
  if (isBusy) return;
  isBusy = true;
  try {
    const res = await fetch(`${DB_BASE}/emaSignals/_manualCloseCmd.json?t=${Date.now()}`);
    if (!res.ok) return;
    const cmds = await res.json();
    if (!cmds || typeof cmds !== "object") return;

    for (const [key, item] of Object.entries(cmds)) {
      if (!item || item.status !== "PENDING") continue;
      const sym = String(item.symbol || key).toUpperCase().trim();
      if (!sym) continue;

      // Tandai PROCESSING agar tidak dieksekusi ganda
      await fetch(`${DB_BASE}/emaSignals/_manualCloseCmd/${encodeURIComponent(sym)}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PROCESSING", startedAt: Date.now() })
      }).catch(() => {});

      try {
        const creds = loadBinanceConfig();
        if (!creds || !creds.apiKey || !creds.apiSecret) {
          throw new Error("Kredensial API Binance belum terkonfigurasi");
        }

        const snap = await getFuturesSnapshot();
        if (!snap || !snap.ok) {
          throw new Error(snap?.error || "Gagal membaca posisi Futures");
        }

        const pos = (snap.openPositions || []).find(p => String(p.symbol).toUpperCase() === sym && Math.abs(Number(p.amt || 0)) > 0);
        if (!pos) {
          // Bersihkan sisa order terbuka jika posisi ternyata sudah tertutup
          try { await fapiRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol: sym }, creds, true); } catch (_) {}
          await fetch(`${DB_BASE}/emaSignals/_manualCloseCmd/${encodeURIComponent(sym)}.json`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              symbol: sym,
              status: "DONE",
              message: `Posisi ${sym} sudah tidak aktif di bursa.`,
              closedAt: Date.now()
            })
          }).catch(() => {});
          continue;
        }

        const amt = Number(pos.amt);
        const closeSide = amt > 0 ? "SELL" : "BUY";
        const closeQty = Math.abs(amt);
        const pnlBefore = Number(pos.pnl || 0);

        const orderRes = await fapiRequest("POST", "/fapi/v1/order", {
          symbol: sym,
          side: closeSide,
          type: "MARKET",
          quantity: closeQty,
          reduceOnly: "true"
        }, creds, true);

        // Batalkan semua sisa SL/TP untuk simbol ini
        try { await fapiRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol: sym }, creds, true); } catch (_) {}

        // Hapus dari tracking liveSymbols Harmonic jika ada
        try {
          if (fs.existsSync(PAPER_PATH)) {
            const paper = JSON.parse(fs.readFileSync(PAPER_PATH, "utf8"));
            if (Array.isArray(paper.liveSymbols)) {
              paper.liveSymbols = paper.liveSymbols.filter(s => s !== sym);
              fs.writeFileSync(PAPER_PATH, JSON.stringify(paper, null, 2));
            }
          }
        } catch (_) {}

        // Refresh snapshot portofolio langsung ke Firebase agar UI langsung update
        const freshSnap = await getFuturesSnapshot();
        if (freshSnap && freshSnap.ok) {
          const fPayload = {
            totalMargin: freshSnap.totalMargin,
            available: freshSnap.available,
            unrealizedPnl: freshSnap.unrealizedPnl,
            leverage: freshSnap.leverage || 50,
            riskPct: freshSnap.riskPct || 1.0,
            openPositions: freshSnap.openPositions || [],
            updatedAt: Date.now()
          };
          await Promise.all([
            fetch(`${DB_BASE}/futuresPortfolio.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fPayload) }),
            fetch(`${DB_BASE}/scannerStatus/futures.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fPayload) }),
            fetch(`${DB_BASE}/emaSignals/_futuresPortfolio.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fPayload) })
          ]).catch(() => {});
        }

        const pnlTxt = (pnlBefore >= 0 ? "+" : "") + "$" + pnlBefore.toFixed(2);
        const msgDone = `Posisi ${sym} (${pos.side}) ditutup Market · Est. PnL ${pnlTxt}`;

        await fetch(`${DB_BASE}/emaSignals/_manualCloseCmd/${encodeURIComponent(sym)}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: sym,
            status: "DONE",
            orderId: orderRes.orderId || null,
            pnl: pnlBefore,
            message: msgDone,
            closedAt: Date.now()
          })
        }).catch(() => {});

        try {
          const { sendTelegramAlert } = require("./telegramNotifier");
          await sendTelegramAlert(
            `🛑 <b>[MANUAL CLOSE]</b> ${sym} (${pos.side} ${pos.leverage}x)\n` +
            `• Qty Ditutup: <code>${closeQty}</code> @ Market\n` +
            `• Estimasi PnL: <b>${pnlTxt} USDT</b>`
          );
        } catch (_) {}

        console.log(`🛑 [MANUAL-CLOSE] ${msgDone}`);
      } catch (err) {
        console.error(`❌ [MANUAL-CLOSE] Gagal tutup ${sym}:`, err.message);
        await fetch(`${DB_BASE}/emaSignals/_manualCloseCmd/${encodeURIComponent(sym)}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: sym,
            status: "ERROR",
            message: err.message,
            failedAt: Date.now()
          })
        }).catch(() => {});
      }
    }
  } catch (_) {
  } finally {
    isBusy = false;
  }
}

module.exports = { processManualCloseQueue };
