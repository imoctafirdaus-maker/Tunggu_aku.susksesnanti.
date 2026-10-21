/* ===========================================================================
   firebase-signals.js — membaca sinyal scanner dari Firebase Realtime Database
   Hanya MEMBACA (signals/ dan scannerStatus/). Tidak ada kredensial rahasia.
   Dipasang di index.html dengan satu baris:
     <script type="module" src="firebase-signals.js"></script>
   Panel dibuat otomatis oleh file ini, jadi bagian lain index.html tidak berubah.
   =========================================================================== */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getDatabase, ref, onValue, query, orderByChild, limitToLast }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "ISI_API_KEY_DARI_FIREBASE_CONSOLE",
  authDomain: "cryptosignalradar.firebaseapp.com",
  databaseURL: "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "cryptosignalradar",
  storageBucket: "cryptosignalradar.firebasestorage.app",
  messagingSenderId: "642949605337",
  appId: "1:642949605337:web:45d2c12879ebaa7000dbc8"
};

const MAX_ROWS = 50;
const STALE_MS = 20 * 60 * 1000;   // cron GitHub bisa terlambat; >20 menit dianggap terlambat

if (!window.__octaFirebaseSignals) {      // cegah dobel inisialisasi / listener ganda
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

function buildPanel() {
  const sec = document.createElement("section");
  sec.className = "panel p-5 mb-6";
  sec.id = "fbSignalSection";
  sec.innerHTML =
    '<div class="flex flex-wrap justify-between gap-3 mb-2"><h2 class="text-lg font-bold">Sinyal Scanner · GitHub Actions → Firebase (Realtime)</h2>' +
    '<div class="flex flex-wrap gap-2"><span id="fbConn" class="badge unknown">Firebase: menghubungkan...</span>' +
    '<span id="fbScan" class="badge unknown">Scanner: menunggu data</span></div></div>' +
    '<div id="fbInfo" class="muted text-xs mb-4">Menunggu data dari Firebase...</div>' +
    '<div class="overflow-x-auto"><table><thead><tr><th>Koin</th><th>TF</th><th>Sinyal</th><th>Harga</th><th>Entry</th><th>Stop Loss</th><th>TP1</th><th>TP2</th><th>TP3</th><th>Skor</th><th>Candle</th><th>Diperbarui</th></tr></thead>' +
    '<tbody id="fbBody"><tr><td colspan="12" class="muted text-center">Menunggu data...</td></tr></tbody></table></div>' +
    '<p class="chart-note mt-3">Data dihasilkan scanner GitHub Actions dan hanya dibaca di sini. Status koneksi Firebase dan status scanner adalah dua hal berbeda. Bukan saran investasi.</p>';
  const footer = document.querySelector("footer");
  if (footer && footer.parentNode) footer.parentNode.insertBefore(sec, footer);
  else (document.querySelector("main") || document.body).appendChild(sec);
  return sec;
}

function setBadge(id, cls, text) {
  const e = document.getElementById(id);
  if (e) { e.className = "badge " + cls; e.textContent = text; }
}

function start() {
  buildPanel();
  const state = { lastRun: null, runOk: null, sigCount: null, readError: false };

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
    if (el) el.textContent = "Data terakhir diperbarui: " + fmtTime(state.lastRun) + " (" + ago(age) + ")" +
      (state.msg ? " · " + state.msg : "");
  }

  // 1) Status koneksi Firebase (hanya soal koneksi, bukan soal scanner)
  onValue(ref(db, ".info/connected"), snap => {
    if (snap.val() === true) setBadge("fbConn", "pass", "Firebase: terhubung");
    else setBadge("fbConn", "warning", "Firebase: terputus / menghubungkan");
  });

  // 2) Status scanner
  onValue(ref(db, "scannerStatus"), snap => {
    state.readError = false;
    const v = snap.val();
    if (v && typeof v === "object" && fin(v.lastRun)) {
      state.lastRun = v.lastRun; state.runOk = v.ok === true ? true : v.ok === false ? false : null;
      state.msg = (typeof v.message === "string" && v.message !== "OK") ? v.message :
        (fin(v.scanned) ? v.scanned + " pasangan×TF dipindai, BUY " + (v.buy || 0) + ", SELL " + (v.sell || 0) : "");
    } else { state.lastRun = null; }
    renderScanner();
  }, err => {
    console.warn("scannerStatus", err);
    state.readError = true;
    setBadge("fbConn", "reject", "Firebase: gagal membaca (" + (err && err.code ? err.code : "error") + ")");
    renderScanner();
  });

  // 3) Sinyal (realtime, satu listener saja)
  onValue(query(ref(db, "signals"), orderByChild("updatedAt"), limitToLast(MAX_ROWS)), snap => {
    const rows = []; let bad = 0;
    snap.forEach(ch => {
      const v = ch.val();
      const ok = v && typeof v === "object" && (v.signal === "BUY" || v.signal === "SELL") && typeof v.symbol === "string" &&
        ["price", "entryLow", "entryHigh", "stopLoss", "tp1", "tp2", "tp3"].every(k => fin(v[k]));
      if (ok) rows.push(v); else bad++;
    });
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const body = document.getElementById("fbBody");
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="12" class="muted text-center">' +
        (bad ? "Data ada tetapi formatnya tidak valid (" + bad + " entri dilewati)." : "Scanner belum menghasilkan sinyal.") + "</td></tr>";
      return;
    }
    body.innerHTML = rows.map(v => {
      const buy = v.signal === "BUY";
      return "<tr><td><b>" + esc(v.symbol) + "</b></td><td>" + esc(v.timeframe || "--") + "</td>" +
        '<td><span class="badge ' + (buy ? "up" : "down") + '">' + (buy ? "BUY" : "SELL/SHORT") + "</span></td>" +
        "<td>" + fmtP(v.price) + "</td><td>" + fmtP(v.entryLow) + " - " + fmtP(v.entryHigh) + "</td><td>" + fmtP(v.stopLoss) + "</td>" +
        "<td>" + fmtP(v.tp1) + "</td><td>" + fmtP(v.tp2) + "</td><td>" + fmtP(v.tp3) + "</td>" +
        "<td>" + (fin(v.strength) ? v.strength + "/100" : "--") + "</td><td>" + fmtTime(v.candleTime) + "</td><td>" + fmtTime(v.updatedAt) + "</td></tr>";
    }).join("") + (bad ? '<tr><td colspan="12" class="muted">' + bad + " entri tidak valid dilewati.</td></tr>" : "");
  }, err => {
    console.warn("signals", err);
    setBadge("fbConn", "reject", "Firebase: gagal membaca (" + (err && err.code ? err.code : "error") + ")");
    const body = document.getElementById("fbBody");
    if (body) body.innerHTML = '<tr><td colspan="12" class="muted text-center">Gagal membaca data. Periksa Security Rules Firebase.</td></tr>';
  });

  setInterval(renderScanner, 30000);   // perbarui teks "x menit lalu"
}
