"use strict";
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, ".liveUiState.json");

const A = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  fgWhite: "\x1b[38;5;255m",
  fgSilver: "\x1b[38;5;250m",
  fgMuted: "\x1b[38;5;242m",
  fgBorder: "\x1b[38;5;238m",
  fgCyan: "\x1b[38;5;81m",
  fgMint: "\x1b[38;5;114m",
  fgAmber: "\x1b[38;5;221m",
  fgCoral: "\x1b[38;5;203m",
  bgHeader: "\x1b[48;5;234m",
  bgPanel: "\x1b[48;5;233m"
};

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (_) {}
  return {
    phase: "SCANNING",
    scanCoin: "BTCUSDT",
    candidate: "-",
    signal: "-",
    groqStatus: "WAIT",
    geminiStatus: "WAIT",
    tradeResult: "IDLE",
    tradeReason: "Menunggu konvergensi sinyal EMA MTF & volume",
    updatedAt: Date.now()
  };
}

const STREAM_FRAMES = [
  "──────",
  "▸─────",
  "─▸────",
  "──▸───",
  "───▸──",
  "────▸─",
  "─────▸"
];
const PULSE = ["●", "○"];
const WATCHLIST = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT", "ADAUSDT", "DOGEUSDT"];
let tick = 0;

function visLen(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padRight(str, width) {
  const diff = width - visLen(str);
  return str + (diff > 0 ? " ".repeat(diff) : "");
}

function formatBadge(status, isAuditing) {
  if (status === "PASS") return `${A.fgMint}${A.bold}[ PASS ]${A.reset}`;
  if (status === "FAIL") return `${A.fgCoral}${A.bold}[ FAIL ]${A.reset}`;
  if (isAuditing) {
    const dot = PULSE[tick % 2];
    return `${A.fgAmber}[ ${dot} .. ]${A.reset}`;
  }
  return `${A.fgMuted}[ IDLE ]${A.reset}`;
}

function render() {
  const st = readState();
  const ageSec = Math.floor((Date.now() - (st.updatedAt || Date.now())) / 1000);
  const phase = ageSec > 90 ? "SCANNING" : st.phase;
  const activeCoin = WATCHLIST[tick % WATCHLIST.length];
  const isAuditing = phase === "AUDITING";
  const isResult = phase === "RESULT";

  // Header
  const nowStr = new Date().toTimeString().slice(0, 8);
  const sysIndicator = `${A.fgMint}●${A.reset} ${A.fgSilver}ENGINE ONLINE${A.reset}`;

  // Panel Kiri: Scanner / Candidate
  let leftHeader = `${A.fgCyan}${A.bold}01 · MARKET SCANNER${A.reset}`;
  let leftRow1 = `${A.fgMuted}PAIR   ${A.reset}${A.fgWhite}${activeCoin}${A.reset}`;
  let leftRow2 = `${A.fgMuted}STATE  ${A.reset}${A.fgAmber}SCANNING TOP 500${A.reset}`;

  if (isAuditing || isResult) {
    const dirColor = String(st.signal).toUpperCase() === "SELL" ? A.fgCoral : A.fgMint;
    leftHeader = `${A.fgMint}${A.bold}01 · CANDIDATE LOCKED${A.reset}`;
    leftRow1 = `${A.fgMuted}PAIR   ${A.reset}${A.fgWhite}${A.bold}${st.candidate}${A.reset} ${dirColor}${st.signal}${A.reset}`;
    leftRow2 = `${A.fgMuted}STATE  ${A.reset}${A.fgCyan}DISPATCHED TO AI${A.reset}`;
  }

  // Jalur Aliran Tengah (Data Bus)
  let busTop = "        ";
  let busMid = `${A.fgBorder} ────── ${A.reset}`;
  let busBot = "        ";

  if (isAuditing) {
    const flow = STREAM_FRAMES[tick % STREAM_FRAMES.length];
    busTop = `${A.fgAmber}${A.bold}  SYNC  ${A.reset}`;
    busMid = `${A.fgCyan}${A.bold} ${flow} ${A.reset}`;
    busBot = `${A.fgMuted}  LINK  ${A.reset}`;
  } else if (isResult) {
    const doneColor = st.tradeResult === "SUCCESS" ? A.fgMint : A.fgCoral;
    busTop = `${A.fgMuted}  DONE  ${A.reset}`;
    busMid = `${doneColor}${A.bold} ━━━━━▸ ${A.reset}`;
  }

  // Panel Kanan: Dual-AI Consensus
  const rightHeader = `${A.fgCyan}${A.bold}02 · DUAL-AI CONSENSUS${A.reset}`;
  const gStat = phase === "SCANNING" ? "IDLE" : st.groqStatus;
  const mStat = phase === "SCANNING" ? "IDLE" : st.geminiStatus;
  const rightRow1 = `${A.fgSilver}GROQ   ${A.reset}  ${formatBadge(gStat, isAuditing)}`;
  const rightRow2 = `${A.fgSilver}GEMINI ${A.reset}  ${formatBadge(mStat, isAuditing)}`;

  // Panel Bawah: Execution Verdict
  let execBorder = A.fgBorder;
  let execTitle = `${A.fgMuted}03 · EXECUTION VERDICT${A.reset}`;
  let execStatus = `${A.fgMuted}STANDBY · MENUNGGU KANDIDAT TERVERIFIKASI${A.reset}`;
  let execDetail = `${A.fgMuted}${String(st.tradeReason || "-").slice(0, 56)}${A.reset}`;

  if (isAuditing) {
    execBorder = A.fgCyan;
    execTitle = `${A.fgCyan}${A.bold}03 · EXECUTION VERDICT${A.reset}`;
    execStatus = `${A.fgAmber}EVALUATING · MENUNGGU KEPUTUSAN GROQ & GEMINI${A.reset}`;
  } else if (isResult) {
    if (st.tradeResult === "SUCCESS") {
      execBorder = A.fgMint;
      execTitle = `${A.fgMint}${A.bold}03 · EXECUTION VERDICT${A.reset}`;
      execStatus = `${A.fgMint}${A.bold}TRADE EXECUTED · ORDER TERKIRIM KE BINANCE${A.reset}`;
      execDetail = `${A.fgSilver}${String(st.tradeReason || "").slice(0, 56)}${A.reset}`;
    } else {
      execBorder = A.fgCoral;
      execTitle = `${A.fgCoral}${A.bold}03 · EXECUTION VERDICT${A.reset}`;
      execStatus = `${A.fgCoral}${A.bold}TRADE FAILED · EKSEKUSI DIBATALKAN${A.reset}`;
      execDetail = `${A.fgSilver}${String(st.tradeReason || "").slice(0, 56)}${A.reset}`;
    }
  }

  const B = A.fgBorder;
  const screen = [
    "\x1b[2J\x1b[H",
    `${A.bgHeader}${padRight(`  ${A.fgWhite}${A.bold}OCTA-ANALYZER${A.reset}${A.bgHeader}  ${A.fgMuted}|${A.reset}${A.bgHeader}  ${sysIndicator}${A.bgHeader}  ${A.fgMuted}|  ${nowStr} WIB${A.reset}${A.bgHeader}`, 62)}${A.reset}`,
    "",
    `  ${B}╭────────────────────────╮${A.reset}          ${B}╭────────────────────────╮${A.reset}`,
    `  ${B}│${A.reset} ${padRight(leftHeader, 22)} ${B}│${A.reset} ${busTop} ${B}│${A.reset} ${padRight(rightHeader, 22)} ${B}│${A.reset}`,
    `  ${B}├────────────────────────┤${A.reset} ${busMid} ${B}├────────────────────────┤${A.reset}`,
    `  ${B}│${A.reset} ${padRight(leftRow1, 22)} ${B}│${A.reset} ${busBot} ${B}│${A.reset} ${padRight(rightRow1, 22)} ${B}│${A.reset}`,
    `  ${B}│${A.reset} ${padRight(leftRow2, 22)} ${B}│${A.reset}          ${B}│${A.reset} ${padRight(rightRow2, 22)} ${B}│${A.reset}`,
    `  ${B}╰────────────────────────╯${A.reset}          ${B}╰────────────────────────╯${A.reset}`,
    "",
    `  ${execBorder}╭──────────────────────────────────────────────────────────╮${A.reset}`,
    `  ${execBorder}│${A.reset} ${padRight(execTitle, 56)} ${execBorder}│${A.reset}`,
    `  ${execBorder}│${A.reset} ${padRight(execStatus, 56)} ${execBorder}│${A.reset}`,
    `  ${execBorder}│${A.reset} ${padRight(execDetail, 56)} ${execBorder}│${A.reset}`,
    `  ${execBorder}╰──────────────────────────────────────────────────────────╯${A.reset}`,
    "",
    `  ${A.fgMuted}CTRL+C untuk keluar tampilan · Background daemon tetap aktif${A.reset}`
  ].join("\n");

  process.stdout.write(screen);
  tick++;
}

setInterval(render, 220);
render();
