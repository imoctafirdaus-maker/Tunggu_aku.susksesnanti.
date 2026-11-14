"use strict";
const crypto = require("crypto");
const https = require("https");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const { checkNewsSafety } = require("./newsGuard");

const FAPI_HOSTS = [
  "fapi.binance.com",
  "fapi1.binance.com",
  "fapi2.binance.com",
  "fapi3.binance.com",
  "fapi4.binance.com"
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
    return { apiKey: k, apiSecret: sec, riskPct: 1.0, leverage: 50, maxPositions: 2, autoTrade: false };
  }
  try {
    const p = path.join(__dirname, "binanceConfig.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      if (c.apiKey && c.apiSecret) {
        return {
          apiKey: String(c.apiKey).trim(),
          apiSecret: String(c.apiSecret).trim(),
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

  let lastErr;
  for (const host of FAPI_HOSTS) {
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
      riskPct: creds.riskPct,
      leverage: creds.leverage,
      maxPositions: creds.maxPositions,
      autoTrade: creds.autoTrade,
      totalMargin: +acc.totalMarginBalance || 0,
      available: +acc.availableBalance || 0,
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

async function getSymbolFilters(symbol) {
  if (!cachedExchangeInfo) {
    cachedExchangeInfo = await fapiRequest("GET", "/fapi/v1/exchangeInfo", {}, null, false);
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

async function executeSignalTrade(rec, snap) {
  const creds = loadBinanceConfig();
  if (!creds || !creds.autoTrade) return { executed: false, reason: "Auto-Trade nonaktif" };
  if (!snap || !snap.ok) return { executed: false, reason: "Koneksi Futures gagal" };

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

  const filters = await getSymbolFilters(rec.symbol);
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

  try { await fapiRequest("POST", "/fapi/v1/marginType", { symbol: rec.symbol, marginType: "ISOLATED" }, creds, true); } catch (_) {}
  await fapiRequest("POST", "/fapi/v1/leverage", { symbol: rec.symbol, leverage: creds.leverage }, creds, true);

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

  return {
    executed: true,
    orderId: entryOrder.orderId,
    symbol: rec.symbol,
    side,
    qty,
    leverage: creds.leverage,
    marginUsed: reqMargin,
    slStatus,
    tpStatus
  };
}

if (require.main === module && process.argv.includes("--test")) {
  (async () => {
    const snap = await getFuturesSnapshot();
    if (!snap || !snap.ok) {
      console.error("❌ Gagal terhubung ke Binance Futures:", snap ? snap.error : "config kosong");
      process.exit(1);
    }
    console.log(`✅ Koneksi Binance USDⓈ-M Futures Berhasil! (Leverage: ${snap.leverage}x | Auto-Trade: ${snap.autoTrade ? "AKTIF" : "STANDBY"})`);
    console.log(`   Total Margin Balance : $${snap.totalMargin.toFixed(2)} USDT`);
    console.log(`   Available Balance    : $${snap.available.toFixed(2)} USDT`);
    console.log(`   Unrealized PnL       : $${snap.unrealizedPnl.toFixed(2)} USDT`);
    console.log(`   Posisi Aktif         : ${snap.openPositions.length}/${snap.maxPositions} posisi`);
  })();
}

module.exports = { loadBinanceConfig, getFuturesSnapshot, executeSignalTrade };
