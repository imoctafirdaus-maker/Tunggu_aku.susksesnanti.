(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./config"), require("./engine"));
  } else {
    root.HarmonicBacktester = factory(root.HarmonicConfig, root.HarmonicEngine);
  }
})(typeof self !== "undefined" ? self : this, function (ConfigMod, EngineMod) {
  "use strict";

  /**
   * Walk-Forward Historical Backtest (tanpa repaint & tanpa look-ahead bias):
   * - Pada bar ke-i, engine hanya boleh melihat slice candles[0..i] yang sudah closed.
   * - Simulasi manajemen posisi: 50% close di TP1 (0.382 AD) + geser SL ke Breakeven, 50% sisanya ke TP2 (0.618 AD).
   */
  function runBacktest(candles, timeframe = "1h", userSettings = {}, initialBalance = 1000) {
    const cfg = ConfigMod.mergeSettings(userSettings);
    const closed = candles.filter(c => c.closed !== false);
    const startIdx = 60;
    if (closed.length <= startIdx + 5) {
      return { error: "Minimal 70 candle historis untuk backtest", trades: 0 };
    }

    let balance = initialBalance;
    let peak = initialBalance;
    let maxDrawdownPct = 0;
    let activePos = null;
    const trades = [];
    const seenKeys = new Set();

    for (let i = startIdx; i < closed.length; i++) {
      const bar = closed[i];

      // 1. Kelola posisi aktif pada bar ke-i
      if (activePos) {
        const isBuy = activePos.side === "BUY";
        // Cek Stop Loss
        const hitSl = isBuy ? bar.low <= activePos.sl : bar.high >= activePos.sl;
        if (hitSl) {
          const exitPrice = activePos.sl;
          const pctMove = isBuy
            ? (exitPrice - activePos.entry) / activePos.entry
            : (activePos.entry - exitPrice) / activePos.entry;
          const pnl = activePos.remainingNotional * pctMove - activePos.remainingNotional * 0.0008;
          balance += pnl;
          trades.push({
            pattern: activePos.patternName,
            side: activePos.side,
            entry: activePos.entry,
            exit: exitPrice,
            pnl: activePos.realizedPnl + pnl,
            status: activePos.tp1Hit ? "TP1+BE" : "SL"
          });
          activePos = null;
        } else {
          // Cek TP1 (partial close 50% + geser SL ke Breakeven)
          if (!activePos.tp1Hit) {
            const hitTp1 = isBuy ? bar.high >= activePos.tp1 : bar.low <= activePos.tp1;
            if (hitTp1) {
              const closeNotional = activePos.remainingNotional * (cfg.tp1CloseRatio || 0.5);
              const pctMove = isBuy
                ? (activePos.tp1 - activePos.entry) / activePos.entry
                : (activePos.entry - activePos.tp1) / activePos.entry;
              const pnl1 = closeNotional * pctMove - closeNotional * 0.0008;
              balance += pnl1;
              activePos.realizedPnl += pnl1;
              activePos.remainingNotional -= closeNotional;
              activePos.tp1Hit = true;
              activePos.sl = activePos.entry; // Breakeven
            }
          }
          // Cek TP2 (close sisa posisi)
          if (activePos) {
            const hitTp2 = isBuy ? bar.high >= activePos.tp2 : bar.low <= activePos.tp2;
            if (hitTp2) {
              const pctMove = isBuy
                ? (activePos.tp2 - activePos.entry) / activePos.entry
                : (activePos.entry - activePos.tp2) / activePos.entry;
              const pnl2 = activePos.remainingNotional * pctMove - activePos.remainingNotional * 0.0008;
              balance += pnl2;
              trades.push({
                pattern: activePos.patternName,
                side: activePos.side,
                entry: activePos.entry,
                exit: activePos.tp2,
                pnl: activePos.realizedPnl + pnl2,
                status: "TP2"
              });
              activePos = null;
            }
          }
        }

        if (balance > peak) peak = balance;
        const dd = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }

      // 2. Jika tidak ada posisi aktif, evaluasi hanya history 0..i (zero look-ahead)
      if (!activePos && i < closed.length - 1) {
        const slice = closed.slice(0, i + 1);
        const res = EngineMod.analyzeSingleTimeframe(slice, timeframe, cfg);
        if (res.signal) {
          const sigKey = `${res.signal.patternKey}|${res.signal.points.X.time}|${res.signal.points.C.time}`;
          if (!seenKeys.has(sigKey)) {
            seenKeys.add(sigKey);
            const riskDollar = balance * ((cfg.riskPerTradePct || 1.0) / 100);
            const stopDistPct = Math.abs(res.signal.entry - res.signal.sl) / res.signal.entry;
            const notional = stopDistPct > 0 ? Math.min(balance * 10, riskDollar / stopDistPct) : balance;

            activePos = {
              patternName: res.signal.patternName,
              side: res.signal.side,
              entry: res.signal.entry,
              sl: res.signal.sl,
              tp1: res.signal.tp1,
              tp2: res.signal.tp2,
              remainingNotional: notional,
              realizedPnl: 0,
              tp1Hit: false
            };
          }
        }
      }
    }

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.9 : 0);

    return {
      timeframe,
      totalPatterns: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Number(winRate.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      finalBalance: Number(balance.toFixed(2)),
      netProfitPct: Number((((balance - initialBalance) / initialBalance) * 100).toFixed(2)),
      recentTrades: trades.slice(-10)
    };
  }

  return { runBacktest };
});
