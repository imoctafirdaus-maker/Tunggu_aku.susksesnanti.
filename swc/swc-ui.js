"use strict";
(function () {
  const CANDIDATE_BASES = [
    window.location.protocol === "http:" ? "" : "https://127.0.0.1:8766",
    "http://127.0.0.1:8765",
    "http://127.0.0.1:8765",
    "http://localhost:8765"
  ];
  let API_BASE = window.location.protocol === "http:" ? "" : "http://127.0.0.1:8765";
  let currentTab = localStorage.getItem("swc_active_tab") || "crypto";
  let filterMode = "all";
  let searchQuery = "";
  let isMutating = false;
  let swcData = {
    state: { routerOnline: false, lastScanAt: null, lastError: "MENGHUBUNGKAN KE NODE LOKAL..." },
    devices: [],
    logs: [],
    schedules: []
  };

  // Ikon vektor SVG teknis murni (stroke 1.75px, presisi grid 24x24, nol emoji)
  const SVG = {
    telemetry: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"><path d="M2 12h4l3-7 4 14 3-7h6"/></svg>',
    gateway: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"><rect x="2" y="13" width="20" height="7" rx="1"/><path d="M6 13V9M18 13V9M14 6.5a5.5 5.5 0 0 1 7 0M16 8.8a2.5 2.5 0 0 1 3 0"/><rect x="5" y="16" width="2" height="1.5" fill="currentColor" stroke="none"/><rect x="9" y="16" width="2" height="1.5" fill="currentColor" stroke="none"/></svg>',
    sync: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="square"><path d="M21 12a9 9 0 0 0-15.36-6.36L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.36 6.36L21 16"/><path d="M16 16h5v5"/></svg>',
    search: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.35-4.35"/></svg>',
    ban: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="square"><circle cx="12" cy="12" r="9"/><path d="M5.7 5.7 18.3 18.3"/></svg>',
    allow: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="square"><path d="M12 21s7-3.5 7-9V5l-7-2.5L5 5v7c0 5.5 7 9 7 9z"/><path d="m9 12 2 2 4-4"/></svg>',
    edit: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"><path d="M4 20h16"/><path d="M14.5 4.5 19.5 9.5 9 20H4v-5L14.5 4.5z"/></svg>',
    verify: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="m8 12 2.5 2.5L16 9"/></svg>',
    flag: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"><path d="M12 8v5"/><path d="M12 16.5h.01"/><path d="M10.3 3.8 2.4 18a1.8 1.8 0 0 0 1.6 2.7h16a1.8 1.8 0 0 0 1.6-2.7L13.7 3.8a1.9 1.9 0 0 0-3.4 0z"/></svg>',
    clock: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
    plus: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M12 5v14M5 12h14"/></svg>',
    trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
    log: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 9h10M7 13h7M7 17h4"/></svg>',
    ext: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"><path d="M14 4h6v6M20 4 10 14M18 13v6H5V6h6"/></svg>',
    spin: '<svg class="isp-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>'
  };

  const style = document.createElement("style");
  style.textContent = `
    :root {
      --isp-bg: #07090d;
      --isp-panel: #0c1017;
      --isp-card: #111620;
      --isp-hover: #171e2b;
      --isp-line: #1c2432;
      --isp-line-strong: #2a3548;
      --isp-text: #eef2f6;
      --isp-sub: #8b9bb4;
      --isp-dim: #5c6b82;
      --isp-blue: #2563eb;
      --isp-sky: #38bdf8;
      --isp-ok: #10b981;
      --isp-err: #ef4444;
      --isp-warn: #f59e0b;
      --isp-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      --isp-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body { padding-top: 48px !important; background: var(--isp-bg); }
    #swc-top-switcher {
      position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 48px !important;
      z-index: 999999 !important; background: #07090d !important;
      border-bottom: 1px solid var(--isp-line) !important;
      display: flex !important; align-items: center !important; justify-content: space-between !important;
      padding: 0 12px !important; font-family: var(--isp-sans) !important; box-sizing: border-box;
    }
    .isp-nav {
      display: flex; gap: 2px; background: var(--isp-panel);
      padding: 3px; border-radius: 4px; border: 1px solid var(--isp-line);
    }
    .swc-tab-btn {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid transparent; background: transparent; color: var(--isp-sub);
      font-size: 11.5px; font-weight: 600; padding: 5px 10px; border-radius: 3px;
      cursor: pointer; transition: background 0.12s ease, color 0.12s ease;
    }
    .swc-tab-btn.active {
      background: var(--isp-hover); color: #ffffff; border-color: var(--isp-line-strong);
    }
    .swc-tab-btn.active svg { color: var(--isp-sky); }
    .isp-led {
      width: 6px; height: 6px; border-radius: 50%; background: var(--isp-err); flex-shrink: 0;
    }
    .isp-led.on { background: var(--isp-ok); }
    .isp-proto {
      font-family: var(--isp-mono); font-size: 10px; color: var(--isp-dim);
      letter-spacing: 0.05em; text-transform: uppercase;
    }
    #swc-panel {
      display: none; min-height: calc(100vh - 48px);
      background: var(--isp-bg); color: var(--isp-text);
      font-family: var(--isp-sans); padding: 12px; box-sizing: border-box;
    }
    .isp-shell { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }

    /* Banner peringatan jika dibuka via HTTPS dan Chrome memblokir HTTP lokal */
    .isp-https-alert {
      background: #14110b; border: 1px solid rgba(245, 158, 11, 0.35);
      border-left: 3px solid var(--isp-warn); border-radius: 4px; padding: 10px 12px;
      display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
    }
    .isp-https-text { font-size: 11.5px; color: #fde68a; line-height: 1.4; }
    .isp-https-sub { font-family: var(--isp-mono); font-size: 10px; color: #d97706; margin-top: 2px; }

    /* Header Gateway CPE */
    .isp-box {
      background: var(--isp-panel); border: 1px solid var(--isp-line); border-radius: 4px; padding: 13px;
    }
    .isp-head-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .isp-kicker {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: var(--isp-mono); font-size: 10px; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase; color: var(--isp-sky);
    }
    .isp-title { margin: 4px 0 0; font-size: 15.5px; font-weight: 700; letter-spacing: -0.01em; color: #f8fafc; }
    .isp-link-pill {
      display: inline-flex; align-items: center; gap: 6px; margin-top: 7px;
      font-family: var(--isp-mono); font-size: 10.5px; color: var(--isp-sub);
      background: var(--isp-card); border: 1px solid var(--isp-line); padding: 3px 8px; border-radius: 3px;
    }
    .isp-link-pill.err { color: #fca5a5; border-color: rgba(239, 68, 68, 0.35); background: rgba(239, 68, 68, 0.08); }

    /* Telemetry Grid */
    .isp-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; }
    .isp-metric {
      background: var(--isp-card); border: 1px solid var(--isp-line);
      border-top: 2px solid var(--m-color, var(--isp-line-strong));
      border-radius: 4px; padding: 9px 10px;
    }
    .isp-m-lbl { font-family: var(--isp-mono); font-size: 9.5px; font-weight: 700; color: var(--isp-dim); letter-spacing: 0.06em; }
    .isp-m-val { font-family: var(--isp-mono); font-size: 20px; font-weight: 700; color: #f8fafc; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .isp-m-desc { font-size: 10.5px; color: var(--isp-sub); margin-top: 1px; }

    /* Filter & Search */
    .isp-controls { display: flex; flex-direction: column; gap: 8px; }
    .isp-search-box { position: relative; display: flex; align-items: center; }
    .isp-search-box svg { position: absolute; left: 10px; color: var(--isp-dim); pointer-events: none; }
    .isp-search-input {
      width: 100%; background: var(--isp-panel); border: 1px solid var(--isp-line);
      border-radius: 4px; padding: 8px 10px 8px 31px; color: var(--isp-text);
      font-family: var(--isp-sans); font-size: 12.5px; outline: none; box-sizing: border-box;
    }
    .isp-search-input:focus { border-color: var(--isp-blue); }
    .isp-tabs-filter {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px;
      background: var(--isp-panel); border: 1px solid var(--isp-line); padding: 3px; border-radius: 4px;
    }
    .swc-chip {
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      background: transparent; border: 1px solid transparent; color: var(--isp-sub);
      font-size: 11px; font-weight: 600; padding: 5px 4px; border-radius: 3px; cursor: pointer;
    }
    .swc-chip.active { background: var(--isp-hover); color: #ffffff; border-color: var(--isp-line-strong); }
    .isp-num { font-family: var(--isp-mono); font-size: 10px; color: var(--isp-dim); }
    .swc-chip.active .isp-num { color: var(--isp-sky); }

    /* Buttons */
    .swc-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      background: var(--isp-card); border: 1px solid var(--isp-line-strong);
      color: var(--isp-text); font-family: var(--isp-sans); font-size: 11.5px; font-weight: 600;
      padding: 6px 10px; border-radius: 4px; cursor: pointer; text-decoration: none; white-space: nowrap;
    }
    .swc-btn:hover:not(:disabled) { background: var(--isp-hover); }
    .swc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .swc-btn-primary { background: #1d4ed8; border-color: #2563eb; color: #ffffff; }
    .swc-btn-danger { background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.35); color: #fca5a5; }
    .swc-btn-success { background: rgba(16, 185, 129, 0.12); border-color: rgba(16, 185, 129, 0.35); color: #6ee7b7; }
    .swc-btn-warn { background: rgba(245, 158, 11, 0.14); border-color: rgba(245, 158, 11, 0.4); color: #fde68a; }

    /* Client Rows */
    .isp-dev-list { display: flex; flex-direction: column; gap: 7px; }
    .isp-dev {
      background: var(--isp-panel); border: 1px solid var(--isp-line);
      border-left: 3px solid #2c384b; border-radius: 4px; padding: 10px 12px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .isp-dev.online { border-left-color: var(--isp-ok); }
    .isp-dev.blocked { background: #130c0f; border-color: rgba(239, 68, 68, 0.28); border-left-color: var(--isp-err); }
    .isp-dev-main { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .isp-dev-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .isp-dev-name { font-size: 13.5px; font-weight: 700; color: #f8fafc; max-width: 185px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .isp-tag {
      font-family: var(--isp-mono); font-size: 9px; font-weight: 700; letter-spacing: 0.05em;
      padding: 2px 5px; border-radius: 2px; text-transform: uppercase;
    }
    .t-on { background: rgba(16, 185, 129, 0.12); color: #34d399; }
    .t-off { background: rgba(100, 116, 139, 0.14); color: #94a3b8; }
    .t-blk { background: rgba(239, 68, 68, 0.16); color: #f87171; }
    .t-ver { background: rgba(56, 189, 248, 0.1); color: #7dd3fc; }
    .t-unv { background: rgba(245, 158, 11, 0.12); color: #fbbf24; }
    .isp-dev-spec {
      font-family: var(--isp-mono); font-size: 11px; color: var(--isp-sub);
      margin-top: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    }
    .isp-dev-foot {
      display: flex; align-items: center; gap: 6px; padding-top: 7px;
      border-top: 1px solid rgba(28, 36, 50, 0.85);
    }
    .isp-dev-foot .swc-btn { padding: 4px 8px; font-size: 11px; color: var(--isp-sub); }

    /* Section Header */
    .isp-sec-hdr {
      display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.04em; color: #cbd5e1;
      padding-bottom: 8px; margin-bottom: 9px; border-bottom: 1px solid var(--isp-line);
    }
    .isp-sec-hdr svg { color: var(--isp-sky); }
    .isp-form-grid { display: grid; grid-template-columns: 1fr auto auto auto; gap: 6px; }
    @media (max-width: 540px) {
      .isp-form-grid { grid-template-columns: 1fr 1fr; }
      .isp-form-grid select, .isp-form-grid button { grid-column: span 2; }
    }
    .isp-input {
      background: var(--isp-card); border: 1px solid var(--isp-line); color: var(--isp-text);
      border-radius: 4px; padding: 6px 8px; font-family: var(--isp-mono); font-size: 11.5px; outline: none;
    }
    .isp-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      background: var(--isp-card); border: 1px solid var(--isp-line);
      padding: 6px 9px; border-radius: 3px; font-size: 11.5px; margin-top: 6px;
    }
    .isp-log {
      font-family: var(--isp-mono); font-size: 10.5px; color: var(--isp-sub);
      padding: 5px 4px; border-bottom: 1px solid rgba(28, 36, 50, 0.6);
      display: flex; gap: 7px; align-items: baseline;
    }
    .isp-empty {
      text-align: center; padding: 14px; font-family: var(--isp-mono); font-size: 11px;
      color: var(--isp-dim); border: 1px dashed var(--isp-line); border-radius: 4px;
    }
    @keyframes ispSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .isp-spin { animation: ispSpin 0.8s linear infinite; }
  `;
  document.head.appendChild(style);

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtTime(ts) {
    if (!ts) return "--:--:--";
    try { return new Date(ts).toLocaleTimeString("id-ID", { hour12: false }); } catch { return "--:--:--"; }
  }

  function initSwcUI() {
    if (document.getElementById("swc-top-switcher")) return;

    const switcher = document.createElement("div");
    switcher.id = "swc-top-switcher";
    switcher.innerHTML = `
      <div class="isp-nav">
        <button class="swc-tab-btn" data-tab="crypto">${SVG.telemetry}<span>Radar Sinyal</span></button>
        <button class="swc-tab-btn" data-tab="wifi"><span class="isp-led" id="swc-router-dot"></span>${SVG.gateway}<span>Gateway Wi-Fi</span></button>
      </div>
      <span class="isp-proto">${window.location.protocol === "https:" ? "HTTPS/PWA" : "LOCAL/NOC"}</span>
    `;
    document.body.prepend(switcher);

    const cryptoHost = document.createElement("div");
    cryptoHost.id = "swc-crypto-host";
    Array.from(document.body.childNodes).forEach(node => {
      if (node !== switcher && node !== cryptoHost && node.id !== "swc-panel" && node.tagName !== "SCRIPT" && node.tagName !== "STYLE") {
        cryptoHost.appendChild(node);
      }
    });
    document.body.appendChild(cryptoHost);

    const swcPanel = document.createElement("div");
    swcPanel.id = "swc-panel";
    document.body.appendChild(swcPanel);

    switcher.querySelectorAll(".swc-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // Gesture geser horizontal
    let touchStartX = 0, touchStartY = 0;
    document.addEventListener("touchstart", e => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });
    document.addEventListener("touchend", e => {
      if (!touchStartX) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartX = 0;
      if (Math.abs(dx) > 75 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        if (dx < 0 && currentTab === "crypto") switchTab("wifi");
        if (dx > 0 && currentTab === "wifi") switchTab("crypto");
      }
    }, { passive: true });

    switchTab(currentTab);
  }

  function switchTab(tab) {
    currentTab = tab === "wifi" ? "wifi" : "crypto";
    localStorage.setItem("swc_active_tab", currentTab);
    document.querySelectorAll(".swc-tab-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === currentTab);
    });
    const cryptoHost = document.getElementById("swc-crypto-host");
    const swcPanel = document.getElementById("swc-panel");
    if (cryptoHost) cryptoHost.style.display = currentTab === "crypto" ? "" : "none";
    if (swcPanel) {
      swcPanel.style.display = currentTab === "wifi" ? "block" : "none";
      if (currentTab === "wifi") renderSwc();
    }
  }

  async function fetchWithFallback(path, options = {}) {
    let lastErr;
    const bases = [API_BASE, ...CANDIDATE_BASES.filter(b => b !== API_BASE)];
    for (const base of bases) {
      try {
        const res = await fetch(base + path, {
          ...options,
          targetAddressSpace: "private"
        });
        API_BASE = base;
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Tidak dapat menjangkau server lokal 127.0.0.1:8765");
  }

  async function apiPost(path, payload = {}) {
    isMutating = true;
    try {
      const r = await fetchWithFallback(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      if (!r.ok || j.ok === false) throw new Error(j.error || "Permintaan ditolak server");
      swcData = {
        state: j.state || swcData.state,
        devices: j.devices || swcData.devices,
        logs: j.logs || swcData.logs,
        schedules: j.schedules || swcData.schedules
      };
      renderSwc();
      return j;
    } finally {
      isMutating = false;
    }
  }

  async function pollStateOnce() {
    if (isMutating) return;
    try {
      const r = await fetchWithFallback("/api/state");
      const j = await r.json();
      if (j && j.state) {
        swcData = {
          state: j.state,
          devices: j.devices || [],
          logs: j.logs || [],
          schedules: j.schedules || []
        };
        renderSwc();
      }
    } catch (err) {
      swcData.state = {
        ...swcData.state,
        routerOnline: false,
        lastError: window.location.protocol === "https:"
          ? "HTTPS_BLOCKED: Chrome memblokir akses ke http://127.0.0.1:8765"
          : (err.message || "BACKEND LOKAL OFFLINE")
      };
      renderSwc();
    }
  }

  function renderSwc() {
    const dot = document.getElementById("swc-router-dot");
    if (dot) dot.classList.toggle("on", !!swcData.state?.routerOnline);
    if (currentTab !== "wifi") return;

    const swcPanel = document.getElementById("swc-panel");
    if (!swcPanel) return;

    const hadFocus = document.activeElement && document.activeElement.id === "swc-search";
    const sStart = hadFocus ? document.activeElement.selectionStart : null;
    const sEnd = hadFocus ? document.activeElement.selectionEnd : null;

    const devs = swcData.devices || [];
    const logs = swcData.logs || [];
    const schedules = swcData.schedules || [];
    const onlineCount = devs.filter(d => d.status === "online").length;
    const blockedCount = devs.filter(d => d.block_mode === "blocked").length;
    const unknownCount = devs.filter(d => !d.is_known).length;

    const filtered = devs.filter(d => {
      if (filterMode === "online" && d.status !== "online") return false;
      if (filterMode === "blocked" && d.block_mode !== "blocked") return false;
      if (filterMode === "unknown" && d.is_known) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const hay = `${d.alias} ${d.hostname} ${d.ip} ${d.mac}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const isOnline = !!swcData.state?.routerOnline;
    const errMsg = swcData.state?.lastError || "";
    const isHttpsBlocked = window.location.protocol === "https:" && !isOnline;
    const statusText = isOnline
      ? `CPE ONLINE • SYNC ${fmtTime(swcData.state.lastScanAt)}`
      : esc(errMsg || "MENGHUBUNGKAN...");

    const devMap = new Map(devs.map(d => [d.mac, d.alias || d.hostname || d.mac]));

    swcPanel.innerHTML = `
      <div class="isp-shell">
        ${isHttpsBlocked ? `
          <div class="isp-https-alert">
            <div>
              <div class="isp-https-text"><strong>Koneksi Lokal Diblokir Kebijakan HTTPS Browser</strong></div>
              <div class="isp-https-sub">Buka langsung gateway HTTP lokal agar kontrol router berjalan tanpa blokir Mixed Content.</div>
            </div>
            <a class="swc-btn swc-btn-warn" href="http://127.0.0.1:8765/wifi">${SVG.ext}<span>Buka Mode Lokal</span></a>
          </div>
        ` : ""}

        <div class="isp-box">
          <div class="isp-head-row">
            <div>
              <div class="isp-kicker">${SVG.gateway} GPON ONT GATEWAY • 192.168.1.1</div>
              <h2 class="isp-title">ZTE F672Y Subscriber Access</h2>
              <div class="isp-link-pill ${isOnline ? "" : "err"}">
                <span class="isp-led ${isOnline ? "on" : ""}"></span>
                <span>${statusText}</span>
              </div>
            </div>
            <button class="swc-btn swc-btn-primary" id="swc-btn-scan">${SVG.sync}<span>Pindai</span></button>
          </div>
          <div class="isp-metrics">
            <div class="isp-metric" style="--m-color:#10b981">
              <div class="isp-m-lbl">ACTIVE</div>
              <div class="isp-m-val">${String(onlineCount).padStart(2, "0")}</div>
              <div class="isp-m-desc">Client Terhubung</div>
            </div>
            <div class="isp-metric" style="--m-color:#ef4444">
              <div class="isp-m-lbl">ACL DENY</div>
              <div class="isp-m-val">${String(blockedCount).padStart(2, "0")}</div>
              <div class="isp-m-desc">MAC Diblokir</div>
            </div>
            <div class="isp-metric" style="--m-color:#f59e0b">
              <div class="isp-m-lbl">UNVERIFIED</div>
              <div class="isp-m-val">${String(unknownCount).padStart(2, "0")}</div>
              <div class="isp-m-desc">Perangkat Asing</div>
            </div>
          </div>
        </div>

        <div class="isp-controls">
          <div class="isp-search-box">
            ${SVG.search}
            <input class="isp-search-input" id="swc-search" placeholder="Cari hostname, alamat IPv4, atau MAC..." value="${esc(searchQuery)}" />
          </div>
          <div class="isp-tabs-filter">
            <button class="swc-chip ${filterMode === "all" ? "active" : ""}" data-f="all">Semua <span class="isp-num">(${devs.length})</span></button>
            <button class="swc-chip ${filterMode === "online" ? "active" : ""}" data-f="online">Online <span class="isp-num">(${onlineCount})</span></button>
            <button class="swc-chip ${filterMode === "blocked" ? "active" : ""}" data-f="blocked">Blokir <span class="isp-num">(${blockedCount})</span></button>
            <button class="swc-chip ${filterMode === "unknown" ? "active" : ""}" data-f="unknown">Asing <span class="isp-num">(${unknownCount})</span></button>
          </div>
        </div>

        <div class="isp-dev-list">
          ${filtered.length === 0 ? `<div class="isp-empty">TIDAK ADA DATA SUBSCRIBER PADA FILTER INI</div>` : filtered.map(d => {
            const isBlk = d.block_mode === "blocked";
            const isOn = d.status === "online";
            const label = d.alias || d.hostname || "Unnamed Client";
            return `
              <div class="isp-dev ${isBlk ? "blocked" : (isOn ? "online" : "")}">
                <div class="isp-dev-main">
                  <div style="min-width:0;flex:1">
                    <div class="isp-dev-title">
                      <span class="isp-dev-name">${esc(label)}</span>
                      <span class="isp-tag ${isOn ? "t-on" : "t-off"}">${isOn ? "ONLINE" : "OFFLINE"}</span>
                      ${isBlk ? `<span class="isp-tag t-blk">ACL DENY</span>` : ""}
                      <span class="isp-tag ${d.is_known ? "t-ver" : "t-unv"}">${d.is_known ? "KNOWN" : "UNKNOWN"}</span>
                    </div>
                    <div class="isp-dev-spec">
                      <span>${esc(d.ip || "-")}</span>
                      <span>|</span>
                      <span>${esc((d.mac || "").toUpperCase())}</span>
                      <span>|</span>
                      <span>${esc(d.conn_type || "WLAN")}</span>
                    </div>
                  </div>
                  <button class="swc-btn ${isBlk ? "swc-btn-success" : "swc-btn-danger"}" data-act="block" data-mac="${esc(d.mac)}" data-next="${isBlk ? 0 : 1}">
                    ${isBlk ? `${SVG.allow}<span>Pulihkan</span>` : `${SVG.ban}<span>Blokir</span>`}
                  </button>
                </div>
                <div class="isp-dev-foot">
                  <button class="swc-btn" data-act="rename" data-mac="${esc(d.mac)}" data-alias="${esc(label)}">${SVG.edit}<span>Label</span></button>
                  <button class="swc-btn" data-act="known" data-mac="${esc(d.mac)}" data-known="${d.is_known ? 0 : 1}">
                    ${d.is_known ? `${SVG.flag}<span>Tandai Asing</span>` : `${SVG.verify}<span>Verifikasi</span>`}
                  </button>
                </div>
              </div>
            `;
          }).join("")}
        </div>

        <div class="isp-box">
          <div class="isp-sec-hdr">${SVG.clock}<span>Penjadwalan Kebijakan ACL Otomatis</span></div>
          <div class="isp-form-grid">
            <select class="isp-input" id="swc-sch-mac">
              ${devs.map(d => `<option value="${esc(d.mac)}">${esc(d.alias || d.hostname)} (${esc(d.mac)})</option>`).join("")}
            </select>
            <input class="isp-input" type="time" id="swc-sch-start" value="22:00" />
            <input class="isp-input" type="time" id="swc-sch-end" value="06:00" />
            <button class="swc-btn swc-btn-primary" id="swc-btn-add-sch">${SVG.plus}<span>Tambah</span></button>
          </div>
          <div>
            ${schedules.length === 0 ? `<div class="isp-empty" style="margin-top:8px">BELUM ADA JADWAL TERDAFTAR</div>` : schedules.map(s => `
              <div class="isp-row">
                <div><strong>${esc(devMap.get(s.mac) || s.mac)}</strong> <span style="font-family:var(--isp-mono);color:var(--isp-sky);margin-left:6px">${esc(s.start_time)} - ${esc(s.end_time)}</span></div>
                <button class="swc-btn swc-btn-danger" style="padding:3px 7px" data-del-sch="${s.id}">${SVG.trash}</button>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="isp-box">
          <div class="isp-sec-hdr">${SVG.log}<span>Log Audit Sistem</span></div>
          <div>
            ${logs.length === 0 ? `<div class="isp-empty">BELUM ADA LOG AKTIVITAS</div>` : logs.slice(0, 12).map(l => `
              <div class="isp-log">
                <span style="color:var(--isp-dim)">${fmtTime(l.created_at)}</span>
                <span style="color:var(--isp-sky);font-weight:700">[${esc(l.event_type)}]</span>
                <span>${esc(l.detail)}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;

    if (hadFocus) {
      const inp = document.getElementById("swc-search");
      if (inp) {
        inp.focus();
        if (sStart !== null) inp.setSelectionRange(sStart, sEnd);
      }
    }

    document.getElementById("swc-btn-scan")?.addEventListener("click", async () => {
      if (isMutating) return;
      const btn = document.getElementById("swc-btn-scan");
      if (btn) { btn.disabled = true; btn.innerHTML = `${SVG.spin}<span>Memindai...</span>`; }
      try { await apiPost("/api/scan"); } catch (e) { alert(e.message); renderSwc(); }
    });

    document.getElementById("swc-search")?.addEventListener("input", e => {
      searchQuery = e.target.value;
      renderSwc();
    });

    swcPanel.querySelectorAll(".swc-chip").forEach(btn => {
      btn.addEventListener("click", () => { filterMode = btn.dataset.f; renderSwc(); });
    });

    swcPanel.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (isMutating) return;
        const act = btn.dataset.act, mac = btn.dataset.mac;
        try {
          if (act === "block") {
            btn.disabled = true;
            btn.innerHTML = `${SVG.spin}<span>Proses...</span>`;
            await apiPost("/api/device/block", { mac, block: btn.dataset.next === "1" });
          } else if (act === "rename") {
            const val = prompt("Label nama perangkat:", btn.dataset.alias || "");
            if (val !== null && val.trim()) await apiPost("/api/device/meta", { mac, alias: val.trim() });
          } else if (act === "known") {
            await apiPost("/api/device/meta", { mac, is_known: btn.dataset.known === "1" });
          }
        } catch (e) { alert("Gagal: " + e.message); renderSwc(); }
      });
    });

    document.getElementById("swc-btn-add-sch")?.addEventListener("click", async () => {
      if (isMutating) return;
      const mac = document.getElementById("swc-sch-mac")?.value;
      const start_time = document.getElementById("swc-sch-start")?.value;
      const end_time = document.getElementById("swc-sch-end")?.value;
      if (!mac || !start_time || !end_time) return;
      try { await apiPost("/api/schedule", { mac, start_time, end_time }); } catch (e) { alert(e.message); }
    });

    swcPanel.querySelectorAll("[data-del-sch]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (isMutating) return;
        try {
          const r = await fetchWithFallback(`/api/schedule?id=${btn.dataset.delSch}`, { method: "DELETE" });
          const j = await r.json();
          if (j.ok) { swcData = { state: j.state, devices: j.devices, logs: j.logs, schedules: j.schedules }; renderSwc(); }
        } catch (e) { alert(e.message); }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { initSwcUI(); pollStateOnce(); });
  } else {
    initSwcUI();
    pollStateOnce();
  }
  setInterval(pollStateOnce, 7000);
})();
