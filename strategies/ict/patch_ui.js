const fs = require("fs");
const assert = require("assert");
let html = fs.readFileSync("index.html", "utf8");

html = html
  .replace(/<title>[^<]*<\/title>/i, "<title>Binance Top 500 · Multi-Indicator + ICT & Volume Delta Expert + Early Volume Radar</title>")
  .replace(/<h1 class="text-2xl md:text-3xl font-extrabold mt-1">[^<]*<\/h1>/, '<h1 class="text-2xl md:text-3xl font-extrabold mt-1">Binance Top 500 · Multi-Indicator & ICT + Volume Delta Expert</h1>')
  .replace(/<p class="muted mt-1 text-sm">Monitoring sinyal 10 indikator teknikal[^<]*<\/p>/, '<p class="muted mt-1 text-sm">Monitoring sinyal 10 indikator teknikal, ICT + SMC + True Volume Delta (15m → 5m → 1m aggTrade), Dynamic R:R, dan Early Volume Radar.</p>')
  .replace("Kuota Gemini difokuskan 100% ke 3 EMA Expert", "Kuota Gemini difokuskan 100% ke ICT + Volume Delta Expert");

const secStart = html.indexOf("<!-- PANEL EMA EXPERT STRATEGY MTF -->");
const secEnd = html.indexOf("<!-- EARLY VOLUME RADAR (RINGKAS & AKTIF) -->");
assert(secStart !== -1 && secEnd > secStart, "Section EMA Expert tidak ditemukan");

const newSec = `<!-- PANEL ICT + SMC + TRUE VOLUME DELTA EXPERT MTF -->
<section class="panel p-5 mb-6" id="emaExpertSection">
  <div class="flex flex-wrap justify-between gap-3 mb-4">
    <div>
      <h2 class="text-lg font-bold">ICT + VOLUME DELTA EXPERT · Multi-Timeframe (15m → 5m → 1m)</h2>
      <p class="muted text-xs mt-1">Market Structure (BOS/CHoCH), Liquidity Sweep, FVG/OB, Premium/Discount, True Volume Delta (aggTrade) & Gerbang Skor ≥ 75%.</p>
    </div>
    <span id="emaBadge" class="badge unknown">MENUNGGU MTF...</span>
  </div>
  <div class="flex flex-wrap items-end gap-3 mb-4 border-b border-slate-700 pb-4">
    <label class="text-sm">Bias HTF<br><select id="emaTrendTf"><option value="15m" selected>15 Menit (15m)</option><option value="1h">1 Jam (1h)</option><option value="4h">4 Jam (4h)</option></select></label>
    <label class="text-sm">Setup & POI TF<br><select id="emaPullTf"><option value="5m" selected>5 Menit (5m)</option><option value="15m">15 Menit (15m)</option><option value="1h">1 Jam (1h)</option></select></label>
    <label class="text-sm">Order Flow TF<br><select id="emaEntryTf"><option value="1m" selected>1 Menit (1m aggTrade)</option><option value="5m">5 Menit (5m)</option></select></label>
    <button id="emaRefreshBtn" class="btn text-sm bg-sky-600 hover:bg-sky-500">Refresh & Sinkronisasi ICT + VD</button>
  </div>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
    <div class="indicator-card"><div class="muted text-xs mb-2">Struktur & Tahapan ICT</div><div id="emaState" class="indicator-value">--</div><div id="emaStateSub" class="indicator-status">--</div></div>
    <div id="emaTrendCard" class="indicator-card"><div class="muted text-xs mb-2">Bias HTF & Zona (15m)</div><div id="emaTrend" class="indicator-value">--</div><div id="emaTrendSub" class="indicator-status">--</div></div>
    <div id="emaPullCard" class="indicator-card"><div class="muted text-xs mb-2">SMC POI & True VD (1m)</div><div id="emaPull" class="indicator-value">--</div><div id="emaPullSub" class="indicator-status">--</div></div>
    <div id="emaSigCard" class="indicator-card"><div class="muted text-xs mb-2">Sinyal & Skor Konfluensi</div><div id="emaSig" class="indicator-value">--</div><div id="emaSigSub" class="indicator-status">--</div></div>
  </div>
  <div id="emaPlan" class="mt-4" style="display:none">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="indicator-card"><div class="muted text-xs mb-2">ENTRY ZONE / PRICE</div><div id="emaEntryVal" class="indicator-value font-bold text-sky-400">--</div></div>
      <div class="indicator-card card-bearish"><div class="muted text-xs mb-2">STOP LOSS (STRUKTURAL)</div><div id="emaSlVal" class="indicator-value">--</div></div>
      <div class="indicator-card card-bullish"><div class="muted text-xs mb-2">TAKE PROFIT (TP1 / TP2)</div><div id="emaTpLabel" class="indicator-value">--</div></div>
      <div class="indicator-card"><div class="muted text-xs mb-2">KONFLUENSI & GERBANG 75%</div><div id="emaBtVal" class="indicator-value">--</div><div id="emaBtSub" class="indicator-status">--</div></div>
    </div>
  </div>
</section>
`;
html = html.slice(0, secStart) + newSec + html.slice(secEnd);
fs.writeFileSync("index.html", html);
console.log("✅ HTML Section ICT + VD terpasang.");
