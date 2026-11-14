function computeDynamicRR(rvol, winrate) {
  const v = Number(rvol) || 1.15;
  const w = Number(winrate) || 50;
  if (v >= 2.40 && w >= 65) return 5.0;
  if (v >= 1.65 && w >= 60) return 3.0;
  return 2.0;
}

"use strict";
/* ===========================================================================
   engine.js — Mesin Analisis Octa Analyzer
   1. Algoritma Lama (computeSignal) — DIPERTAHANKAN UTUH
   2. Modul Tambahan: EMA Expert Strategy MTF (computeEmaExpertMTF & Backtest)
   =========================================================================== */
const finite = Number.isFinite;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
function fmt(n, d = 2) { return finite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "--"; }
function fmtP(n) { if (!finite(n)) return "--"; const d = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8; return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }

const SIG = { window: 300, minCandles: 60, minValid: 7, maxBars: 24, minSample: 30, backtestStart: 100, oosShare: 0.3 };
const GROUPS = { ema: "trend", sma: "trend", macd: "trend", adx: "trend", rsi: "momentum", stochrsi: "momentum", cci: "momentum", bb: "band", atr: "band", obv: "volume" };
const GROUP_W = { trend: .35, momentum: .25, band: .2, volume: .2 };

const TA = {
  emaSeries(a, p) {
    const out = new Array(a.length).fill(NaN);
    if (a.length < p) return out;
    let v = mean(a.slice(0, p));
    out[p - 1] = v;
    const k = 2 / (p + 1);
    for (let i = p; i < a.length; i++) {
      v = a[i] * k + v * (1 - k);
      out[i] = v;
    }
    return out;
  },
  ema(a, p) { const s = this.emaSeries(a, p); return s.length ? s[s.length - 1] : NaN; },
  sma(a, p) { return a.length >= p ? mean(a.slice(-p)) : NaN; },
  smaSeries(a, p) { return a.map((_, i) => { if (i < p - 1) return NaN; const w = a.slice(i - p + 1, i + 1); return w.every(x => finite(x)) ? mean(w) : NaN; }); },
  rsi(a, p = 14) { if (a.length < p + 1) return NaN; let g = 0, l = 0; for (let i = 1; i <= p; i++) { let d = a[i] - a[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); } g /= p; l /= p; for (let i = p + 1; i < a.length; i++) { let d = a[i] - a[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; } return l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l); },
  rsiSeries(a, p = 14) { const out = new Array(a.length).fill(NaN); if (a.length < p + 1) return out; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = a[i] - a[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); } g /= p; l /= p; const val = () => l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l); out[p] = val(); for (let i = p + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; out[i] = val(); } return out; },
  stochRsi(a, rp = 14, sp = 14, kp = 3, dp = 3) { const rs = this.rsiSeries(a, rp), raw = rs.map((v, i) => { if (i < sp - 1) return NaN; const w = rs.slice(i - sp + 1, i + 1); if (!w.every(x => finite(x))) return NaN; const hi = Math.max(...w), lo = Math.min(...w); return hi === lo ? 50 : (rs[i] - lo) / (hi - lo) * 100; }); const k = this.smaSeries(raw, kp), d = this.smaSeries(k, dp); return { k: k[k.length - 1], d: d[d.length - 1] }; },
  macd(a) { if (a.length < 35) return { line: NaN, signal: NaN, histogram: NaN }; const e12 = this.emaSeries(a, 12), e26 = this.emaSeries(a, 26), m = []; for (let i = 25; i < a.length; i++) m.push(e12[i] - e26[i]); const sg = this.emaSeries(m, 9), line = m[m.length - 1], signal = sg[sg.length - 1]; return { line, signal, histogram: line - signal }; },
  bb(a, p = 20, k = 2) { if (a.length < p) return { upper: NaN, middle: NaN, lower: NaN, width: NaN }; let s = a.slice(-p), m = mean(s), sd = Math.sqrt(mean(s.map(x => (x - m) ** 2))); return { upper: m + k * sd, middle: m, lower: m - k * sd, width: m ? 2 * k * sd / m : NaN }; },
  atrSeries(h, l, c, p = 14) { const n = c.length, out = new Array(n).fill(NaN); if (n < p + 1) return out; const tr = new Array(n).fill(0); for (let j = 1; j < n; j++) tr[j] = Math.max(h[j] - l[j], Math.abs(h[j] - c[j - 1]), Math.abs(l[j] - c[j - 1])); let v = mean(tr.slice(1, p + 1)); out[p] = v; for (let i = p + 1; i < n; i++) { v = (v * (p - 1) + tr[i]) / p; out[i] = v; } return out; },
  adx(h, l, c, p = 14) { const n = c.length; if (n < 2 * p + 2) return { adx: NaN, plusDI: NaN, minusDI: NaN }; const tr = [], pd = [], md = []; for (let i = 1; i < n; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; pd.push(up > dn && up > 0 ? up : 0); md.push(dn > up && dn > 0 ? dn : 0); tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); } let sT = 0, sP = 0, sM = 0; for (let i = 0; i < p; i++) { sT += tr[i]; sP += pd[i]; sM += md[i]; } const dxs = []; let pdi = 0, mdi = 0; const calc = () => { pdi = sT ? 100 * sP / sT : 0; mdi = sT ? 100 * sM / sT : 0; dxs.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0); }; calc(); for (let i = p; i < tr.length; i++) { sT = sT - sT / p + tr[i]; sP = sP - sP / p + pd[i]; sM = sM - sM / p + md[i]; calc(); } if (dxs.length < p) return { adx: NaN, plusDI: pdi, minusDI: mdi }; let a = mean(dxs.slice(0, p)); for (let j = p; j < dxs.length; j++) a = (a * (p - 1) + dxs[j]) / p; return { adx: a, plusDI: pdi, minusDI: mdi }; },
  cci(h, l, c, p = 20) { const n = c.length; if (n < p) return NaN; const tp = []; for (let i = n - p; i < n; i++) tp.push((h[i] + l[i] + c[i]) / 3); const m = mean(tp), md = mean(tp.map(x => Math.abs(x - m))); return md === 0 ? 0 : (tp[tp.length - 1] - m) / (0.015 * md); },
  obvSeries(cs) { const out = new Array(cs.length).fill(0); for (let i = 1; i < cs.length; i++) { const d = cs[i].close - cs[i - 1].close; out[i] = out[i - 1] + (d > 0 ? cs[i].volume : d < 0 ? -cs[i].volume : 0); } return out; }
};

/* =================== 1. ALGORITMA LAMA (TIDAK DIUBAH) =================== */
function evaluateIndicators(cs) {
  const n = cs.length, c = cs.map(x => x.close), h = cs.map(x => x.high), l = cs.map(x => x.low), p = c[n - 1], list = [], ctx = {};
  const push = (key, name, value, dir, note) => list.push({ key, name, group: GROUPS[key], value, dir, note });
  const na = (key, name, why) => push(key, name, "--", "na", "Gagal dihitung (" + why + ")");
  const atrS = TA.atrSeries(h, l, c, 14), atrNow = atrS[n - 1]; ctx.atr = atrNow;
  const rsi = TA.rsi(c);
  if (!finite(rsi)) na("rsi", "RSI (14)", "butuh minimal 15 candle");
  else { let d, t; if (rsi > 70) { d = "neutral"; t = "Jenuh beli (>70)"; } else if (rsi < 30) { d = "neutral"; t = "Jenuh jual (<30)"; } else if (rsi >= 55) { d = "bull"; t = "Momentum naik (55–70)"; } else if (rsi <= 45) { d = "bear"; t = "Momentum turun (30–45)"; } else { d = "neutral"; t = "Zona tengah 45–55"; } push("rsi", "RSI (14)", fmt(rsi, 1), d, t); }
  const m = TA.macd(c);
  if (!finite(m.histogram) || !finite(atrNow)) na("macd", "MACD (12,26,9)", "butuh minimal 35 candle");
  else { const th = 0.02 * atrNow; let d, t; if (m.histogram > th && m.line > m.signal) { d = "bull"; t = "Histogram positif"; } else if (m.histogram < -th && m.line < m.signal) { d = "bear"; t = "Histogram negatif"; } else { d = "neutral"; t = "Mendekati nol"; } push("macd", "MACD (12,26,9)", fmt(m.histogram, p < 1 ? 6 : 4), d, t); }
  const e9 = TA.ema(c, 9), e21 = TA.ema(c, 21); ctx.ema21 = e21;
  if (!finite(e9) || !finite(e21)) na("ema", "EMA 9/21", "butuh minimal 21 candle");
  else { let d, t; if (e9 > e21 && p > e21) { d = "bull"; t = "EMA 9 > EMA 21 & Harga > EMA 21"; } else if (e9 < e21 && p < e21) { d = "bear"; t = "EMA 9 < EMA 21 & Harga < EMA 21"; } else { d = "neutral"; t = "Persilangan netral"; } push("ema", "EMA 9/21", fmtP(e9) + " / " + fmtP(e21), d, t); }
  const s20 = TA.sma(c, 20), s50 = TA.sma(c, 50);
  if (!finite(s20) || !finite(s50)) na("sma", "SMA 20/50", "butuh minimal 50 candle");
  else { let d, t; if (s20 > s50 && p > s50) { d = "bull"; t = "SMA 20 > SMA 50"; } else if (s20 < s50 && p < s50) { d = "bear"; t = "SMA 20 < SMA 50"; } else { d = "neutral"; t = "Netral"; } push("sma", "SMA 20/50", fmtP(s20) + " / " + fmtP(s50), d, t); }
  const b = TA.bb(c);
  if (!finite(b.upper) || !finite(b.lower) || b.upper <= b.lower) na("bb", "Bollinger Bands (20,2)", "butuh minimal 20 candle");
  else { const pct = (p - b.lower) / (b.upper - b.lower); let d, t; if (pct > 1 || pct < 0) { d = "neutral"; t = "Ekstrem di luar band"; } else if (pct >= 0.55) { d = "bull"; t = "Di paruh atas band"; } else if (pct <= 0.45) { d = "bear"; t = "Di paruh bawah band"; } else { d = "neutral"; t = "Di tengah band"; } push("bb", "Bollinger Bands (20,2)", "%B " + fmt(pct * 100, 0) + "%", d, t); }
  const sr = TA.stochRsi(c);
  if (!finite(sr.k) || !finite(sr.d)) na("stochrsi", "Stochastic RSI", "butuh minimal 35 candle");
  else { let d, t; if (sr.k > sr.d && sr.k < 80) { d = "bull"; t = "%K > %D"; } else if (sr.k < sr.d && sr.k > 20) { d = "bear"; t = "%K < %D"; } else { d = "neutral"; t = "Jenuh / Netral"; } push("stochrsi", "Stochastic RSI (14,14,3,3)", "K " + fmt(sr.k, 1) + " / D " + fmt(sr.d, 1), d, t); }
  const a = TA.adx(h, l, c); ctx.adx = a.adx;
  if (!finite(a.adx)) na("adx", "ADX (14)", "butuh minimal 30 candle");
  else { let d, t; if (a.adx >= 20 && a.plusDI > a.minusDI) { d = "bull"; t = "ADX ≥ 20 (+DI > -DI)"; } else if (a.adx >= 20 && a.minusDI > a.plusDI) { d = "bear"; t = "ADX ≥ 20 (-DI > +DI)"; } else { d = "neutral"; t = "ADX < 20"; } push("adx", "ADX (14)", fmt(a.adx, 1) + " (+DI " + fmt(a.plusDI, 1) + " / -DI " + fmt(a.minusDI, 1) + ")", d, t); }
  const cci = TA.cci(h, l, c);
  if (!finite(cci)) na("cci", "CCI (20)", "butuh minimal 20 candle");
  else { let d, t; if (cci > 100 && cci <= 200) { d = "bull"; t = "CCI > +100"; } else if (cci < -100 && cci >= -200) { d = "bear"; t = "CCI < -100"; } else { d = "neutral"; t = "Netral"; } push("cci", "CCI (20)", fmt(cci, 1), d, t); }
  const obv = TA.obvSeries(cs);
  if (n < 26) na("obv", "OBV", "butuh minimal 26 candle");
  else { const oe = TA.emaSeries(obv, 20), eNow = oe[n - 1], now = obv[n - 1], prev = obv[n - 6]; if (!finite(eNow)) na("obv", "OBV", "EMA OBV N/A"); else { let d, t; if (now > eNow && now > prev) { d = "bull"; t = "OBV naik di atas EMA 20"; } else if (now < eNow && now < prev) { d = "bear"; t = "OBV turun di bawah EMA 20"; } else { d = "neutral"; t = "OBV netral"; } push("obv", "OBV", fmt(now, 0), d, t); } }
  const atrVals = atrS.slice(-20).filter(x => finite(x));
  if (!finite(atrNow) || atrVals.length < 10 || n < 5) na("atr", "ATR (14)", "butuh 25 candle");
  else { const avg = mean(atrVals), exp = atrNow > avg * 1.05, chg = c[n - 1] - c[n - 4]; ctx.atrExp = exp; let d, t; if (exp && Math.abs(chg) > 0.5 * atrNow) { d = chg > 0 ? "bull" : "bear"; t = "Volatilitas meluas"; } else { d = "neutral"; t = "Volatilitas normal"; } push("atr", "ATR (14)", fmtP(atrNow), d, t); }
  return { list, ctx };
}
function swingExt(cs, k, type) { const s = cs.slice(-k); return type === "L" ? Math.min(...s.map(x => x.low)) : Math.max(...s.map(x => x.high)); }
function buildLevels(s, cs, ctx) {
  const p = cs[cs.length - 1].close, atr = ctx.atr, ema21 = ctx.ema21;
  let far = p - s * 0.5 * atr;
  if (finite(ema21) && ((s === 1 && ema21 < p && ema21 > far) || (s === -1 && ema21 > p && ema21 < far))) far = ema21;
  if (Math.abs(p - far) < 0.1 * atr) far = p - s * 0.1 * atr;
  const low = Math.min(p, far), high = Math.max(p, far), mid = (low + high) / 2; let sl;
  if (s === 1) { const sw = swingExt(cs, 10, "L") - 0.25 * atr; sl = sw < low ? sw : mid - 1.5 * atr; sl = Math.max(mid - 2.5 * atr, Math.min(sl, mid - 1.0 * atr)); }
  else { const sw = swingExt(cs, 10, "H") + 0.25 * atr; sl = sw > high ? sw : mid + 1.5 * atr; sl = Math.min(mid + 2.5 * atr, Math.max(sl, mid + 1.0 * atr)); }
  const risk = Math.abs(mid - sl);
  return { low, high, mid, sl, risk, rr: [1, 2, 3], tps: [1, 2, 3].map(k => mid + s * k * risk) };
}
function computeSignal(all) {
  const cs = all.slice(-SIG.window), last = cs[cs.length - 1];
  const base = { time: last ? last.time : 0, price: last ? last.close : NaN, list: [], g: 0, y: 0, r: 0, nv: 0, strength: null, dom: 0, weak: false, levels: null, filterMsg: "" };
  if (cs.length < SIG.minCandles) return { ...base, status: "INSUFFICIENT", reason: `Data candle tertutup belum cukup (${cs.length}/${SIG.minCandles}).`, invalid: "--" };
  const { list, ctx } = evaluateIndicators(cs), valid = list.filter(x => x.dir !== "na"), nv = valid.length;
  const g = valid.filter(x => x.dir === "bull").length, r = valid.filter(x => x.dir === "bear").length, y = valid.filter(x => x.dir === "neutral").length;
  const res = { ...base, list, g, y, r, nv };
  if (nv < SIG.minValid) return { ...res, status: "INSUFFICIENT", reason: `Hanya ${nv} indikator valid.`, invalid: "--" };
  const minVotes = Math.ceil(0.6 * nv), minMargin = Math.ceil(0.3 * nv);
  let status = "NEUTRAL";
  if (g >= minVotes && g - r >= minMargin) status = "BUY"; else if (r >= minVotes && r - g >= minMargin) status = "SELL";
  const s = status === "BUY" ? 1 : status === "SELL" ? -1 : 0, adxV = ctx.adx;
  if (s !== 0) {
    const ema = list.find(x => x.key === "ema"), sma = list.find(x => x.key === "sma"), adx = list.find(x => x.key === "adx"), opp = s === 1 ? "bear" : "bull";
    if (ema && sma && ema.dir === opp && sma.dir === opp) res.filterMsg = "Filter tren bertentangan.";
    else if (adx && adx.dir === opp && adxV >= 25) res.filterMsg = "Filter ADX bertentangan.";
    if (res.filterMsg) status = "NEUTRAL";
  }
  res.status = status; res.weak = !(adxV >= 20);
  if (status === "NEUTRAL") { res.reason = "Belum ada konfirmasi suara mayoritas indikator."; res.invalid = "--"; return res; }
  const sc = d => d === "bull" ? 1 : d === "bear" ? -1 : 0; let num = 0, den = 0;
  for (const gr in GROUP_W) { const mm = valid.filter(x => x.group === gr); if (!mm.length) continue; num += GROUP_W[gr] * s * mean(mm.map(x => sc(x.dir))); den += GROUP_W[gr]; }
  const dom = den ? clamp(num / den, -1, 1) : 0, adxF = finite(adxV) ? clamp((adxV - 15) / 25, 0, 1) : 0, volF = ctx.atrExp ? 1 : 0.4;
  res.dom = s * Math.max(0, dom); res.strength = Math.round(100 * clamp(0.65 * Math.max(0, dom) + 0.2 * adxF + 0.15 * volF, 0, 1));
  res.levels = buildLevels(s, cs, ctx);
  res.reason = `${s === 1 ? 'BUY' : 'SELL'} terkonfirmasi: ${g} hijau, ${y} kuning, ${r} merah dari ${nv} indikator.`;
  res.invalid = `Candle ditutup menembus Stop Loss ${fmtP(res.levels.sl)}.`;
  return res;
}

/* =================== 2. MODUL BARU: EMA EXPERT STRATEGY =================== */
function enrichEmaSeries(cs) {
  const c = cs.map(x => x.close), h = cs.map(x => x.high), l = cs.map(x => x.low);
  const e8 = TA.emaSeries(c, 8);
  const e21 = TA.emaSeries(c, 21);
  const e125 = TA.emaSeries(c, 125);
  const atr = TA.atrSeries(h, l, c, 14);
  return cs.map((bar, i) => ({ ...bar, e8: e8[i], e21: e21[i], e125: e125[i], atr: atr[i] }));
}

function checkSwingStructure(series, idx) {
  if (idx < 12) return { hhHl: false, lhLl: false };
  const prior = series.slice(idx - 11, idx - 5);
  const recent = series.slice(idx - 5, idx + 1);
  const priorH = Math.max(...prior.map(x => x.high)), priorL = Math.min(...prior.map(x => x.low));
  const recH = Math.max(...recent.map(x => x.high)), recL = Math.min(...recent.map(x => x.low));
  return {
    hhHl: recH > priorH && recL > priorL,
    lhLl: recH < priorH && recL < priorL
  };
}

/**
 * Evaluasi kronologis Multi-Timeframe EMA Expert Strategy (Zero Look-Ahead Bias)
 * @param {Object} data - { trend: candles1H, pullback: candles15M, entry: candles5M }
 * @param {Object} opts - { rrRatio: 1.0, atrTolerance: 0.25, costPct: 0.0012 }
 */
function evaluateEmaExpertHistory(data, opts = {}) {
  const rrRatio = finite(opts.rrRatio) && opts.rrRatio > 0 ? opts.rrRatio : 1.0;
  const atrTol = finite(opts.atrTolerance) ? opts.atrTolerance : 0.25;
  const costPct = finite(opts.costPct) ? opts.costPct : 0.0012;

  if (!data || !Array.isArray(data.trend) || !Array.isArray(data.pullback) || !Array.isArray(data.entry)) {
    return { ready: false, reason: "Data Multi-Timeframe tidak lengkap" };
  }
  if (data.trend.length < 140 || data.pullback.length < 40 || data.entry.length < 40) {
    return { ready: false, reason: `Pemanasan EMA 125 belum cukup (Trend: ${data.trend.length}/140 candle)` };
  }

  const dt = enrichEmaSeries(data.trend);
  const dp = enrichEmaSeries(data.pullback);
  const de = enrichEmaSeries(data.entry);

  let tIdx = 0, pIdx = 0;
  let state = "WAITING";          // WAITING | TREND_DETECTED | PULLBACK_DETECTED | BUY_CONFIRMED | SELL_CONFIRMED | INVALIDATED
  let trendDir = "NEUTRAL";       // BULLISH | BEARISH | NEUTRAL
  let pullbackSide = null;        // BUY | SELL
  let pullbackConsumed = false;   // Mencegah entry berulang dari satu pullback
  let pullbackBars = 0;
  let lastSignalCandle = -1;

  const trades = [];
  let activeTrade = null;
  let latestConfirmed = null;

  for (let i = 1; i < de.length; i++) {
    const cur = de[i];
    const prev = de[i - 1];
    const curCloseTime = cur.closeTime || cur.time;

    // Sinkronisasi ketat berdasarkan candle yang SUDAH TERTUTUP (tanpa look-ahead bias)
    while (tIdx + 1 < dt.length && (dt[tIdx + 1].closeTime || dt[tIdx + 1].time) <= curCloseTime) tIdx++;
    while (pIdx + 1 < dp.length && (dp[pIdx + 1].closeTime || dp[pIdx + 1].time) <= curCloseTime) pIdx++;

    const trBar = dt[tIdx];
    const trPrev = tIdx > 0 ? dt[tIdx - 1] : trBar;
    const pbBar = dp[pIdx];

    if (!finite(trBar.e125) || !finite(trBar.e21) || !finite(pbBar.e21) || !finite(cur.atr)) continue;

    // 1. Simulasi keluar posisi aktif (untuk backtest historis)
    if (activeTrade) {
      const hitSL = activeTrade.dir === "BUY" ? cur.low <= activeTrade.sl : cur.high >= activeTrade.sl;
      const hitTP = activeTrade.dir === "BUY" ? cur.high >= activeTrade.tp : cur.low <= activeTrade.tp;
      if (hitSL || hitTP) {
        const out = hitSL ? "SL" : "TP";
        const grossR = out === "TP" ? rrRatio : -1.0;
        const costR = (2 * costPct * activeTrade.entry) / activeTrade.risk;
        activeTrade.outcome = out;
        activeTrade.netR = grossR - costR;
        activeTrade.exitTime = cur.time;
        trades.push(activeTrade);
        activeTrade = null;
      }
    }

    // 2. Evaluasi Trend Filter (Timeframe Utama 1H)
    const struct = checkSwingStructure(dt, tIdx);
    const isBullTrend = trBar.close > trBar.e125 && trBar.e8 > trBar.e21 && trBar.e21 > trPrev.e21 && struct.hhHl;
    const isBearTrend = trBar.close < trBar.e125 && trBar.e8 < trBar.e21 && trBar.e21 < trPrev.e21 && struct.lhLl;

    const newTrend = isBullTrend ? "BULLISH" : isBearTrend ? "BEARISH" : "NEUTRAL";

    // Reset state jika tren berubah atau batal
    if (newTrend === "NEUTRAL") {
      state = trendDir !== "NEUTRAL" ? "INVALIDATED" : "WAITING";
      trendDir = "NEUTRAL";
      pullbackSide = null;
      pullbackConsumed = false;
      pullbackBars = 0;
      continue;
    }

    if (newTrend !== trendDir) {
      trendDir = newTrend;
      state = "TREND_DETECTED";
      pullbackSide = null;
      pullbackConsumed = false;
      pullbackBars = 0;
    }

    // 3. Deteksi Pullback ke area EMA 8 atau EMA 21 dengan toleransi ATR (Timeframe 15M)
    const tol = pbBar.atr * atrTol;
    const bullTouch = pbBar.low <= Math.max(pbBar.e8, pbBar.e21) + tol && pbBar.close > trBar.e125;
    const bearTouch = pbBar.high >= Math.min(pbBar.e8, pbBar.e21) - tol && pbBar.close < trBar.e125;

    // Jika harga menjauh kembali di atas EMA 8 setelah pullback dikonsumsi, izinkan siklus pullback berikutnya
    if (pullbackConsumed) {
      if ((trendDir === "BULLISH" && pbBar.low > pbBar.e8 + tol) ||
          (trendDir === "BEARISH" && pbBar.high < pbBar.e8 - tol)) {
        pullbackConsumed = false;
        state = "TREND_DETECTED";
      }
    }

    if (!pullbackConsumed && (state === "TREND_DETECTED" || state === "INVALIDATED")) {
      if (trendDir === "BULLISH" && bullTouch) {
        state = "PULLBACK_DETECTED";
        pullbackSide = "BUY";
        pullbackBars = 0;
      } else if (trendDir === "BEARISH" && bearTouch) {
        state = "PULLBACK_DETECTED";
        pullbackSide = "SELL";
        pullbackBars = 0;
      }
    }

    // 4. Konfirmasi Candle (Timeframe Entry 5M) setelah Pullback
    if (state === "PULLBACK_DETECTED" && !pullbackConsumed) {
      pullbackBars++;
      // Invalidasi jika pullback terlalu dalam melewati EMA 21 + 1 ATR atau terlalu lama (>12 bar)
      const invalidBull = pullbackSide === "BUY" && (cur.close < pbBar.e21 - pbBar.atr || pullbackBars > 12);
      const invalidBear = pullbackSide === "SELL" && (cur.close > pbBar.e21 + pbBar.atr || pullbackBars > 12);

      if (invalidBull || invalidBear) {
        state = "INVALIDATED";
        pullbackSide = null;
        continue;
      }

      const bullConfirm = pullbackSide === "BUY" && cur.close > cur.open && cur.close > prev.high;
      const bearConfirm = pullbackSide === "SELL" && cur.close < cur.open && cur.close < prev.low;

      if ((bullConfirm || bearConfirm) && lastSignalCandle !== i) {
        const dir = bullConfirm ? "BUY" : "SELL";
        const entry = cur.close;
        const lookback = de.slice(Math.max(0, i - 10), i + 1);
        let sl;
        if (dir === "BUY") {
          const swLow = Math.min(...lookback.map(x => x.low)) - cur.atr * 0.15;
          sl = swLow < entry ? swLow : entry - cur.atr * 1.5;
        } else {
          const swHigh = Math.max(...lookback.map(x => x.high)) + cur.atr * 0.15;
          sl = swHigh > entry ? swHigh : entry + cur.atr * 1.5;
        }
        const risk = Math.abs(entry - sl);
        if (risk > 0) {
          const tp = dir === "BUY" ? entry + risk * rrRatio : entry - risk * rrRatio;
          state = dir === "BUY" ? "BUY_CONFIRMED" : "SELL_CONFIRMED";
          pullbackConsumed = true;
          lastSignalCandle = i;

          const sigObj = {
            index: i,
            candleTime: cur.time,
            dir,
            entry,
            sl,
            tp,
            risk,
            rrRatio,
            ema8: cur.e8,
            ema21: cur.e21,
            ema125: trBar.e125,
            state
          };
          latestConfirmed = sigObj;
          if (!activeTrade) activeTrade = { ...sigObj };
        }
      }
    }
  }

  const lastEntry = de[de.length - 1];
  const lastTrend = dt[dt.length - 1];
  const isFreshSignal = latestConfirmed && (de.length - 1 - latestConfirmed.index <= 2);

  return {
    ready: true,
    strategy: "EMA_EXPERT",
    trend: trendDir,
    ema8: lastEntry.e8,
    ema21: lastEntry.e21,
    ema125: lastTrend.e125,
    pullbackStatus: state === "PULLBACK_DETECTED" || isFreshSignal ? "PULLBACK_CONFIRMED" : "WAITING_PULLBACK",
    confirmationStatus: isFreshSignal ? "CONFIRMED" : "WAITING_CONFIRMATION",
    signal: isFreshSignal ? latestConfirmed.dir : "WAIT",
    signalStatus: isFreshSignal ? latestConfirmed.state : state,
    entryPrice: isFreshSignal ? latestConfirmed.entry : null,
    stopLoss: isFreshSignal ? latestConfirmed.sl : null,
    takeProfit: isFreshSignal ? latestConfirmed.tp : null,
    riskReward: rrRatio,
    candleTime: lastEntry.time,
    trades
  };
}

function summarizeEmaTrades(trades) {
  const n = trades.length;
  if (!n) return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, netR: 0, maxDrawdownR: 0, avgRR: 0 };
  const wins = trades.filter(t => t.outcome === "TP");
  const losses = trades.filter(t => t.outcome === "SL");
  const grossWin = wins.reduce((s, t) => s + Math.max(0, t.netR), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + Math.min(0, t.netR), 0));
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.netR;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return {
    totalTrades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: +(100 * wins.length / n).toFixed(2),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 99 : 0),
    netR: +equity.toFixed(2),
    maxDrawdownR: +maxDD.toFixed(2),
    avgRR: +mean(trades.map(t => t.rrRatio)).toFixed(2)
  };
}

function backtestEmaExpertMTF(data, opts = {}) {
  const evalRes = evaluateEmaExpertHistory(data, opts);
  if (!evalRes.ready) return { ok: false, reason: evalRes.reason };
  const allTrades = evalRes.trades;
  const splitIdx = Math.floor(allTrades.length * 0.7);
  return {
    ok: true,
    all: summarizeEmaTrades(allTrades),
    buy: summarizeEmaTrades(allTrades.filter(t => t.dir === "BUY")),
    sell: summarizeEmaTrades(allTrades.filter(t => t.dir === "SELL")),
    inSample: summarizeEmaTrades(allTrades.slice(0, splitIdx)),
    outOfSample: summarizeEmaTrades(allTrades.slice(splitIdx))
  };
}

function computeEmaExpertMTF(data, opts = {}) {
  const evalRes = evaluateEmaExpertHistory(data, opts);
  if (!evalRes.ready) return evalRes;
  const bt = backtestEmaExpertMTF(data, opts);
  return { ...evalRes, backtest: bt.ok ? bt : null };
}


function evaluateVolumeConfirmation(candles, minRvol = 1.15) {
  const idx = Array.isArray(candles) ? candles.length - 1 : -1;
  if (idx < 20 || !candles[idx]) return { ok: false, rvol: 0 };
  let sum = 0;
  for (let i = idx - 20; i < idx; i++) sum += Number(candles[i].volume) || 0;
  const avgVol = sum / 20;
  const curVol = Number(candles[idx].volume) || 0;
  const prevVol = Number(candles[idx - 1].volume) || 0;
  const rvol = avgVol > 0 ? curVol / avgVol : 0;
  return {
    ok: rvol >= minRvol && curVol > prevVol,
    rvol: Number(rvol.toFixed(2))
  };
}

const _origComputeEmaExpertMTF = computeEmaExpertMTF;
computeEmaExpertMTF = function(data, opts) {
  const res = _origComputeEmaExpertMTF(data, opts);
  if (!res || !res.ready) return res;
  const arr5m = Array.isArray(data) ? data : (data && (data.entry || data["5m"] || data.candles5m)) || [];
  const minRvol = (opts && Number.isFinite(+opts.minRvol)) ? +opts.minRvol : 1.15;
  const vol = evaluateVolumeConfirmation(arr5m, minRvol);
  res.volRatio = vol.rvol;
  if ((res.signal === "BUY" || res.signal === "SELL") && !vol.ok) {
    res.signal = "WAIT";
    res.signalStatus = "WAIT";
    res.confirmationStatus = "Menunggu konfirmasi volume (RVOL " + vol.rvol + "x < " + minRvol + "x)";
  }
  return res;
};

module.exports = { computeSignal, SIG, TA, computeEmaExpertMTF, backtestEmaExpertMTF };
