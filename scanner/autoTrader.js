"use strict";
const crypto = require("crypto");
const https = require("https");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const { checkNewsSafety } = require("./newsGuard");
const { runTimeMachineCheck } = require("./monteCarlo");
const { evaluateDualAiConsensus } = require("./dualAiGatekeeper");
const { notifyAiRejection } = require("./telegramNotifier");

const LIVE_FAPI_HOSTS = [
  "fapi.binance.com",
  "fapi1.binance.com",
  "fapi2.binance.com",
  "fapi3.binance.com",
  "fapi4.binance.com"
];

const DEMO_FAPI_HOSTS = [
  "testnet.binancefuture.com"
];

let cachedExchangeInfo = null;
const resolvedHostCache = new Map();

async function resolveWithPublicDns(hostname) {
  if (resolvedHostCache.has(hostname)) return resolvedHostCache.get(hostname);
  const dohEndpoints = [
    `https://1.1.1.1/dns-query?name=${hostname}&type=A`,
    `https://dns.google/resolve?name=${hostname}&type=A`
  ];
  for (const url of dohEndpoints) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/dns-json" } });
      if (!res.ok) continue;
      const json = await res.json();
      const ans = (json.Answer || []).find(a => a.type === 1 && a.data && !a.data.startsWith("103.123."));
      if (ans) {
        resolvedHostCache.set(hostname, ans.data);
        return ans.data;
      }
    } catch (_) {}
  }
  return null;
}

function httpsJsonRequest({ hostname, path: reqPath, method = "GET", headers = {}, timeoutMs = 10000, ipOverride = null }) {
  return new Promise((resolve, reject) => {
    const options = {
      host: ipOverride || hostname,
      port: 443,
      path: reqPath,
      method,
      servername: hostname,
      headers: { Host: hostname, ...headers },
      timeout: timeoutMs
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        let data;
        try { data = JSON.parse(body); } catch (_) { data = { msg: body }; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data, raw: body });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("Request timeout")); });
    req.on("error", reject);
    req.end();
  });
}

function loadBinanceConfig() {
  const k = (process.env.BINANCE_API_KEY || "").trim();
  const sec = (process.env.BINANCE_API_SECRET || "").trim();
  if (k && sec) {
    return { isDemo: false, apiKey: k, apiSecret: sec, riskPct: 1.0, leverage: 50, maxPositions: 2, autoTrade: false };
  }
  try {
    const p = path.join(__dirname, "binanceConfig.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      const isDemo = Boolean(c.isDemo);
      const activeKey = isDemo ? (c.demoApiKey || "") : (c.apiKey || "");
      const activeSecret = isDemo ? (c.demoApiSecret || "") : (c.apiSecret || "");

      if (activeKey && activeSecret && !activeKey.includes("ISI_API_KEY")) {
        return {
          isDemo,
          apiKey: String(activeKey).trim(),
          apiSecret: String(activeSecret).trim(),
          riskPct: Number.isFinite(+c.riskPct) && +c.riskPct > 0 ? +c.riskPct : 1.0,
          leverage: Number.isFinite(+c.leverage) && +c.leverage > 0 ? +c.leverage : 50,
          maxPositions: Number.isFinite(+c.maxPositions) && +c.maxPositions > 0 ? +c.maxPositions : 2,
          autoTrade: Boolean(c.autoTrade)
        };
      }
    }
  } catch (_) {}
  return null;
}

async function fapiRequest(method, endpoint, params = {}, creds, signed = true) {
  let reqPath = endpoint;
  const headers = {};
  if (signed) {
    const queryObj = { ...params, timestamp: Date.now(), recvWindow: 10000 };
    const qs = new URLSearchParams(queryObj).toString();
    const sig = crypto.createHmac("sha256", creds.apiSecret).update(qs).digest("hex");
    reqPath = `${endpoint}?${qs}&signature=${sig}`;
    headers["X-MBX-APIKEY"] = creds.apiKey;
  } else if (Object.keys(params).length) {
    reqPath = `${endpoint}?${new URLSearchParams(params).toString()}`;
  }

  const hosts = (creds && creds.isDemo) ? DEMO_FAPI_HOSTS : LIVE_FAPI_HOSTS;
  let lastErr;
  for (const host of hosts) {
    const ip = await resolveWithPublicDns(host);
    try {
      const res = await httpsJsonRequest({ hostname: host, path: reqPath, method, headers, ipOverride: ip });
      if (!res.ok) {
        if (res.data && res.data.code) {
          throw new Error(`HTTP ${res.status} (${res.data.code}): ${res.data.msg || res.raw}`);
        }
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res.data;
    } catch (e) {
      lastErr = e;
      if (e.message && (e.message.includes("(-2015)") || e.message.includes("(-1021)"))) throw e;
    }
  }
  throw lastErr || new Error("Semua endpoint Futures gagal dihubungi");
}

async function getFuturesSnapshot() {
  const creds = loadBinanceConfig();
  if (!creds) return null;
  try {
    const acc = await fapiRequest("GET", "/fapi/v2/account", {}, creds, true);
    const openPositions = (acc.positions || [])
      .filter(p => Math.abs(+p.positionAmt) > 0)
      .map(p => ({
        symbol: p.symbol,
        amt: +p.positionAmt,
        side: +p.positionAmt > 0 ? "LONG" : "SHORT",
        entryPrice: +p.entryPrice,
        pnl: +p.unrealizedProfit,
        leverage: +p.leverage
      }));
    return {
      ok: true,
      isDemo: creds.isDemo,
      riskPct: creds.riskPct,
      leverage: creds.leverage,
      maxPositions: creds.maxPositions,
      autoTrade: creds.autoTrade,
      totalMargin: +acc.totalMarginBalance || 0,
      available: (() => {
        const direct = +acc.availableBalance || 0;
        if (direct > 0) return direct;
        const maxW = +acc.maxWithdrawAmount || 0;
        if (maxW > 0) return maxW;
        if (Array.isArray(acc.assets)) {
          const sumAssets = acc.assets.reduce((s, a) => {
            if (["USDT", "USDC", "BNFCR", "BUSD"].includes(a.asset)) {
              return s + (+a.availableBalance || +a.maxWithdrawAmount || 0);
            }
            return s;
          }, 0);
          if (sumAssets > 0) return sumAssets;
        }
        return (+acc.totalMarginBalance || 0) - (+acc.totalInitialMargin || 0);
      })(),
      unrealizedPnl: +acc.totalUnrealizedProfit || 0,
      openPositions
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function roundStep(value, stepSize) {
  const step = Number(stepSize);
  if (!Number.isFinite(step) || step <= 0) return value;
  const decimals = Math.max(0, (stepSize.toString().split(".")[1] || "").replace(/0+$/, "").length);
  const rounded = Math.floor(value / step) * step;
  return Number(rounded.toFixed(decimals));
}

async function getSymbolFilters(symbol, creds) {
  if (!cachedExchangeInfo) {
    cachedExchangeInfo = await fapiRequest("GET", "/fapi/v1/exchangeInfo", {}, creds, false);
  }
  const info = (cachedExchangeInfo.symbols || []).find(s => s.symbol === symbol && s.status === "TRADING");
  if (!info) return null;
  const lotFilter = info.filters.find(f => f.filterType === "LOT_SIZE") || {};
  const priceFilter = info.filters.find(f => f.filterType === "PRICE_FILTER") || {};
  const minNotionalFilter = info.filters.find(f => f.filterType === "MIN_NOTIONAL") || {};
  return {
    stepSize: lotFilter.stepSize || "0.001",
    minQty: Number(lotFilter.minQty || 0),
    tickSize: priceFilter.tickSize || "0.01",
    minNotional: Number(minNotionalFilter.notional || 5)
  };
}


async function recordAiRejection(rec, reason) {
  try { await notifyAiRejection(rec, reason); } catch (_) {}
  try {
    const admin = require("firebase-admin");
    const saPath = path.join(__dirname, "serviceAccountKey.json");
    if (!admin.apps.length && fs.existsSync(saPath)) {
      const sa = JSON.parse(fs.readFileSync(saPath, "utf8"));
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        databaseURL: "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app"
      });
    }
    if (admin.apps.length) {
      const ref = admin.database().ref("emaSignals/_aiRejections");
      const snap = await ref.get();
      const list = Array.isArray(snap.val()) ? snap.val() : [];
      const item = {
        symbol: rec.symbol,
        timeframe: rec.timeframe || "5m",
        signal: rec.signal || "BUY",
        probability: Number(rec.probability || rec.score || 0),
        entryPrice: rec.entryPrice || rec.price || null,
        stopLoss: rec.stopLoss || null,
        reason: String(reason || "Ditolak Dual-AI"),
        rejectedAt: Date.now()
      };
      const filtered = list.filter(x => !(x && x.symbol === item.symbol && x.signal === item.signal && Math.abs(item.rejectedAt - (x.rejectedAt || 0)) < 900000));
      filtered.unshift(item);
      await ref.set(filtered.slice(0, 15));
    }
  } catch (_) {}
}


function calcEmaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

async function checkBtcMacroRegime(rec) {
  try {
    if (!rec || rec.symbol === "BTCUSDT") return { pass: true };
    const res = await fetch("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=220");
    if (!res.ok) return { pass: true };
    const klines = await res.json();
    const closes = (Array.isArray(klines) ? klines : []).map(k => Number(k[4])).filter(n => n > 0);
    if (closes.length < 205) return { pass: true };

    const price = closes[closes.length - 1];
    const ema50 = calcEmaSeries(closes, 50);
    const ema200 = calcEmaSeries(closes, 200);
    const prob = Number(rec.probability || 0);
    const dir = String(rec.signal || "").toUpperCase();

    const isBearRegime = price < ema200 && ema50 < ema200;
    const isBullRegime = price > ema200 && ema50 > ema200;

    if (dir === "BUY" && isBearRegime && prob < 82) {
      return {
        pass: false,
        reason: `Filter Makro BTC Bearish (BTC ${price.toFixed(0)} < EMA200 ${ema200.toFixed(0)}): BUY ditolak karena Prob ${prob}% < 82%`
      };
    }
    if (dir === "SELL" && isBullRegime && prob < 82) {
      return {
        pass: false,
        reason: `Filter Makro BTC Bullish (BTC ${price.toFixed(0)} > EMA200 ${ema200.toFixed(0)}): SELL ditolak karena Prob ${prob}% < 82%`
      };
    }
    return { pass: true };
  } catch (_) {
    return { pass: true };
  }
}

async function executeSignalTrade(rec, snap) {
  const MIN_EXEC_PROB = 75;
  const sigProb = Number(rec.probability ?? rec.winrate ?? rec.score ?? 0);
  if (sigProb < MIN_EXEC_PROB) {
    return { executed: false, skipped: true, reason: `Probabilitas/Skor ${sigProb}% < ${MIN_EXEC_PROB}% (Mode Pantau)` };
  }

  const creds = loadBinanceConfig();
  if (!creds || !creds.autoTrade) return { executed: false, reason: "Auto-Trade nonaktif" };
  if (!snap || !snap.ok) return { executed: false, reason: "Koneksi Futures gagal" };

  const btcMacro = await checkBtcMacroRegime(rec);
  if (!btcMacro.pass) {
    return { executed: false, reason: btcMacro.reason };
  }
  const newsCheck = await checkNewsSafety(rec, 30);
  if (!newsCheck.safe) {
    return { executed: false, reason: newsCheck.reason };
  }
  if (snap.openPositions.length >= creds.maxPositions) {
    return { executed: false, reason: `Batas maksimal ${creds.maxPositions} posisi aktif tercapai` };
  }
  if (snap.openPositions.some(p => p.symbol === rec.symbol)) {
    return { executed: false, reason: `Sudah ada posisi aktif pada ${rec.symbol}` };
  }

  const tm = await runTimeMachineCheck(rec, 52.0);
  if (!tm.pass) {
    return { executed: false, reason: `TimeMachine Probabilitas rendah (${tm.winProb}% < 52%)` };
  }
  const aiCheck = await evaluateDualAiConsensus(rec, tm);
  if (!aiCheck.approved) {
    await recordAiRejection(rec, aiCheck.reason);
    return { executed: false, reason: aiCheck.reason };
  }
  rec._aiNote = aiCheck.summary;

  const filters = await getSymbolFilters(rec.symbol, creds);
  if (!filters) return { executed: false, reason: `${rec.symbol} tidak tersedia di USDⓈ-M Futures` };

  const slDist = Math.abs(rec.entryPrice - rec.stopLoss);
  if (slDist <= 0) return { executed: false, reason: "Jarak Stop Loss tidak valid" };

  const riskUsd = snap.totalMargin * (creds.riskPct / 100);
  let qty = roundStep(riskUsd / slDist, filters.stepSize);
  if (qty * rec.entryPrice < filters.minNotional) {
    qty = roundStep((filters.minNotional * 1.05) / rec.entryPrice, filters.stepSize);
  }
  if (qty < filters.minQty || qty <= 0) {
    return { executed: false, reason: `Qty (${qty}) di bawah batas minimum Binance` };
  }

  const reqMargin = (qty * rec.entryPrice) / creds.leverage;
  if (reqMargin > snap.available * 0.9) {
    return { executed: false, reason: `Saldo tersedia ($${snap.available.toFixed(2)}) kurang untuk margin $${reqMargin.toFixed(2)}` };
  }

  try { await fapiRequest("POST", "/fapi/v1/marginType", { symbol: rec.symbol, marginType: "CROSSED" }, creds, true); } catch (_) {}
  await fapiRequest("POST", "/fapi/v1/leverage", { symbol: rec.symbol, leverage: creds.leverage }, creds, true);

  try {
      const livePayload = { phase: "RESULT", candidate: rec.symbol, signal: rec.signal, groqStatus: "PASS", geminiStatus: "PASS", tradeResult: "SUCCESS", tradeReason: "Order MARKET berhasil dikirim ke Binance!", updatedAt: Date.now() };
      require("fs").writeFileSync(require("path").join(__dirname, ".liveUiState.json"), JSON.stringify(livePayload, null, 2));
      fetch("https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app/emaSignals/_liveRadar.json", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(livePayload) }).catch(() => {});
    } catch (_) {}
  const side = rec.signal === "BUY" ? "BUY" : "SELL";
  const closeSide = side === "BUY" ? "SELL" : "BUY";
  const slPrice = roundStep(rec.stopLoss, filters.tickSize);
  const tpPrice = roundStep(rec.takeProfit, filters.tickSize);

  const entryOrder = await fapiRequest("POST", "/fapi/v1/order", {
    symbol: rec.symbol,
    side,
    type: "MARKET",
    quantity: qty
  }, creds, true);

  let slStatus = "Gagal", tpStatus = "Gagal";
  try {
    await fapiRequest("POST", "/fapi/v1/order", {
      symbol: rec.symbol,
      side: closeSide,
      type: "STOP_MARKET",
      stopPrice: slPrice,
      closePosition: "true",
      workingType: "MARK_PRICE"
    }, creds, true);
    slStatus = `$${slPrice}`;
  } catch (e) { slStatus = `Error: ${e.message}`; }

  try {
    await fapiRequest("POST", "/fapi/v1/order", {
      symbol: rec.symbol,
      side: closeSide,
      type: "TAKE_PROFIT_MARKET",
      stopPrice: tpPrice,
      closePosition: "true",
      workingType: "MARK_PRICE"
    }, creds, true);
    tpStatus = `$${tpPrice}`;
  } catch (e) { tpStatus = `Error: ${e.message}`; }

  const modeBadge = creds.isDemo ? "[DEMO TESTNET]" : "[LIVE REAL]";
  return {
    executed: true,
    isDemo: creds.isDemo,
    orderId: entryOrder.orderId,
    symbol: rec.symbol,
    side,
    qty,
    leverage: creds.leverage,
    marginUsed: reqMargin,
    slStatus,
    tpStatus,
    aiNote: `${modeBadge} ${aiCheck.summary}`
  };
}

if (require.main === module && process.argv.includes("--test")) {
  (async () => {
    const snap = await getFuturesSnapshot();
    if (!snap || !snap.ok) {
      console.error("❌ Gagal terhubung ke Binance Futures:", snap ? snap.error : "config kosong / API key demo belum diisi");
      process.exit(1);
    }
    const modeText = snap.isDemo ? "🧪 DEMO TESTNET" : "🔴 LIVE REAL";
    console.log(`✅ Koneksi Binance USDⓈ-M Futures Berhasil! [${modeText}]`);
    console.log(`   Leverage: ${snap.leverage}x | Auto-Trade: ${snap.autoTrade ? "AKTIF" : "STANDBY"}`);
    console.log(`   Total Margin Balance : $${snap.totalMargin.toFixed(2)} USDT`);
    console.log(`   Available Balance    : $${snap.available.toFixed(2)} USDT`);
    console.log(`   Unrealized PnL       : $${snap.unrealizedPnl.toFixed(2)} USDT`);
    console.log(`   Posisi Aktif         : ${snap.openPositions.length}/${snap.maxPositions} posisi`);
  })();
}


async function manageOpenPositions(snap) {
  const creds = loadBinanceConfig();
  if (!creds || !creds.autoTrade || !snap || !snap.ok || !Array.isArray(snap.openPositions) || !snap.openPositions.length) {
    return [];
  }
  const closedResults = [];
  const TARGET_ROI_PCT = 45; // Otomatis Take Profit saat ROI >= +45% (0.9% gerak harga di 50x)

  for (const pos of snap.openPositions) {
    try {
      const sym = pos.symbol;
      const amt = Number(pos.positionAmt ?? pos.amt ?? 0);
      if (!sym || amt === 0) continue;

      const entry = Number(pos.entryPrice || 0);
      const upnl = Number(pos.unrealizedProfit ?? pos.unRealizedProfit ?? pos.pnl ?? 0);
      const lev = Number(pos.leverage || creds.leverage || 50);
      const notional = Math.abs(amt) * entry;
      const initMargin = notional > 0 ? (notional / lev) : 0;
      const roiPct = initMargin > 0 ? (upnl / initMargin) * 100 : 0;

      // Cek apakah ada order TAKE_PROFIT aktif di Binance untuk simbol ini
      let hasTpOrder = false;
      try {
        const openOrders = await fapiRequest("GET", "/fapi/v1/openOrders", { symbol: sym }, creds, true);
        if (Array.isArray(openOrders)) {
          hasTpOrder = openOrders.some(o => String(o.type || "").includes("TAKE_PROFIT"));
        }
      } catch (_) {}

      // Tutup otomatis jika ROI >= 45%, ATAU jika order TP ternyata tidak terpasang di Binance saat ROI >= 20%
      if (roiPct >= TARGET_ROI_PCT || (!hasTpOrder && roiPct >= 20)) {
        const closeSide = amt > 0 ? "SELL" : "BUY";
        const closeQty = Math.abs(amt);
        const orderRes = await fapiRequest("POST", "/fapi/v1/order", {
          symbol: sym,
          side: closeSide,
          type: "MARKET",
          quantity: closeQty,
          reduceOnly: "true"
        }, creds, true);

        // Bersihkan sisa order SL/TP di simbol tersebut
        try { await fapiRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol: sym }, creds, true); } catch (_) {}

        const reasonText = roiPct >= TARGET_ROI_PCT
          ? `Target ROI +${roiPct.toFixed(1)}% tercapai`
          : `Proteksi TP (Order TP tidak terpasang di bursa, ROI +${roiPct.toFixed(1)}%)`;

        closedResults.push({ symbol: sym, side: amt > 0 ? "LONG" : "SHORT", qty: closeQty, pnl: upnl, roiPct, reason: reasonText, orderId: orderRes.orderId });

        try {
          const { sendTelegramAlert } = require("./telegramNotifier");
          await sendTelegramAlert(
            `💰 *AUTO TAKE-PROFIT BERHASIL*\n` +
            `• *Koin:* \`${sym}\` (${amt > 0 ? "LONG" : "SHORT"} ${lev}x)\n` +
            `• *Profit Realisasi:* *+${upnl.toFixed(2)} USDT* (+${roiPct.toFixed(1)}% ROI)\n` +
            `• *Alasan:* ${reasonText}`
          );
        } catch (_) {}
      }
    } catch (e) {
      console.error(`[TP-GUARD] Gagal evaluasi posisi ${pos.symbol}:`, e.message);
    }
  }
  return closedResults;
}

module.exports = { loadBinanceConfig, getFuturesSnapshot, executeSignalTrade, manageOpenPositions, fapiRequest, getSymbolFilters, roundStep };
