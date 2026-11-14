"use strict";
const fs = require("fs");
const path = require("path");

const TG_CFG_PATH = path.join(__dirname, "telegramConfig.json");
const TG_CACHE_PATH = path.join(__dirname, ".tgSentCache.json");

function loadTelegramConfig() {
  try {
    if (!fs.existsSync(TG_CFG_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(TG_CFG_PATH, "utf8"));
    if (raw && raw.token && raw.chatId) {
      return { token: String(raw.token).trim(), chatId: String(raw.chatId).trim() };
    }
  } catch (_) {}
  return null;
}

function loadSentCache() {
  try {
    if (fs.existsSync(TG_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(TG_CACHE_PATH, "utf8"));
    }
  } catch (_) {}
  return {};
}

function saveSentCache(cache) {
  try {
    // Simpan maks 300 riwayat terakhir agar file tetap ringan
    const keys = Object.keys(cache);
    if (keys.length > 300) {
      keys.slice(0, keys.length - 300).forEach(k => delete cache[k]);
    }
    fs.writeFileSync(TG_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (_) {}
}

async function sendTelegramAlert(text) {
  const cfg = loadTelegramConfig();
  if (!cfg) return { ok: false, error: "telegramConfig.json tidak lengkap" };

  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 12000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true
      }),
      signal: c.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.description || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

async function notifyNewSignalsToTelegram(upEma, upOld = {}) {
  const cfg = loadTelegramConfig();
  if (!cfg) return 0;

  const cache = loadSentCache();
  const alerts = [];

  // 1. Prioritas Utama: Semua sinyal baru dari EMA Expert (sudah lolos MTF + Monte Carlo + Dual-AI)
  for (const [id, rec] of Object.entries(upEma || {})) {
    if (!rec || !rec.symbol || !rec.signal) continue;
    const dedupKey = `EMA_${rec.symbol}_${rec.timeframe || "5m"}_${rec.signal}_${rec.candleTime || ""}`;
    if (cache[dedupKey]) continue;
    cache[dedupKey] = Date.now();

    const dirIcon = rec.signal === "BUY" ? "🟢 LONG (BUY)" : "🔴 SHORT (SELL)";
    const aiNote = rec.aiSummary ? `\n🧠 *Dual-AI:* ${rec.aiSummary}` : "";
    const tradeNote = rec.autoExecuted ? `\n⚡ *Eksekusi 50x:* ORDER TERKIRIM` : "";
    alerts.push(
      `🚀 *SINYAL EMA EXPERT VALID*\n` +
      `• *Koin:* \`${rec.symbol}\` (${rec.timeframe || "5m"})\n` +
      `• *Arah:* ${dirIcon}\n` +
      `• *Entry:* \`$${rec.entryPrice || rec.price}\`\n` +
      `• *Stop Loss:* \`$${rec.stopLoss || "-"}\`\n` +
      `• *Take Profit:* \`$${rec.takeProfit || "-"}\`` +
      aiNote + tradeNote
    );
  }

  // 2. Sinyal Kuat Algoritma Lama (Skor >= 78/100) sebagai radar peluang tambahan
  for (const [id, rec] of Object.entries(upOld || {})) {
    if (!rec || !rec.symbol || !rec.signal || Number(rec.score || 0) < 78) continue;
    const dedupKey = `OLD_${rec.symbol}_${rec.timeframe || "5m"}_${rec.signal}_${rec.candleTime || ""}`;
    if (cache[dedupKey]) continue;
    cache[dedupKey] = Date.now();

    const dirIcon = rec.signal === "BUY" ? "🟢 BUY" : "🔴 SELL/SHORT";
    alerts.push(
      `📡 *RADAR SKOR TINGGI (${rec.score}/100)*\n` +
      `• *Koin:* \`${rec.symbol}\` (${rec.timeframe || "5m"})\n` +
      `• *Arah:* ${dirIcon} | *Harga:* \`$${rec.price || rec.entryPrice}\`\n` +
      `• *Target TP1:* \`$${rec.tp1 || rec.takeProfit || "-"}\` | *SL:* \`$${rec.stopLoss || "-"}\``
    );
  }

  let sentCount = 0;
  for (const msg of alerts.slice(0, 5)) {
    const r = await sendTelegramAlert(msg);
    if (r.ok) sentCount++;
  }

  if (alerts.length > 0) saveSentCache(cache);
  return sentCount;
}

if (require.main === module && process.argv.includes("--test")) {
  (async () => {
    const res = await sendTelegramAlert(
      "🤖 *TERMUX BOT TERHUBUNG KE TELEGRAM*\n\n" +
      "✅ Pengiriman otomatis 24/7 aktif langsung dari Termux (tanpa perlu membuka browser PWA).\n" +
      "📡 Anda akan menerima notifikasi setiap ada sinyal *EMA Expert* atau *Radar Skor ≥ 78* baru."
    );
    console.log("Hasil Tes Telegram Termux:", res);
    process.exit(res.ok ? 0 : 1);
  })();
}

module.exports = { sendTelegramAlert, notifyNewSignalsToTelegram };
