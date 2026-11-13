/* ===========================================================================
   firebase-signals.js — membaca sinyal scanner lama (signals/) &
   EMA Expert Strategy (emaSignals/) dari Firebase Realtime Database.
   =========================================================================== */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getDatabase, ref, onValue, query, orderByChild, limitToLast }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBBFH_9haih7f7G3pfs2e8_aRkzpVH_Xdc",
  authDomain: "cryptosignalradar.firebaseapp.com",
  databaseURL: "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "cryptosignalradar",
  storageBucket: "cryptosignalradar.firebasestorage.app",
  messagingSenderId: "642949605337",
  appId: "1:642949605337:web:45d2c12879ebaa7000dbc8"
};

const MAX_ROWS = 50;
const STALE_MS = 20 * 60 * 1000;

if (!window.__octaFirebaseSignals) {
  window.__octaFirebaseSignals = true;
  start();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const fin = Number.isFinite;
function fmtP(n) {
  if (!fin(n)) return "--";
  const d = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtTime(t) {
  return fin(t) ? new Date(t).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";
}
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + " dtk lalu";
  if (s < 3600) return Math.round(s / 60) + " menit lalu";
  return Math.round(s / 3600) + " jam lalu";
}

function buildPanels() {
  const footer = document.querySelector("footer");
  const mount = (el) => {
    if (footer && footer.parentNode) footer.parentNode.insertBefore(el, footer);
    else (document.querySelector("main") || document.body).appendChild(el);
  };

  // Panel 1: Algoritma Lama (Dipertahankan)
  const sec = document.createElement("section");
  sec.className = "panel p-5 mb-6";
  sec.id = "fbSignalSection";
  sec.innerHTML =
    '<div class="flex flex-wrap justify-between gap-3 mb-2"><h2 class="text-lg font-bold">Sinyal Scanner · Algoritma Lama (Realtime)</h2>' +
    '<div class="flex flex-wrap gap-2"><span id="fbConn" class="badge unknown">Firebase: menghubungkan...</span>' +
    '<span id="fbScan" class="badge unknown">Scanner: menunggu data</span></div></div>' +
    '<div id="fbInfo" class="muted text-xs mb-4">Menunggu data dari Firebase...</div>' +
    '<div class="overflow-x-auto"><table><thead><tr><th>Koin</th><th>TF</th><th>Sinyal</th><th>Harga</th><th>Entry</th><th>Stop Loss</th><th>TP1</th><th>TP2</th><th>TP3</th><th>Skor</th><th>Candle</th><th>Diperbarui</th></tr></thead>' +
    '<tbody id="fbBody"><tr><td colspan="12" class="muted text-center">Menunggu data...</td></tr></tbody></table></div>';
  mount(sec);

  // Panel 2: EMA Expert Strategy (Baru & Terpisah)
  const emaSec = document.createElement("section");
  emaSec.className = "panel p-5 mb-6";
  emaSec.id = "fbEmaSignalSection";
  emaSec.innerHTML =
    '<div class="flex flex-wrap justify-between gap-3 mb-2"><h2 class="text-lg font-bold">Sinyal Scanner · EMA Expert Strategy MTF (Realtime)</h2>' +
    '<div class="flex flex-wrap gap-2"><span id="fbEmaBadge" class="badge unknown">EMA Expert: menunggu data</span></div></div>' +
    '<div id="fbEmaInfo" class="muted text-xs mb-4">Menunggu hasil pemindaian EMA 8 / 21 / 125 (GitHub Actions & Termux Bot)...</div>' +
    '<div class="overflow-x-auto"><table><thead><tr><th>Koin</th><th>MTF</th><th>Trend</th><th>Sinyal</th><th>Entry</th><th>Stop Loss</th><th>TP (1:1)</th><th>EMA 8 / 21 / 125</th><th>Winrate BT</th><th>Sumber</th><th>Diperbarui</th></tr></thead>' +
    '<tbody id="fbEmaBody"><tr><td colspan="11" class="muted text-center">Menunggu sinyal EMA Expert...</td></tr></tbody></table></div>';
  mount(emaSec);
}

function setBadge(id, cls, text) {
  const e = document.getElementById(id);
  if (e) { e.className = "badge " + cls; e.textContent = text; }
}

function start() {
  buildPanels();
  const state = { lastRun: null, runOk: null, msg: "", readError: false };

  let app;
  try { app = getApps().length ? getApp() : initializeApp(firebaseConfig); }
  catch (e) { console.error("Firebase init gagal", e); setBadge("fbConn", "reject", "Firebase: gagal inisialisasi"); return; }
  const db = getDatabase(app);

  function renderScanner() {
    const el = document.getElementById("fbInfo");
    if (state.readError) { setBadge("fbScan", "unknown", "Scanner: tidak diketahui"); return; }
    if (!state.lastRun) { setBadge("fbScan", "unknown", "Scanner: menunggu data"); if (el) el.textContent = "Scanner belum pernah menulis status ke Firebase."; return; }
    const age = Date.now() - state.lastRun;
    if (state.runOk === false) setBadge("fbScan", "reject", "Scanner: terakhir gagal");
    else if (age > STALE_MS) setBadge("fbScan", "warning", "Scanner: terlambat");
    else setBadge("fbScan", "pass", "Scanner: aktif");
    if (el) el.textContent = "Data terakhir diperbarui: " + fmtTime(state.lastRun) + " (" + ago(age) + ")" + (state.msg ? " · " + state.msg : "");
  }

  onValue(ref(db, ".info/connected"), snap => {
    if (snap.val() === true) setBadge("fbConn", "pass", "Firebase: terhubung");
    else setBadge("fbConn", "warning", "Firebase: terputus / menghubungkan");
  });

  onValue(ref(db, "scannerStatus"), snap => {
    state.readError = false;
    const v = snap.val();
    if (v && typeof v === "object" && fin(v.lastRun)) {
      state.lastRun = v.lastRun; state.runOk = v.ok === true ? true : v.ok === false ? false : null;
      state.msg = fin(v.scanned) ? v.scanned + " pasangan×TF dipindai, BUY " + (v.buy || 0) + ", SELL " + (v.sell || 0) : "";
    }
    renderScanner();
  }, err => {
    state.readError = true;
    setBadge("fbConn", "reject", "Firebase: gagal membaca (" + (err && err.code ? err.code : "error") + ")");
    renderScanner();
  });

  // Listener 1: Algoritma Lama
  onValue(query(ref(db, "signals"), orderByChild("updatedAt"), limitToLast(MAX_ROWS)), snap => {
    const rows = [];
    snap.forEach(ch => {
      const v = ch.val();
      if (v && (v.signal === "BUY" || v.signal === "SELL") && typeof v.symbol === "string" &&
        ["price", "entryLow", "entryHigh", "stopLoss", "tp1", "tp2", "tp3"].every(k => fin(v[k]))) rows.push(v);
    });
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const body = document.getElementById("fbBody");
    if (!body) return;
    body.innerHTML = rows.length ? rows.map(v => {
      const buy = v.signal === "BUY";
      return `<tr><td><b>${esc(v.symbol)}</b></td><td>${esc(v.timeframe || "--")}</td>` +
        `<td><span class="badge ${buy ? "up" : "down"}">${buy ? "BUY" : "SELL/SHORT"}</span></td>` +
        `<td>${fmtP(v.price)}</td><td>${fmtP(v.entryLow)} - ${fmtP(v.entryHigh)}</td><td>${fmtP(v.stopLoss)}</td>` +
        `<td>${fmtP(v.tp1)}</td><td>${fmtP(v.tp2)}</td><td>${fmtP(v.tp3)}</td>` +
        `<td>${fin(v.strength) ? v.strength + "/100" : "--"}</td><td>${fmtTime(v.candleTime)}</td><td>${fmtTime(v.updatedAt)}</td></tr>`;
    }).join("") : '<tr><td colspan="12" class="muted text-center">Scanner belum menghasilkan sinyal.</td></tr>';
  });

  // Listener 2: EMA Expert Strategy
  onValue(query(ref(db, "emaSignals"), orderByChild("updatedAt"), limitToLast(MAX_ROWS)), snap => {
    const rows = [];
    snap.forEach(ch => {
      const v = ch.val();
      if (v && (v.signal === "BUY" || v.signal === "SELL") && typeof v.symbol === "string" &&
        ["entryPrice", "stopLoss", "takeProfit"].every(k => fin(v[k]))) rows.push(v);
    });
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    setBadge("fbEmaBadge", rows.length ? "pass" : "unknown", `EMA Expert: ${rows.length} sinyal`);
    const body = document.getElementById("fbEmaBody");
    if (!body) return;
    body.innerHTML = rows.length ? rows.map(v => {
      const buy = v.signal === "BUY";
      const trCls = v.trend === "BULLISH" ? "up" : v.trend === "BEARISH" ? "down" : "neutral";
      return `<tr><td><b>${esc(v.symbol)}</b></td><td>${esc(v.mtfConfig || "1h>15m>5m")}</td>` +
        `<td><span class="badge ${trCls}">${esc(v.trend || "--")}</span></td>` +
        `<td><span class="badge ${buy ? "up" : "down"}">${buy ? "BUY" : "SELL"}</span></td>` +
        `<td>${fmtP(v.entryPrice)}</td><td>${fmtP(v.stopLoss)}</td><td>${fmtP(v.takeProfit)}</td>` +
        `<td>${fmtP(v.ema8)} / ${fmtP(v.ema21)} / ${fmtP(v.ema125)}</td>` +
        `<td>${fin(v.winRate) ? v.winRate + "% (" + (v.totalTrades || 0) + ")" : "--"}</td>` +
        `<td><span class="badge unknown">${esc(v.source || "--")}</span></td>` +
        `<td>${fmtTime(v.updatedAt)}</td></tr>`;
    }).join("") : '<tr><td colspan="11" class="muted text-center">Belum ada sinyal EMA Expert terkonfirmasi.</td></tr>';
  });

  setInterval(renderScanner, 30000);
}
