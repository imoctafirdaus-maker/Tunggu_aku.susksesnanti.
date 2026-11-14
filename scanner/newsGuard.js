"use strict";
const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, ".newsCache.json");
const NEWS_FEEDS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json"
];

// Kata kunci berita makro yang paling memicu badai volatilitas kripto
const CRITICAL_KEYWORDS = [
  "CPI", "FOMC", "Federal Funds Rate", "Non-Farm", "NFP",
  "GDP", "PCE", "Powell", "Unemployment Rate", "PPI"
];

async function fetchEconomicCalendar() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      // Gunakan cache jika umurnya kurang dari 3 jam
      if (cached && Date.now() - cached.fetchedAt < 3 * 3600 * 1000 && Array.isArray(cached.events)) {
        return cached.events;
      }
    }
  } catch (_) {}

  for (const url of NEWS_FEEDS) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data)) {
        const usdHigh = data
          .filter(e => e.country === "USD" && (e.impact === "High" || CRITICAL_KEYWORDS.some(k => (e.title || "").toUpperCase().includes(k.toUpperCase()))))
          .map(e => ({
            title: e.title,
            impact: e.impact,
            timestamp: new Date(e.date).getTime()
          }))
          .filter(e => Number.isFinite(e.timestamp));

        fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), events: usdHigh }, null, 2));
        return usdHigh;
      }
    } catch (_) {}
  }
  return [];
}

async function checkNewsSafety(rec, bufferMinutes = 30) {
  const now = Date.now();
  const bufferMs = bufferMinutes * 60 * 1000;

  // 1. Cek Kalender Ekonomi USD High-Impact
  const events = await fetchEconomicCalendar();
  const activeNews = events.find(e => Math.abs(e.timestamp - now) <= bufferMs);
  if (activeNews) {
    const diffMin = Math.round((activeNews.timestamp - now) / 60000);
    const timing = diffMin >= 0 ? `dalam ${diffMin} menit` : `${Math.abs(diffMin)} menit lalu`;
    return {
      safe: false,
      reason: `News Guard Aktif: "${activeNews.title}" (${timing}) — entry ditahan ±${bufferMinutes}m`
    };
  }

  // 2. Cek Sensor Volatilitas / Jarak SL Ekstrem (Deteksi Breaking News mendadak)
  if (rec && rec.entryPrice > 0 && rec.stopLoss > 0) {
    const slPct = (Math.abs(rec.entryPrice - rec.stopLoss) / rec.entryPrice) * 100;
    if (slPct > 1.65) {
      return {
        safe: false,
        reason: `Volatilitas Ekstrem (jarak SL ${slPct.toFixed(2)}% > 1.65%, rawan likuidasi 50x)`
      };
    }
  }

  return { safe: true };
}

if (require.main === module && process.argv.includes("--test")) {
  (async () => {
    const events = await fetchEconomicCalendar();
    const status = await checkNewsSafety(null, 30);
    console.log(`✅ Kalender Ekonomi USD High-Impact dimuat: ${events.length} jadwal minggu ini.`);
    const upcoming = events.filter(e => e.timestamp >= Date.now() - 3600000).slice(0, 5);
    if (upcoming.length) {
      console.log("📅 Jadwal Berita Besar Terdekat:");
      upcoming.forEach(e => {
        const wib = new Date(e.timestamp).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        console.log(`   • ${wib} WIB — ${e.title} [${e.impact}]`);
      });
    } else {
      console.log("📅 Tidak ada jadwal berita USD High-Impact tersisa minggu ini.");
    }
    console.log(`🛡️ Status Trading Saat Ini: ${status.safe ? "AMAN UNTUK ENTRY" : status.reason}`);
  })();
}

module.exports = { fetchEconomicCalendar, checkNewsSafety };
