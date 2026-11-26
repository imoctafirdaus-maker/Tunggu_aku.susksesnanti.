const fs = require("fs");
const assert = require("assert");
let html = fs.readFileSync("index.html", "utf8");

const jsStart = html.indexOf("const EMA_EXP = {");
const jsEnd = html.indexOf("/* ================= EARLY VOLUME RADAR (RINGKAS & PARALEL) ================= */");
assert(jsStart !== -1 && jsEnd > jsStart, "Objek EMA_EXP di index.html tidak ditemukan");

const newJs = `const EMA_EXP = {
  data: null, stateStatus: "WAITING", latestSignal: null, remoteSync: null, marketSnap: null,

  async syncRemoteEmaSignals() {
    try {
      const base = "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app";
      const [resSig, resMkt] = await Promise.all([
        fetch(\`\${base}/emaSignals.json?t=\${Date.now()}\`),
        fetch(\`\${base}/marketData/\${encodeURIComponent(CONFIG.symbol)}.json?t=\${Date.now()}\`).catch(() => null)
      ]);
      if (resMkt && resMkt.ok) {
        const mkt = await resMkt.json();
        if (mkt && typeof mkt === "object") this.marketSnap = mkt;
      }
      if (resSig && resSig.ok) {
        const all = await resSig.json();
        if (all && typeof all === "object") {
          const list = Object.entries(all)
            .filter(([k, v]) => !k.startsWith("_") && v && v.symbol === CONFIG.symbol)
            .map(([, v]) => v)
            .sort((a, b) => (b.updatedAt || b.timestamp || 0) - (a.updatedAt || a.timestamp || 0));
          if (list.length) this.remoteSync = list[0];
        }
      }
      this.renderUI();
    } catch (_) {}
  },

  async init() {
    const trTf = $("emaTrendTf").value, puTf = $("emaPullTf").value, enTf = $("emaEntryTf").value;
    $("emaBadge").textContent = "MEMUAT ICT + VD..."; $("emaBadge").className = "badge warning";
    try {
      const fetchKlines = async (tf, lim = 120) => {
        try {
          const r = await fetch(\`https://fapi.binance.com/fapi/v1/klines?symbol=\${encodeURIComponent(CONFIG.symbol)}&interval=\${tf}&limit=\${lim}\`);
          if (r.ok) {
            const d = await r.json();
            if (Array.isArray(d) && d.length > 10) {
              return d.slice(0, -1).map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], takerBuyBase: +k[9] }));
            }
          }
        } catch (_) {}
        const { data } = await apiFetch(\`/api/v3/klines?symbol=\${encodeURIComponent(CONFIG.symbol)}&interval=\${tf}&limit=\${lim}\`);
        return data.slice(0, -1).map(d => ({ time: +d[0], open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5], takerBuyBase: +d[9] }));
      };

      const fetchAggVd = async () => {
        try {
          const r = await fetch(\`https://fapi.binance.com/fapi/v1/aggTrades?symbol=\${encodeURIComponent(CONFIG.symbol)}&limit=1000\`);
          if (r.ok) {
            const trades = await r.json();
            if (Array.isArray(trades) && trades.length) {
              const seen = new Set(), buckets = new Map();
              for (const t of trades) {
                if (seen.has(t.a)) continue;
                seen.add(t.a);
                const m = Math.floor(+t.T / 60000) * 60000;
                const b = buckets.get(m) || { time: m, open: +t.p, high: +t.p, low: +t.p, close: +t.p, volume: 0, buyVol: 0, sellVol: 0 };
                b.high = Math.max(b.high, +t.p); b.low = Math.min(b.low, +t.p); b.close = +t.p; b.volume += +t.q;
                if (t.m) b.sellVol += +t.q; else b.buyVol += +t.q;
                buckets.set(m, b);
              }
              return [...buckets.values()].sort((a, b) => a.time - b.time).map(b => ({ ...b, delta: b.buyVol - b.sellVol }));
            }
          }
        } catch (_) {}
        return [];
      };

      const [dt, dp, de, agg1m] = await Promise.all([fetchKlines(trTf), fetchKlines(puTf), fetchKlines(enTf), fetchAggVd()]);
      this.runLogic(dt, dp, de, agg1m);
      this.syncRemoteEmaSignals();
    } catch (_) {
      $("emaBadge").textContent = "GAGAL SINKRONISASI"; $("emaBadge").className = "badge reject";
    }
  },

  runLogic(dt, dp, de, agg1m) {
    if (!dt.length || !dp.length || !de.length) return;
    const atr5 = TA.atrSeries(dp.map(x => x.high), dp.map(x => x.low), dp.map(x => x.close), 14).slice(-1)[0] || 0;
    const rec15 = dt.slice(-24);
    const hi15 = Math.max(...rec15.map(x => x.high)), lo15 = Math.min(...rec15.map(x => x.low)), eq15 = (hi15 + lo15) / 2;
    const last15 = dt[dt.length - 1], mid15 = dt[Math.max(0, dt.length - 12)].close;
    const bias15m = last15.close > eq15 && last15.close > mid15 ? "BULLISH" : (last15.close < eq15 && last15.close < mid15 ? "BEARISH" : "RANGING");
    const pct = hi15 > lo15 ? Math.round(((last15.close - lo15) / (hi15 - lo15)) * 100) : 50;
    const zoneLabel = pct <= 45 ? \`DISCOUNT (\${pct}%)\` : (pct >= 55 ? \`PREMIUM (\${pct}%)\` : \`EQUILIBRIUM (\${pct}%)\`);

    const last5 = dp[dp.length - 1], sw5 = dp.slice(-15, -1);
    const swHi5 = sw5.length ? Math.max(...sw5.map(x => x.high)) : last5.high;
    const swLo5 = sw5.length ? Math.min(...sw5.map(x => x.low)) : last5.low;
    const sweptSSL = last5.low < swLo5 && last5.close > swLo5;
    const sweptBSL = last5.high > swHi5 && last5.close < swHi5;

    let fvgLabel = "NONE";
    if (dp.length >= 3) {
      const c1 = dp[dp.length - 3], c3 = dp[dp.length - 1];
      if (c3.low > c1.high) fvgLabel = "BULLISH_FVG";
      else if (c3.high < c1.low) fvgLabel = "BEARISH_FVG";
    }

    const vdSrc = agg1m.length >= 3 ? agg1m : de.slice(-20).map(c => ({ ...c, delta: 2 * (fin(c.takerBuyBase) ? c.takerBuyBase : c.volume * 0.5) - c.volume }));
    const lastVd = vdSrc[vdSrc.length - 1] || { delta: 0 };
    const cvd = vdSrc.reduce((s, x) => s + (x.delta || 0), 0);
    const vdDir = lastVd.delta > 0 ? "BUY_DELTA" : (lastVd.delta < 0 ? "SELL_DELTA" : "NEUTRAL");

    let score = 0; const reasons = [];
    if (bias15m !== "RANGING") { score += 20; reasons.push(\`Bias 15m \${bias15m}\`); }
    if ((bias15m === "BULLISH" && pct <= 50) || (bias15m === "BEARISH" && pct >= 50)) { score += 15; reasons.push(zoneLabel); }
    if (sweptSSL || sweptBSL) { score += 20; reasons.push(sweptSSL ? "SSL Sweep" : "BSL Sweep"); }
    if (fvgLabel !== "NONE") { score += 15; reasons.push(fvgLabel); }
    if ((bias15m === "BULLISH" && lastVd.delta > 0 && cvd > 0) || (bias15m === "BEARISH" && lastVd.delta < 0 && cvd < 0)) { score += 25; reasons.push(\`True VD & CVD \${vdDir}\`); }
    else if (lastVd.delta !== 0) score += 10;

    const dir = bias15m === "BULLISH" && lastVd.delta > 0 ? "BUY" : (bias15m === "BEARISH" && lastVd.delta < 0 ? "SELL" : "WAIT");
    this.data = { bias15m, zoneLabel, sweptSSL, sweptBSL, fvgLabel, lastDelta: lastVd.delta, cvd, score, reasons };
    this.stateStatus = score >= 75 && dir !== "WAIT" ? \`\${dir}_CONFIRMED\` : (sweptSSL || sweptBSL ? "SWEEP_DETECTED" : "SCANNING_POI");

    if (dir !== "WAIT" && score >= 75 && atr5 > 0) {
      const entry = last5.close;
      const sl = dir === "BUY" ? Math.min(swLo5, last5.low) - atr5 * 0.25 : Math.max(swHi5, last5.high) + atr5 * 0.25;
      const risk = Math.abs(entry - sl), rrRatio = score >= 85 ? 3.0 : 2.0;
      this.latestSignal = { dir, entry, sl, tp1: dir === "BUY" ? entry + risk * 2 : entry - risk * 2, tp2: dir === "BUY" ? entry + risk * rrRatio : entry - risk * rrRatio, rrRatio, score, reasons: reasons.join(" · "), time: last5.time, eligibleFor50x: true };
    } else this.latestSignal = null;

    this.renderUI();
    this.triggerFirebase();
  },

  renderUI() {
    const sync = this.remoteSync, mkt = this.marketSnap;
    $("emaBadge").textContent = isBotEnabled() ? "TERHUBUNG (ICT + VD · ≥75%)" : "STANDBY (MASTER OFF)";
    $("emaBadge").className = isBotEnabled() ? "badge pass" : "badge warning";

    if (sync && (sync.signal === "BUY" || sync.signal === "SELL")) {
      const ict = sync.ictEvidence || {}, vd = sync.volumeDeltaEvidence || {}, sc = Number(sync.score ?? sync.probability ?? 0);
      $("emaState").textContent = sync.category || sync.signal;
      $("emaStateSub").textContent = sync.aiAuditReason || sync.reason || "Terkonfirmasi Scanner Backend";
      const b15 = ict.marketDirection15m || sync.trend || "NEUTRAL";
      $("emaTrend").textContent = b15; $("emaTrendSub").textContent = ict.premiumDiscount || "Dealing Range 15m";
      setCard("emaTrendCard", b15 === "BULLISH" ? "card-bullish" : b15 === "BEARISH" ? "card-bearish" : "card-neutral");
      $("emaPull").textContent = \`VD: \${fmt(vd.delta || 0, 1)} | CVD: \${vd.cvdDirection || "--"}\`;
      $("emaPullSub").textContent = [ict.liquidityStatus, ict.fvg, ict.orderBlock].filter(x => x && x !== "NONE" && x !== "NO_RECENT_SWEEP").join(" · ") || "POI Tervalidasi";
      setCard("emaPullCard", (vd.delta || 0) >= 0 ? "card-bullish" : "card-bearish");
      $("emaSig").textContent = \`\${sync.signal} (Skor \${sc}/100)\`; $("emaSigSub").textContent = sync.reason || fmtTime(sync.updatedAt);
      setCard("emaSigCard", sync.signal === "BUY" ? "card-bullish" : "card-bearish");
      $("emaPlan").style.display = "block"; $("emaEntryVal").textContent = fmtP(sync.entryPrice); $("emaSlVal").textContent = fmtP(sync.stopLoss);
      $("emaTpLabel").textContent = \`TAKE PROFIT (1:\${sync.riskReward || 2})\`;
      $("emaTpVal").textContent = fin(sync.takeProfit2) ? \`\${fmtP(sync.takeProfit1 || sync.takeProfit)} / \${fmtP(sync.takeProfit2)}\` : fmtP(sync.takeProfit);
      $("emaBtVal").textContent = \`Skor \${sc}/100\`; $("emaBtSub").textContent = sc >= 75 ? "⚡ LOLOS GERBANG ≥75%" : "👀 PANTAU (<75%)";
      return;
    }

    if (!this.data && !mkt) return;
    const d = this.data || {}, bias = mkt?.bias15m || d.bias15m || "RANGING", zone = mkt?.premiumDiscount || d.zoneLabel || "--", sc = fin(mkt?.score) ? mkt.score : (d.score || 0);
    $("emaState").textContent = this.stateStatus;
    $("emaStateSub").textContent = (d.reasons && d.reasons.length) ? d.reasons.join(" · ") : "Menunggu konfluensi ICT + SMC + True VD";
    $("emaTrend").textContent = bias; $("emaTrendSub").textContent = zone;
    setCard("emaTrendCard", bias === "BULLISH" ? "card-bullish" : bias === "BEARISH" ? "card-bearish" : "card-neutral");
    const deltaVal = fin(mkt?.delta1m) ? mkt.delta1m : (d.lastDelta || 0), cvdDir = mkt?.cvdDirection || (d.cvd >= 0 ? "BULLISH" : "BEARISH");
    $("emaPull").textContent = \`VD: \${fmt(deltaVal, 1)} | CVD: \${cvdDir}\`;
    $("emaPullSub").textContent = [mkt?.sweep !== "NONE" ? mkt?.sweep : (d.sweptSSL ? "SSL_SWEEP" : d.sweptBSL ? "BSL_SWEEP" : null), mkt?.fvg !== "NONE" ? mkt?.fvg : d.fvgLabel].filter(x => x && x !== "NONE").join(" · ") || "Menunggu Sweep / FVG / OB";
    setCard("emaPullCard", deltaVal >= 0 ? "card-bullish" : "card-bearish");

    if (this.latestSignal) {
      const sig = this.latestSignal;
      $("emaSig").textContent = \`Sinyal \${sig.dir} (\${sig.score}/100)\`; $("emaSigSub").textContent = \`⚡ Lolos ≥75% · \${fmtTime(sig.time)}\`;
      setCard("emaSigCard", sig.dir === "BUY" ? "card-bullish" : "card-bearish");
      $("emaPlan").style.display = "block"; $("emaEntryVal").textContent = fmtP(sig.entry); $("emaSlVal").textContent = fmtP(sig.sl);
      $("emaTpLabel").textContent = \`TAKE PROFIT (1:\${sig.rrRatio || 2})\`; $("emaTpVal").textContent = \`\${fmtP(sig.tp1)} / \${fmtP(sig.tp2)}\`;
      $("emaBtVal").textContent = \`Skor \${sig.score}/100\`; $("emaBtSub").textContent = "⚡ SIAP EKSEKUSI FUTURES";
    } else {
      $("emaSig").textContent = \`MENUNGGU (\${sc}/100)\`; $("emaSigSub").textContent = "Belum mencapai ambang konfluensi ≥ 75%";
      setCard("emaSigCard", "card-neutral"); $("emaPlan").style.display = "none";
    }
  },

  triggerFirebase() {
    if (!this.latestSignal || !isBotEnabled()) return;
    const sig = this.latestSignal;
    const payload = { symbol: CONFIG.symbol, timestamp: Date.now(), strategy: "ICT_SMC_VD", trendTf: $("emaTrendTf").value, pullbackTf: $("emaPullTf").value, entryTf: $("emaEntryTf").value, signal: sig.dir, entryPrice: sig.entry, stopLoss: sig.sl, takeProfit: sig.tp1, takeProfit2: sig.tp2, riskReward: \`1:\${sig.rrRatio || 2}\`, score: sig.score, probability: sig.score, minExecProb: MIN_EXEC_PROB, eligibleFor50x: sig.eligibleFor50x, reason: sig.reasons, status: this.stateStatus };
    window.emaExpertLastPayload = payload;
    window.dispatchEvent(new CustomEvent("onEmaExpertSignal", { detail: payload }));
  }
};

`;
html = html.slice(0, jsStart) + newJs + html.slice(jsEnd);
fs.writeFileSync("index.html", html);
const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)];
scripts.forEach(m => new Function(m[1]));
console.log("✅ index.html selesai & semua", scripts.length, "blok JS lolos validasi sintaks!");
