"use strict";

const fs = require("fs");
const path = require("path");
const { aggregateTradesToCandles } = require("../strategies/ict/volumeDeltaEngine");

const FAPI_REST_BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com"
];
const FSTREAM_WS_BASE = "wss://fstream.binance.com/stream";
const STATE_FILE = path.join(__dirname, ".ictOrderFlowState.json");

class IctOrderFlowCollector {
  constructor(opts = {}) {
    this.maxSymbols = opts.maxSymbols || 25;
    this.maxMinutesPerSymbol = opts.maxMinutesPerSymbol || 180;
    this.symbols = [];
    this.buckets = new Map(); // symbol -> Map(openTimeMs -> bar)
    this.lastTradeIds = new Map(); // symbol -> last aggTradeId
    this.missingGaps = new Map(); // symbol -> gap count
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this._loadState();
  }

  _loadState() {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (raw && raw.buckets) {
        for (const [sym, bars] of Object.entries(raw.buckets)) {
          const m = new Map();
          for (const b of bars) m.set(Number(b.time), b);
          this.buckets.set(sym, m);
        }
      }
    } catch (_) {}
  }

  saveState() {
    try {
      const out = { updatedAt: Date.now(), buckets: {} };
      for (const [sym, m] of this.buckets.entries()) {
        out.buckets[sym] = [...m.values()].sort((a, b) => a.time - b.time).slice(-this.maxMinutesPerSymbol);
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(out));
    } catch (_) {}
  }

  ingestAggTrade(symbol, trade) {
    const sym = String(symbol || "").toUpperCase();
    const id = Number(trade.a);
    const price = Number(trade.p);
    const qty = Number(trade.q);
    const ts = Number(trade.T);
    const isBuyerMaker = Boolean(trade.m);

    if (!sym || !Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(ts)) {
      return;
    }

    const prevId = this.lastTradeIds.get(sym);
    if (Number.isFinite(id)) {
      if (prevId !== undefined && id <= prevId) return; // Duplicate protection
      if (prevId !== undefined && id > prevId + 1) {
        this.missingGaps.set(sym, (this.missingGaps.get(sym) || 0) + (id - prevId - 1));
      }
      this.lastTradeIds.set(sym, id);
    }

    const openTime = Math.floor(ts / 60000) * 60000;
    let symMap = this.buckets.get(sym);
    if (!symMap) {
      symMap = new Map();
      this.buckets.set(sym, symMap);
    }

    let bar = symMap.get(openTime);
    if (!bar) {
      bar = {
        time: openTime,
        closeTime: openTime + 59999,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
        tradeCount: 0
      };
      symMap.set(openTime, bar);
      if (symMap.size > this.maxMinutesPerSymbol) {
        const oldestKey = [...symMap.keys()].sort((a, b) => a - b)[0];
        symMap.delete(oldestKey);
      }
    }

    if (price > bar.high) bar.high = price;
    if (price < bar.low) bar.low = price;
    bar.close = price;
    bar.volume += qty;
    if (isBuyerMaker) bar.sellVolume += qty;
    else bar.buyVolume += qty;
    bar.tradeCount += 1;
  }

  getClosed1mCandles(symbol, limit = 120) {
    const sym = String(symbol || "").toUpperCase();
    const symMap = this.buckets.get(sym);
    if (!symMap || symMap.size === 0) return [];
    const currentMinute = Math.floor(Date.now() / 60000) * 60000;
    return [...symMap.values()]
      .filter(b => b.time < currentMinute && b.tradeCount > 0)
      .sort((a, b) => a.time - b.time)
      .slice(-limit)
      .map(b => {
        const delta = b.buyVolume - b.sellVolume;
        return {
          ...b,
          delta,
          positiveDelta: delta > 0 ? delta : 0,
          negativeDelta: delta < 0 ? Math.abs(delta) : 0,
          deltaPct: b.volume > 0 ? Number(((delta / b.volume) * 100).toFixed(2)) : 0,
          dataQuality: "VALID"
        };
      });
  }

  async fetchWithTimeout(url, ms = 4500) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      return await fetch(url, { signal: c.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async fetchRestAggTrades1m(symbol, limit = 1000) {
    const sym = String(symbol || "").toUpperCase();
    const sources = [
      ...FAPI_REST_BASES.map(b => `${b}/fapi/v1/aggTrades?symbol=${encodeURIComponent(sym)}&limit=${limit}`),
      `https://data-api.binance.vision/api/v3/aggTrades?symbol=${encodeURIComponent(sym)}&limit=${limit}`,
      `https://api1.binance.com/api/v3/aggTrades?symbol=${encodeURIComponent(sym)}&limit=${limit}`
    ];

    let aggCandles = [];
    for (const url of sources) {
      try {
        const res = await this.fetchWithTimeout(url, 4500);
        if (!res.ok) continue;
        const trades = await res.json();
        if (!Array.isArray(trades) || trades.length === 0) continue;
        for (const t of trades) this.ingestAggTrade(sym, t);
        const agg = aggregateTradesToCandles(trades, 60000);
        aggCandles = agg.candles || [];
        break;
      } catch (_) {}
    }

    // Backfill closed 1m klines (takerBuyBaseAssetVolume) jika 1000 aggTrades < 15 menit tertutup
    if (aggCandles.length < 15) {
      const k1m = await this.fetchFuturesKlines(sym, "1m", 35);
      if (k1m.length) {
        const byTime = new Map(k1m.map(c => [c.time, c]));
        for (const c of aggCandles) byTime.set(c.time, c);
        return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-30);
      }
    }
    return aggCandles.length ? aggCandles : this.getClosed1mCandles(sym, 120);
  }

  async fetchFuturesKlines(symbol, interval = "5m", limit = 120) {
    const sym = String(symbol || "").toUpperCase();
    const sources = [
      ...FAPI_REST_BASES.map(b => `${b}/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`),
      `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`,
      `https://api1.binance.com/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`
    ];
    for (const url of sources) {
      try {
        const res = await this.fetchWithTimeout(url, 4500);
        if (!res.ok) continue;
        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const closedRows = rows.length > 1 ? rows.slice(0, -1) : rows;
        return closedRows.map(k => {
          const vol = Number(k[5]) || 0;
          const buyVol = Number(k[9]) || 0;
          const sellVol = Math.max(0, vol - buyVol);
          return {
            time: Number(k[0]),
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: vol,
            buyVol,
            sellVol,
            buyVolume: buyVol,
            sellVolume: sellVol,
            delta: buyVol - sellVol,
            closeTime: Number(k[6])
          };
        });
      } catch (_) {}
    }
    return [];
  }

  startWebSocket(symbols = []) {
    const nextSyms = [...new Set(symbols.map(s => String(s).toUpperCase()))].slice(0, this.maxSymbols);
    if (nextSyms.length === 0 || typeof WebSocket === "undefined") return;
    if (this.ws && this.connected && JSON.stringify(nextSyms) === JSON.stringify(this.symbols)) return;

    this.stopWebSocket();
    this.symbols = nextSyms;
    const streams = this.symbols.map(s => `${s.toLowerCase()}@aggTrade`).join("/");
    const url = `${FSTREAM_WS_BASE}?streams=${streams}`;

    try {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectAttempts = 0;
      };
      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
          if (msg && msg.data && msg.data.e === "aggTrade") {
            this.ingestAggTrade(msg.data.s, msg.data);
          }
        } catch (_) {}
      };
      this.ws.onclose = () => {
        this.connected = false;
        this._scheduleReconnect();
      };
      this.ws.onerror = () => {
        this.connected = false;
      };
    } catch (_) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.symbols.length === 0) return;
    const delay = Math.min(30000, 1500 * Math.pow(2, this.reconnectAttempts++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startWebSocket(this.symbols);
    }, delay);
  }

  stopWebSocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = { IctOrderFlowCollector };
