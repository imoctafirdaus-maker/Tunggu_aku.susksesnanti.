"use strict";
const fs = require("fs");
const path = require("path");
const { loadBinanceConfig, getFuturesSnapshot, fapiRequest } = require("./autoTrader");

const PAPER_FILE = path.join(__dirname, ".harmonicPaperState.json");
const ANALYTICS_CACHE = path.join(__dirname, ".dailyAnalyticsCache.json");

function getTodayWibStr(ts = Date.now()) {
  const d = new Date(ts + 7 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function getHourWibStr(ts = Date.now()) {
  const d = new Date(ts + 7 * 3600 * 1000);
  return d.toISOString().slice(11, 13) + ":00";
}

async function syncDailyAnalyticsToFirebase(db, admin, scanMeta = {}) {
  try {
    const todayWib = getTodayWibStr();
    const hourWib = getHourWibStr();

    // Muat state lokal agar traffic per jam & riwayat terakumulasi rapi
    let state = { date: todayWib, hourlyTraffic: {}, dailyHistory: {} };
    try {
      if (fs.existsSync(ANALYTICS_CACHE)) {
        const saved = JSON.parse(fs.readFileSync(ANALYTICS_CACHE, "utf8"));
        if (saved && typeof saved === "object") state = { ...state, ...saved };
      }
    } catch (_) {}

    if (state.date !== todayWib) {
      state.date = todayWib;
      state.hourlyTraffic = {};
    }

    // Catat traffic pemindaian jam ini
    const prevHr = state.hourlyTraffic[hourWib] || { scans: 0, signalsFound: 0, skippedNews: 0 };
    prevHr.scans += Number(scanMeta.scanned || 0);
    prevHr.signalsFound += Number(scanMeta.found || 0);
    state.hourlyTraffic[hourWib] = prevHr;

    // Baca riwayat log & posisi dari .harmonicPaperState.json
    let paper = { logs: [], openPositions: [], closedTrades: [] };
    try {
      if (fs.existsSync(PAPER_FILE)) {
        paper = JSON.parse(fs.readFileSync(PAPER_FILE, "utf8"));
      }
    } catch (_) {}

    const todayLogs = (paper.logs || []).filter(l => getTodayWibStr(l.time || Date.now()) === todayWib);
    const todaySkippedNews = todayLogs.filter(l => String(l.reason || "").includes("News Guard")).length;
    const todayExecutedLogs = todayLogs.filter(l => l.status === "EXECUTED" || l.status === "LIVE" || l.status === "PAPER");

    // Ambil snapshot saldo & riwayat Realized PnL dari Binance Futures
    let currentEquity = 0;
    let todayRealizedPnl = 0;
    let recentTrades = [];
    const dailyPnlMap = {};

    const creds = loadBinanceConfig();
    if (creds) {
      const snap = await getFuturesSnapshot().catch(() => null);
      if (snap && snap.ok) {
        currentEquity = Number(snap.totalMargin || 0);
      }
      const incRes = await fapiRequest("GET", "/fapi/v1/income", { incomeType: "REALIZED_PNL", limit: 100 }, creds, true).catch(() => null);
      if (incRes && incRes.ok && Array.isArray(incRes.data)) {
        for (const item of incRes.data) {
          const dayKey = getTodayWibStr(Number(item.time || Date.now()));
          const pnlVal = Number(item.income || 0);
          dailyPnlMap[dayKey] = (dailyPnlMap[dayKey] || 0) + pnlVal;
          if (dayKey === todayWib) {
            todayRealizedPnl += pnlVal;
          }
        }
        recentTrades = incRes.data.slice(-15).reverse().map(t => ({
          time: Number(t.time || Date.now()),
          symbol: t.symbol || "-",
          pnl: Number(t.income || 0),
          asset: t.asset || "USDT",
          source: "FUTURES"
        }));
      }
    }

    // Gabungkan dengan riwayat paper/harmonic closedTrades jika ada
    const closedHarmonic = Array.isArray(paper.closedTrades) ? paper.closedTrades : [];
    for (const ct of closedHarmonic) {
      const dayKey = getTodayWibStr(Number(ct.closedAt || ct.openedAt || Date.now()));
      const pnlVal = Number(ct.realizedPnl || 0);
      if (!creds) {
        dailyPnlMap[dayKey] = (dailyPnlMap[dayKey] || 0) + pnlVal;
        if (dayKey === todayWib) todayRealizedPnl += pnlVal;
      }
      recentTrades.push({
        time: Number(ct.closedAt || ct.openedAt || Date.now()),
        symbol: ct.symbol || "-",
        pattern: ct.patternName || "Harmonic",
        side: ct.side || "-",
        pnl: pnlVal,
        source: "HARMONIC"
      });
    }

    recentTrades.sort((a, b) => b.time - a.time);
    recentTrades = recentTrades.slice(0, 12);

    const todayTrades = recentTrades.filter(t => getTodayWibStr(t.time) === todayWib);
    const winsToday = todayTrades.filter(t => t.pnl > 0).length;
    const winRateToday = todayTrades.length > 0 ? Math.round((winsToday / todayTrades.length) * 100) : 0;

    // Simpan ringkasan hari ini ke dailyHistory (7 hari terakhir)
    const totalScansToday = Object.values(state.hourlyTraffic).reduce((a, b) => a + (b.scans || 0), 0);
    const totalFoundToday = Object.values(state.hourlyTraffic).reduce((a, b) => a + (b.signalsFound || 0), 0);

    state.dailyHistory[todayWib] = {
      date: todayWib,
      equity: currentEquity,
      realizedPnl: Number((dailyPnlMap[todayWib] !== undefined ? dailyPnlMap[todayWib] : todayRealizedPnl).toFixed(4)),
      scans: totalScansToday,
      signalsFound: totalFoundToday,
      tradesCount: todayTrades.length,
      winRate: winRateToday
    };

    // Pastikan hari-hari sebelumnya dari income Binance juga masuk grafik
    for (const [dKey, pnlSum] of Object.entries(dailyPnlMap)) {
      if (!state.dailyHistory[dKey]) {
        state.dailyHistory[dKey] = {
          date: dKey,
          equity: currentEquity,
          realizedPnl: Number(pnlSum.toFixed(4)),
          scans: 0,
          signalsFound: 0,
          tradesCount: 0,
          winRate: 0
        };
      }
    }

    const sortedDays = Object.keys(state.dailyHistory).sort().slice(-10);
    const trimmedHistory = {};
    for (const k of sortedDays) trimmedHistory[k] = state.dailyHistory[k];
    state.dailyHistory = trimmedHistory;

    fs.writeFileSync(ANALYTICS_CACHE, JSON.stringify(state, null, 2));

    const payload = {
      updatedAt: Date.now(),
      todayWib,
      summary: {
        equity: currentEquity,
        todayRealizedPnl: Number(todayRealizedPnl.toFixed(4)),
        todayTradesCount: todayTrades.length,
        winRateToday,
        totalScansToday,
        totalFoundToday,
        todaySkippedNews,
        executedOrdersToday: todayExecutedLogs.length
      },
      hourlyTraffic: state.hourlyTraffic,
      dailySeries: sortedDays.map(d => state.dailyHistory[d]),
      recentTrades,
      recentEvaluations: todayLogs.slice(-8).reverse().map(l => ({
        time: l.time,
        symbol: l.symbol,
        timeframe: l.timeframe,
        pattern: l.pattern,
        side: l.side,
        status: l.status,
        reason: l.reason
      }))
    };

    if (db) {
      await db.ref("emaSignals/_dailyAnalytics").set(payload);
    }
    return payload;
  } catch (e) {
    console.error("[DailyAnalytics] Gagal sinkronisasi:", e.message);
    return null;
  }
}

module.exports = { syncDailyAnalyticsToFirebase };
