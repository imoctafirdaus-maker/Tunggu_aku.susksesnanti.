"use strict";
const fs = require("fs");
const path = require("path");
const { checkNewsSafety } = require("./newsGuard");

const CFG_PATH = path.join(__dirname, "binanceConfig.json");

function setLocalAutoTrade(enabled) {
  try {
    if (!fs.existsSync(CFG_PATH)) return false;
    const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
    cfg.autoTrade = Boolean(enabled);
    fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

function getLocalAutoTrade() {
  try {
    if (!fs.existsSync(CFG_PATH)) return false;
    const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
    return Boolean(cfg.autoTrade);
  } catch (_) {
    return false;
  }
}

async function syncControlWithFirebase(db, admin, forceState = null) {
  const ref = db.ref("emaSignals/_botControl");
  if (forceState !== null) {
    const state = Boolean(forceState);
    setLocalAutoTrade(state);
    await ref.set({
      autoTrade: state,
      newsGuardActive: false,
      source: "termux",
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });
    return state;
  }

  const snap = await ref.once("value");
  const val = snap.val() || {};
  const newsStatus = await checkNewsSafety(null, 30).catch(() => ({ safe: true }));

  // Jika News Guard sedang aktif, otomatis matikan saklar sementara & simpan waktu buka (unlockAt)
  if (!newsStatus.safe && newsStatus.isMacroNews) {
    const prevAuto = typeof val.autoTrade === "boolean" ? val.autoTrade : getLocalAutoTrade();
    const resumeState = val.newsGuardActive ? (val.resumeAutoTrade !== false) : prevAuto;
    setLocalAutoTrade(false);
    await ref.set({
      autoTrade: false,
      newsGuardActive: true,
      newsTitle: newsStatus.newsTitle || "Berita Makro High-Impact",
      unlockAt: newsStatus.unlockAt || (Date.now() + 30 * 60000),
      resumeAutoTrade: resumeState,
      source: "news-guard",
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });
    return false;
  }

  // Jika baru selesai dari jeda News Guard, otomatis aktifkan kembali saklar seperti semula
  if (val.newsGuardActive) {
    const restore = val.resumeAutoTrade !== false;
    setLocalAutoTrade(restore);
    await ref.set({
      autoTrade: restore,
      newsGuardActive: false,
      source: "news-guard-resume",
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });
    return restore;
  }

  if (typeof val.autoTrade === "boolean") {
    setLocalAutoTrade(val.autoTrade);
    return val.autoTrade;
  }

  const localState = getLocalAutoTrade();
  await ref.set({
    autoTrade: localState,
    newsGuardActive: false,
    source: "init",
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  return localState;
}

module.exports = { setLocalAutoTrade, getLocalAutoTrade, syncControlWithFirebase };
