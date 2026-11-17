"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ZteF672YDriver } = require("./zteDriver");

const PORT = Number(process.env.SWC_PORT || 8765);
const PUBLIC_DIR = path.join(__dirname, "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".css": "text/css" };
const SWC_DIR = __dirname;
const DB_PATH = path.join(SWC_DIR, "data", "swc.db");
const TG_CFG_PATH = path.join(SWC_DIR, "..", "scanner", "telegramConfig.json");

const db = new DatabaseSync(DB_PATH);
const router = new ZteF672YDriver();
const sseClients = new Set();

let state = {
  routerOnline: false,
  lastScanAt: 0,
  lastError: "",
  autoAlertNewDevice: true
};

// Migrasi/ensure schema
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    mac TEXT PRIMARY KEY,
    ip TEXT,
    hostname TEXT,
    alias TEXT,
    conn_type TEXT,
    status TEXT DEFAULT "online",
    block_mode TEXT DEFAULT "none",
    is_known INTEGER DEFAULT 0,
    first_seen INTEGER,
    last_seen INTEGER
  );
  CREATE TABLE IF NOT EXISTS event_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac TEXT,
    event_type TEXT,
    detail TEXT,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac TEXT,
    action TEXT,
    start_time TEXT,
    end_time TEXT,
    enabled INTEGER DEFAULT 1
  );
`);

async function sendTelegram(text) {
  try {
    if (!fs.existsSync(TG_CFG_PATH)) return;
    const cfg = JSON.parse(fs.readFileSync(TG_CFG_PATH, "utf8"));
    if (!cfg.token || !cfg.chatId) return;
    await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        parse_mode: "HTML"
      }),
      signal: AbortSignal.timeout(6000)
    });
  } catch (e) {
    console.error("[TG Err]", e.message);
  }
}

function logEvent(mac, eventType, detail) {
  db.prepare("INSERT INTO event_logs (mac, event_type, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(mac || "-", eventType, detail, Date.now());
  db.prepare("DELETE FROM event_logs WHERE id NOT IN (SELECT id FROM event_logs ORDER BY id DESC LIMIT 150)").run();
}

function getSnapshot() {
  const devices = db.prepare("SELECT * FROM devices ORDER BY status DESC, last_seen DESC").all();
  const logs = db.prepare("SELECT * FROM event_logs ORDER BY id DESC LIMIT 30").all();
  const schedules = db.prepare("SELECT * FROM schedules ORDER BY id DESC").all();
  return { state, devices, logs, schedules };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(getSnapshot())}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

let blockSyncQueue = Promise.resolve();
function applyRouterBlocks() {
  const task = async () => {
    const blocked = db.prepare("SELECT mac FROM devices WHERE block_mode = 'blocked'").all().map(r => r.mac);
    await router.syncBlockedMacs(blocked);
  };
  const next = blockSyncQueue.then(task, task);
  blockSyncQueue = next.catch(() => {});
  return next;
}

async function pollDevices() {
  try {
    const active = await router.getConnectedDevices();
    const now = Date.now();
    const activeSet = new Set(active.map(d => d.mac));

    for (const dev of active) {
      const existing = db.prepare("SELECT * FROM devices WHERE mac = ?").get(dev.mac);
      if (!existing) {
        db.prepare(`
          INSERT INTO devices (mac, ip, hostname, alias, conn_type, status, block_mode, is_known, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, 'online', 'none', 0, ?, ?)
        `).run(dev.mac, dev.ip, dev.hostname, dev.hostname, dev.connType, now, now);

        logEvent(dev.mac, "NEW_DEVICE", `Perangkat baru terhubung: ${dev.hostname} (${dev.ip})`);
        if (state.autoAlertNewDevice) {
          sendTelegram(
            `🛡️ <b>SWC Wi-Fi Alert — Perangkat Baru</b>\n` +
            `• Nama: <code>${dev.hostname}</code>\n` +
            `• IP: <code>${dev.ip}</code>\n` +
            `• MAC: <code>${dev.mac}</code>`
          );
        }
      } else {
        db.prepare(`
          UPDATE devices SET ip = ?, hostname = ?, conn_type = ?, status = 'online', last_seen = ?
          WHERE mac = ?
        `).run(dev.ip, dev.hostname, dev.connType, now, dev.mac);
      }
    }

    const allStored = db.prepare("SELECT mac, status FROM devices").all();
    for (const row of allStored) {
      if (!activeSet.has(row.mac) && row.status === "online") {
        db.prepare("UPDATE devices SET status = 'offline' WHERE mac = ?").run(row.mac);
      }
    }

    state.routerOnline = true;
    state.lastScanAt = now;
    state.lastError = "";
  } catch (e) {
    state.routerOnline = false;
    state.lastError = e.message;
  }
  broadcast();
}

function checkSchedules() {
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);
  const rows = db.prepare("SELECT * FROM schedules WHERE enabled = 1").all();
  let changed = false;

  for (const s of rows) {
    const dev = db.prepare("SELECT * FROM devices WHERE mac = ?").get(s.mac);
    if (!dev) continue;
    const inWindow = s.start_time <= s.end_time
      ? (hhmm >= s.start_time && hhmm < s.end_time)
      : (hhmm >= s.start_time || hhmm < s.end_time);

    const targetMode = inWindow ? "blocked" : "none";
    if (dev.block_mode !== targetMode) {
      db.prepare("UPDATE devices SET block_mode = ? WHERE mac = ?").run(targetMode, s.mac);
      logEvent(s.mac, "SCHEDULE", `Jadwal otomatis: ${dev.alias || dev.hostname} -> ${targetMode === "blocked" ? "BLOKIR" : "IZINKAN"}`);
      changed = true;
    }
  }
  if (changed) {
    applyRouterBlocks().then(broadcast).catch(err => {
      state.lastError = err.message;
      broadcast();
    });
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 65536) req.destroy(); });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const sendJson = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  try {
    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      res.write(`data: ${JSON.stringify(getSnapshot())}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(200, getSnapshot());
    }

    if (req.method === "POST" && url.pathname === "/api/scan") {
      await pollDevices();
      return sendJson(200, { ok: true, ...getSnapshot() });
    }

    if (req.method === "POST" && url.pathname === "/api/device/block") {
      const { mac, block } = await readJsonBody(req);
      if (!mac) return sendJson(400, { error: "MAC wajib diisi" });
      const normMac = mac.toLowerCase();
      const mode = block ? "blocked" : "none";
      const dev = db.prepare("SELECT * FROM devices WHERE mac = ?").get(normMac);
      const prevMode = dev ? dev.block_mode : "none";
      const label = dev ? (dev.alias || dev.hostname) : normMac;
      db.prepare("UPDATE devices SET block_mode = ? WHERE mac = ?").run(mode, normMac);

      try {
        await applyRouterBlocks();
      } catch (syncErr) {
        db.prepare("UPDATE devices SET block_mode = ? WHERE mac = ?").run(prevMode, normMac);
        throw syncErr;
      }
      logEvent(normMac, block ? "BLOCK" : "UNBLOCK", `${block ? "Memblokir" : "Membuka blokir"} ${label}`);
      sendTelegram(
        `${block ? "🚫" : "✅"} <b>SWC Wi-Fi — ${block ? "Perangkat Diblokir" : "Blokir Dibuka"}</b>\n` +
        `• Perangkat: <b>${label}</b>\n` +
        `• MAC: <code>${normMac}</code>`
      );
      broadcast();
      return sendJson(200, { ok: true, ...getSnapshot() });
    }

    if (req.method === "POST" && url.pathname === "/api/device/meta") {
      const { mac, alias, is_known } = await readJsonBody(req);
      if (!mac) return sendJson(400, { error: "MAC wajib diisi" });
      const normMac = mac.toLowerCase();
      if (typeof alias === "string") {
        db.prepare("UPDATE devices SET alias = ? WHERE mac = ?").run(alias.trim(), normMac);
      }
      if (typeof is_known !== "undefined") {
        db.prepare("UPDATE devices SET is_known = ? WHERE mac = ?").run(is_known ? 1 : 0, normMac);
      }
      logEvent(normMac, "UPDATE", `Memperbarui profil perangkat ${normMac}`);
      broadcast();
      return sendJson(200, { ok: true, ...getSnapshot() });
    }

    if (req.method === "POST" && url.pathname === "/api/schedule") {
      const { mac, start_time, end_time } = await readJsonBody(req);
      if (!mac || !start_time || !end_time) return sendJson(400, { error: "Data jadwal tidak lengkap" });
      db.prepare("INSERT INTO schedules (mac, action, start_time, end_time, enabled) VALUES (?, 'block', ?, ?, 1)")
        .run(mac.toLowerCase(), start_time, end_time);
      logEvent(mac.toLowerCase(), "SCHEDULE_ADD", `Jadwal blokir ${start_time} - ${end_time}`);
      checkSchedules();
      broadcast();
      return sendJson(200, { ok: true, ...getSnapshot() });
    }

    if (req.method === "DELETE" && url.pathname === "/api/schedule") {
      const id = Number(url.searchParams.get("id"));
      db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
      broadcast();
      return sendJson(200, { ok: true, ...getSnapshot() });
    }

    const relPath = url.pathname === "/" ? "/index.html" : (url.pathname === "/wifi" ? "/swc/public.html" : url.pathname);
    const filePath = path.normalize(path.join(PUBLIC_DIR, relPath));
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      return fs.createReadStream(filePath).pipe(res);
    }
    sendJson(404, { error: "Endpoint tidak ditemukan" });
  } catch (e) {
    sendJson(500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[SWC] Server aktif di http://127.0.0.1:${PORT}`);
  pollDevices();
  setInterval(pollDevices, 15000);
  setInterval(checkSchedules, 30000);
});
