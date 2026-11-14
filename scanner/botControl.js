"use strict";
const fs = require("fs");
const path = require("path");

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
      source: "termux",
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });
    return state;
  }

  const snap = await ref.once("value");
  const val = snap.val();
  if (val && typeof val.autoTrade === "boolean") {
    setLocalAutoTrade(val.autoTrade);
    return val.autoTrade;
  }

  const localState = getLocalAutoTrade();
  await ref.set({
    autoTrade: localState,
    source: "init",
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  return localState;
}

module.exports = { setLocalAutoTrade, getLocalAutoTrade, syncControlWithFirebase };
