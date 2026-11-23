
// [SWC-DIAG] Endpoint pengukuran latensi gateway & deteksi hambatan Wi-Fi
async function runNetDiag(devices = []) {
  const { exec } = require("child_process");
  const pingHost = (host) => new Promise((resolve) => {
    exec(`ping -c 3 -W 2 ${host}`, (err, stdout) => {
      const out = String(stdout || "");
      const lossMatch = out.match(/(\d+)%\s*packet\s*loss/i);
      const rttMatch = out.match(/rtt\s+min\/avg\/max\/mdev\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/i);
      resolve({
        ok: !err && !!rttMatch,
        loss: lossMatch ? parseInt(lossMatch[1], 10) : 100,
        min: rttMatch ? parseFloat(rttMatch[1]) : null,
        avg: rttMatch ? parseFloat(rttMatch[2]) : null,
        max: rttMatch ? parseFloat(rttMatch[3]) : null,
        jitter: rttMatch ? parseFloat(rttMatch[4]) : null
      });
    });
  });

  const [gw, wan] = await Promise.all([pingHost("192.168.1.1"), pingHost("1.1.1.1")]);
  const onlineDevs = (devices || []).filter(d => d.status === "online");
  const unknownOnline = onlineDevs.filter(d => !d.is_known);
  const issues = [];

  if (!gw.ok || gw.loss > 0) {
    issues.push({ level: "high", title: "Interferensi Sinyal / Packet Loss Lokal", detail: `Hilang paket ${gw.loss}% menuju router 192.168.1.1 (jarak terlalu jauh atau kanal Wi-Fi penuh).` });
  }
  if (gw.avg !== null && gw.avg > 25) {
    issues.push({ level: "high", title: "Latensi Lokal Router Tinggi (" + gw.avg + " ms)", detail: "Trafik Wi-Fi padat atau router ZTE F672Y mengalami antrean paket (bufferbloat)." });
  }
  if (gw.jitter !== null && gw.jitter > 15) {
    issues.push({ level: "warn", title: "Kestabilan Sinyal Fluktuatif (Jitter " + gw.jitter + " ms)", detail: "Sinyal Wi-Fi tidak stabil, menyebabkan game online atau video call tersendat." });
  }
  if (unknownOnline.length > 0) {
    issues.push({ level: "high", title: `${unknownOnline.length} Perangkat Asing Aktif Menyedot Bandwidth`, detail: unknownOnline.map(d => `${d.alias || d.hostname} (${d.ip})`).join(", ") });
  }
  if (onlineDevs.length >= 6) {
    issues.push({ level: "warn", title: `Kepadatan Klien Tinggi (${onlineDevs.length} Perangkat Online)`, detail: "Banyak perangkat aktif bersamaan membagi kapasitas airtime Wi-Fi 2.4GHz." });
  }
  if (gw.ok && (!wan.ok || (wan.avg !== null && wan.avg > 90))) {
    issues.push({ level: "warn", title: "Hambatan Jalur ISP / WAN Eksternal", detail: wan.ok ? `Ping internet tinggi (${wan.avg} ms) sementara Wi-Fi lokal normal.` : "Router terhubung, namun jalur internet ISP sedang putus/timeout." });
  }
  if (issues.length === 0) {
    issues.push({ level: "ok", title: "Tidak Ditemukan Hambatan Jaringan", detail: `Gateway 192.168.1.1 responsif (${gw.avg ?? "-"} ms) dan jalur internet normal (${wan.avg ?? "-"} ms).` });
  }

  return { ok: true, gw, wan, onlineCount: onlineDevs.length, unknownOnlineCount: unknownOnline.length, issues, testedAt: Date.now() };
}

"use strict";
const http = require("http");
const https = require("https");
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

    if ((req.url || "").startsWith("/api/net-diag")) {
      const devs = (typeof db !== "undefined" && db.prepare)
        ? db.prepare("SELECT * FROM devices").all()
        : (typeof getLatestDevices === "function" ? getLatestDevices() : []);
      runNetDiag(devs).then(data => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(data));
      }).catch(e => {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
      return;
    }
    if ((req.url || "").startsWith("/api/net-diag")) {
      const devs = (typeof db !== "undefined" && db.prepare)
        ? db.prepare("SELECT * FROM devices").all()
        : (typeof getLatestDevices === "function" ? getLatestDevices() : []);
      runNetDiag(devs).then(data => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(data));
      }).catch(e => {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
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

    if (req.method === "POST" && url.pathname === "/api/ai-audit") {
      const { provider, prompt } = await readJsonBody(req);
      if (!prompt) return sendJson(400, { error: "Prompt kosong" });
      const targetModel = provider === "sambanova" ? "auditor-sambanova" : (provider === "groq" ? "analis-groq" : "auditor-gemini");

      // Jalur 1: Local AI Router (Port 4000)
      try {
        const r = await fetch("http://127.0.0.1:4000/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: targetModel, temperature: 0.1, messages: [{ role: "user", content: prompt }] })
        });
        if (r.ok) {
          const jd = await r.json();
          const txt = jd?.choices?.[0]?.message?.content || "";
          const m = txt.match(/\{[\s\S]*\}/);
          if (m) return sendJson(200, { ok: true, result: JSON.parse(m[0]) });
        }
      } catch (_) {}

      // Jalur 2: Rotasi seluruh key & model dari scanner/aiConfig.json
      const cfgPath = path.join(__dirname, "..", "scanner", "aiConfig.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        
        if (provider === "sambanova" && cfg.cloudflareAccountId && cfg.cloudflareApiToken) {
          const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${cfg.cloudflareAccountId}/ai/v1/chat/completions`;
          const cfModels = cfg.cloudflareModels || ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
          for (const model of cfModels) {
            try {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 10000);
              const r = await fetch(cfUrl, {
                method: "POST",
                signal: ctrl.signal,
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": "Bearer " + cfg.cloudflareApiToken.trim()
                },
                body: JSON.stringify({
                  model,
                  messages: [{ role: "user", content: prompt }],
                  temperature: 0.1
                })
              });
              clearTimeout(t);
              if (r.ok) {
                const jd = await r.json();
                const rawTxt = jd?.choices?.[0]?.message?.content || "";
                const cleanTxt = rawTxt.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
                const m = cleanTxt.match(/\{[\s\S]*\}/);
                if (m) {
                  const parsed = JSON.parse(m[0]);
                  parsed.reason = parsed.reason || parsed.alasan || parsed.explanation || (parsed.valid ? "Struktur rasio Fibonacci & PRZ valid (Cloudflare Llama-70B)." : "Rasio gelombang atau zona PRZ belum memenuhi standar.");
                  return sendJson(200, { ok: true, result: parsed, via: "cloudflare-llama70b" });
                }
              }
            } catch (_) {}
          }
        }

        if (provider === "sambanova" && Array.isArray(cfg.groqKeys)) {
          const fallbackKeys = [...cfg.groqKeys.filter(Boolean)].reverse();
          const fbModels = ["llama-3.3-70b-versatile", "qwen/qwen3-32b", "openai/gpt-oss-120b"];
          for (const key of fallbackKeys) {
            for (const model of fbModels) {
              try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 8000);
                const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                  method: "POST",
                  signal: ctrl.signal,
                  headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key.trim() },
                  body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.1 })
                });
                clearTimeout(t);
                if (r.ok) {
                  const jd = await r.json();
                  const rawTxt = jd?.choices?.[0]?.message?.content || "";
                  const cleanTxt = rawTxt.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
                  const m = cleanTxt.match(/\{[\s\S]*\}/);
                  if (m) {
                    const parsed = JSON.parse(m[0]);
                    parsed.reason = parsed.reason || parsed.alasan || parsed.explanation || (parsed.valid ? "Struktur rasio Fibonacci & PRZ terkonfirmasi." : "Rasio gelombang atau zona PRZ belum memenuhi standar.");
                    return sendJson(200, { ok: true, result: parsed, via: "llama70b-fallback" });
                  }
                }
              } catch (_) {}
            }
          }
        }

        if (provider === "groq" && Array.isArray(cfg.groqKeys)) {
          const gModels = [...new Set([cfg.groqModel, "openai/gpt-oss-120b", "llama-3.1-8b-instant"].filter(Boolean))];
          for (const key of cfg.groqKeys.filter(Boolean)) {
            for (const model of gModels) {
              try {
                const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key.trim() },
                  body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: "user", content: prompt }] })
                });
                if (r.ok) {
                  const jd = await r.json();
                  const txt = jd?.choices?.[0]?.message?.content || "";
                  const m = txt.match(/\{[\s\S]*\}/);
                  if (m) return sendJson(200, { ok: true, result: JSON.parse(m[0]) });
                }
              } catch (_) {}
            }
          }
        }
        if (provider === "gemini" && Array.isArray(cfg.geminiKeys)) {
          const mModels = [...new Set([cfg.geminiModel, "gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"].filter(Boolean))];
          for (const rawKey of cfg.geminiKeys.filter(Boolean)) {
            const key = rawKey.trim();
            const isStd = key.startsWith("AIza");
            for (const model of mModels) {
              try {
                const u = isStd
                  ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`
                  : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
                const hdrs = { "Content-Type": "application/json" };
                if (!isStd) hdrs["x-goog-api-key"] = key;
                const r = await fetch(u, {
                  method: "POST",
                  headers: hdrs,
                  body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } })
                });
                if (r.ok) {
                  const jd = await r.json();
                  const txt = jd?.candidates?.[0]?.content?.parts?.[0]?.text || "";
                  const m = txt.match(/\{[\s\S]*\}/);
                  if (m) return sendJson(200, { ok: true, result: JSON.parse(m[0]) });
                }
              } catch (_) {}
            }
          }
        }
      }
      return sendJson(502, { ok: false, error: "Semua key & model AI gagal merespons" });
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


try {
  const httpsServer = https.createServer({
    key: fs.readFileSync(path.join(__dirname, "local-key.pem")),
    cert: fs.readFileSync(path.join(__dirname, "local-cert.pem"))
  }, server.listeners("request")[0]);
  httpsServer.listen(8766, "0.0.0.0", () => {
    console.log("[SWC] HTTPS Bridge aktif di https://127.0.0.1:8766");
  });
} catch (err) {
  console.error("[SWC] Error HTTPS Bridge:", err.message);
}


// HEARTBEAT_KEEP_ALIVE: Ping router setiap 45 detik agar sesi tidak expire
setInterval(async () => {
  try {
    if (typeof zteDriver !== "undefined" && zteDriver) {
      await zteDriver.getConnectedDevices();
    }
  } catch (e) {
    // Silent catch, auto-relogin akan menangani jika cookie expired
  }
}, 45000);


// Worker Antrean Order Harmonic dari Browser via Firebase (Anti-Blokir SSL/PNA Chrome Android)
const FB_HARMONIC_QUEUE = "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app/emaSignals/_harmonicOrderQueue.json";
const FB_HARMONIC_RESULT = "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app/emaSignals/_harmonicOrderResult.json";
let __lastProcessedQueueId = "";
setInterval(async () => {
  try {
    const r = await fetch(FB_HARMONIC_QUEUE + "?t=" + Date.now());
    if (!r.ok) return;
    const job = await r.json();
    if (!job || !job.id || job.id === __lastProcessedQueueId || job.status !== "PENDING") return;
    __lastProcessedQueueId = job.id;
    console.log("[SWC-HARMONIC] Menerima antrean order dari browser:", job.symbol, job.sig?.patternName, job.sig?.side);
    const { loadHarmonicSettings, loadPaperState, executeHarmonicOrder, savePaperState } = require("../scanner/harmonicRunner");
    const cfg = await loadHarmonicSettings();
    const paper = loadPaperState();
    const resExec = await executeHarmonicOrder(job.symbol, job.sig, cfg, paper);
    savePaperState(paper);
    console.log("[SWC-HARMONIC] Hasil eksekusi:", resExec);
    const donePayload = { ...job, status: resExec.executed ? "EXECUTED" : "REJECTED", result: resExec, processedAt: Date.now() };
    await fetch(FB_HARMONIC_QUEUE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(donePayload) }).catch(() => {});
    await fetch(FB_HARMONIC_RESULT, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(donePayload) }).catch(() => {});
  } catch (e) {
    console.error("[SWC-HARMONIC] Error worker:", e.message);
  }
}, 2500);
