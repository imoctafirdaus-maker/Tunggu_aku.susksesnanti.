(function () {
  if (window.__SWC_LOADED__) return;
  window.__SWC_LOADED__ = true;

  const API_BASE = (location.port === "8765") ? "" : "http://127.0.0.1:8765";
  let currentTab = "crypto";
  let swcData = { state: { routerOnline: false, lastScanAt: 0, lastError: "Menghubungkan ke Termux (8765)..." }, devices: [], logs: [], schedules: [] };
  let searchQuery = "";
  let filterMode = "all";
  let touchStartX = 0, touchStartY = 0;
  let lastStreamMsg = 0;
  let isMutating = false;

  const style = document.createElement("style");
  style.id = "swc-injected-style";
  style.textContent = `
    :root {
      --noc-bg: #080a0e;
      --noc-surface: #0e1218;
      --noc-inset: #131821;
      --noc-hover: #19202c;
      --noc-border: #1e2633;
      --noc-border-hi: #2b3648;
      --noc-text: #f1f5f9;
      --noc-sub: #94a3b8;
      --noc-muted: #64748b;
      --noc-accent: #2563eb;
      --noc-cyan: #38bdf8;
      --noc-green: #10b981;
      --noc-red: #ef4444;
      --noc-amber: #f59e0b;
      --noc-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      --noc-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body { padding-top: 50px !important; background: var(--noc-bg); }
    #swc-top-switcher {
      position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 48px !important; z-index: 999999 !important;
      background: rgba(8, 10, 14, 0.96) !important; backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--noc-border) !important;
      display: flex !important; align-items: center !important; justify-content: space-between !important;
      padding: 0 12px !important; font-family: var(--noc-sans) !important; box-sizing: border-box;
    }
    .swc-tabs {
      display: flex !important; gap: 3px; background: var(--noc-surface);
      padding: 3px; border-radius: 6px; border: 1px solid var(--noc-border);
    }
    .swc-tab-btn {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid transparent; background: transparent; color: var(--noc-sub);
      font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em;
      padding: 5px 11px; border-radius: 4px; cursor: pointer; transition: all 0.15s ease;
    }
    .swc-tab-btn svg { width: 13px; height: 13px; opacity: 0.8; }
    .swc-tab-btn.active {
      background: var(--noc-hover); color: #ffffff;
      border-color: var(--noc-border-hi); box-shadow: 0 1px 2px rgba(0,0,0,0.4);
    }
    .swc-tab-btn.active svg { color: var(--noc-cyan); opacity: 1; }
    .swc-dot {
      width: 6px; height: 6px; border-radius: 50%; background: var(--noc-red);
      box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.18); flex-shrink: 0;
    }
    .swc-dot.online {
      background: var(--noc-green); box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2);
    }
    .swc-swipe-hint {
      display: inline-flex; align-items: center; gap: 5px;
      font-family: var(--noc-mono); font-size: 10px; color: var(--noc-muted);
      letter-spacing: 0.04em; text-transform: uppercase;
    }
    #swc-panel {
      display: none; min-height: calc(100vh - 50px);
      background: var(--noc-bg); color: var(--noc-text);
      font-family: var(--noc-sans); padding: 12px; box-sizing: border-box;
    }
    .swc-wrap { max-width: 780px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }

    /* Gateway Header Card */
    .noc-gateway {
      background: var(--noc-surface); border: 1px solid var(--noc-border);
      border-radius: 8px; padding: 14px;
    }
    .noc-gw-top {
      display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;
    }
    .noc-gw-eyebrow {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: var(--noc-mono); font-size: 10px; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase; color: var(--noc-cyan);
      margin-bottom: 4px;
    }
    .noc-gw-title {
      margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; color: #f8fafc;
    }
    .noc-gw-status {
      display: inline-flex; align-items: center; gap: 6px; margin-top: 6px;
      font-family: var(--noc-mono); font-size: 10.5px; color: var(--noc-sub);
      background: var(--noc-inset); border: 1px solid var(--noc-border);
      padding: 3px 8px; border-radius: 4px;
    }
    .noc-gw-status.is-err { color: #fca5a5; border-color: rgba(239,68,68,0.3); background: rgba(239,68,68,0.08); }
    .noc-pulse {
      width: 6px; height: 6px; border-radius: 50%; background: var(--noc-green);
      animation: nocPulse 2s infinite;
    }
    .noc-pulse.err { background: var(--noc-red); animation: none; }
    @keyframes nocPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    @keyframes nocSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .noc-spin { animation: nocSpin 0.8s linear infinite; }

    /* KPI Strip */
    .noc-kpi-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px;
    }
    .noc-kpi {
      background: var(--noc-inset); border: 1px solid var(--noc-border);
      border-radius: 6px; padding: 9px 10px; position: relative; overflow: hidden;
    }
    .noc-kpi::before {
      content: ""; position: absolute; top: 0; left: 0; right: 0; height: 2px;
      background: var(--kpi-accent, var(--noc-border-hi));
    }
    .noc-kpi-lbl {
      font-family: var(--noc-mono); font-size: 9.5px; font-weight: 600;
      letter-spacing: 0.06em; text-transform: uppercase; color: var(--noc-muted);
    }
    .noc-kpi-val {
      font-family: var(--noc-mono); font-size: 20px; font-weight: 700;
      font-variant-numeric: tabular-nums; color: #f8fafc; margin-top: 2px; line-height: 1.2;
    }
    .noc-kpi-sub { font-size: 10.5px; color: var(--noc-sub); margin-top: 2px; }

    /* Search & Filter Toolbar */
    .noc-toolbar { display: flex; flex-direction: column; gap: 8px; }
    .noc-search-wrap { position: relative; display: flex; align-items: center; }
    .noc-search-wrap svg {
      position: absolute; left: 11px; color: var(--noc-muted); pointer-events: none;
    }
    .noc-input {
      width: 100%; background: var(--noc-surface); border: 1px solid var(--noc-border);
      border-radius: 6px; padding: 9px 12px 9px 33px; color: var(--noc-text);
      font-family: var(--noc-sans); font-size: 12.5px; outline: none; box-sizing: border-box;
      transition: border-color 0.15s ease;
    }
    .noc-input:focus { border-color: var(--noc-accent); }
    .noc-input::placeholder { color: var(--noc-muted); }

    .noc-seg-bar {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
      background: var(--noc-surface); border: 1px solid var(--noc-border);
      padding: 3px; border-radius: 6px;
    }
    .swc-chip {
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      background: transparent; border: 1px solid transparent; color: var(--noc-sub);
      font-size: 11.5px; font-weight: 600; padding: 6px 6px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s ease;
    }
    .swc-chip.active {
      background: var(--noc-hover); color: #ffffff; border-color: var(--noc-border-hi);
    }
    .noc-cnt {
      font-family: var(--noc-mono); font-size: 10px; color: var(--noc-muted);
      background: var(--noc-bg); padding: 1px 5px; border-radius: 3px;
    }
    .swc-chip.active .noc-cnt { color: var(--noc-cyan); }

    /* Buttons */
    .swc-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      background: var(--noc-inset); border: 1px solid var(--noc-border-hi);
      color: var(--noc-text); font-family: var(--noc-sans); font-size: 11.5px; font-weight: 600;
      padding: 6px 11px; border-radius: 5px; cursor: pointer; transition: all 0.15s ease;
      white-space: nowrap;
    }
    .swc-btn:hover:not(:disabled) { background: var(--noc-hover); border-color: #3b4961; }
    .swc-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .swc-btn-primary {
      background: #1d4ed8; border-color: #2563eb; color: #ffffff;
    }
    .swc-btn-primary:hover:not(:disabled) { background: #2563eb; }
    .swc-btn-danger {
      background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.34); color: #fca5a5;
    }
    .swc-btn-danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.18); border-color: rgba(239, 68, 68, 0.5); }
    .swc-btn-success {
      background: rgba(16, 185, 129, 0.12); border-color: rgba(16, 185, 129, 0.36); color: #6ee7b7;
    }
    .swc-btn-success:hover:not(:disabled) { background: rgba(16, 185, 129, 0.2); border-color: rgba(16, 185, 129, 0.52); }

    /* Client Cards */
    .noc-list { display: flex; flex-direction: column; gap: 8px; }
    .noc-card {
      background: var(--noc-surface); border: 1px solid var(--noc-border);
      border-left: 3px solid #334155; border-radius: 6px; padding: 11px 12px;
      display: flex; flex-direction: column; gap: 9px;
    }
    .noc-card.is-online { border-left-color: var(--noc-green); }
    .noc-card.is-blocked {
      background: #120d10; border-color: rgba(239, 68, 68, 0.26); border-left-color: var(--noc-red);
    }
    .noc-card-top {
      display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;
    }
    .noc-card-info { min-width: 0; flex: 1; }
    .noc-name-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .noc-hostname {
      font-size: 13.5px; font-weight: 700; color: #f8fafc;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px;
    }
    .noc-badge {
      font-family: var(--noc-mono); font-size: 9.5px; font-weight: 700;
      letter-spacing: 0.05em; text-transform: uppercase;
      padding: 2px 6px; border-radius: 3px; border: 1px solid transparent;
    }
    .noc-badge-on { background: rgba(16,185,129,0.1); color: #34d399; border-color: rgba(16,185,129,0.25); }
    .noc-badge-off { background: rgba(100,116,139,0.12); color: #94a3b8; border-color: rgba(100,116,139,0.22); }
    .noc-badge-blk { background: rgba(239,68,68,0.14); color: #f87171; border-color: rgba(239,68,68,0.32); }
    .noc-badge-known { background: rgba(56,189,248,0.08); color: #7dd3fc; border-color: rgba(56,189,248,0.22); }
    .noc-badge-unk { background: rgba(245,158,11,0.1); color: #fbbf24; border-color: rgba(245,158,11,0.26); }

    .noc-meta {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      font-family: var(--noc-mono); font-size: 11px; color: var(--noc-sub); margin-top: 5px;
    }
    .noc-sep { color: #334155; }
    .noc-card-actions {
      display: flex; align-items: center; gap: 6px; padding-top: 8px;
      border-top: 1px solid rgba(30, 38, 51, 0.8);
    }
    .noc-card-actions .swc-btn { padding: 5px 9px; font-size: 11px; color: var(--noc-sub); }
    .noc-card-actions .swc-btn:hover { color: #f8fafc; }

    /* Sub-panels (Schedules & Audit Logs) */
    .noc-section {
      background: var(--noc-surface); border: 1px solid var(--noc-border);
      border-radius: 8px; padding: 12px;
    }
    .noc-sec-head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--noc-border);
    }
    .noc-sec-title {
      display: inline-flex; align-items: center; gap: 7px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.02em; color: #e2e8f0;
      text-transform: uppercase;
    }
    .noc-sec-title svg { color: var(--noc-cyan); }
    .noc-sch-form {
      display: grid; grid-template-columns: 1fr auto auto auto; gap: 6px; align-items: center;
    }
    @media (max-width: 540px) {
      .noc-sch-form { grid-template-columns: 1fr 1fr; }
      .noc-sch-form select { grid-column: span 2; }
      .noc-sch-form button { grid-column: span 2; }
    }
    .noc-field {
      background: var(--noc-inset); border: 1px solid var(--noc-border);
      color: var(--noc-text); border-radius: 5px; padding: 7px 9px;
      font-family: var(--noc-mono); font-size: 11.5px; outline: none;
    }
    .noc-sch-list, .noc-log-list {
      display: flex; flex-direction: column; gap: 5px; margin-top: 8px;
    }
    .noc-sch-item {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      background: var(--noc-inset); border: 1px solid var(--noc-border);
      padding: 7px 10px; border-radius: 5px; font-size: 11.5px;
    }
    .noc-log-item {
      display: flex; align-items: baseline; gap: 8px;
      font-family: var(--noc-mono); font-size: 10.5px; color: var(--noc-sub);
      padding: 4px 6px; border-bottom: 1px solid rgba(30, 38, 51, 0.5);
    }
    .noc-log-item:last-child { border-bottom: none; }
    .noc-log-ts { color: var(--noc-muted); flex-shrink: 0; }
    .noc-log-tag {
      font-size: 9.5px; font-weight: 700; padding: 1px 4px; border-radius: 3px;
      background: var(--noc-inset); color: var(--noc-cyan); flex-shrink: 0;
    }
    .noc-log-tag.BLOCK { color: #f87171; background: rgba(239,68,68,0.12); }
    .noc-log-tag.UNBLOCK { color: #34d399; background: rgba(16,185,129,0.12); }
    .noc-empty {
      text-align: center; padding: 18px 12px; color: var(--noc-muted);
      font-family: var(--noc-mono); font-size: 11.5px;
      border: 1px dashed var(--noc-border); border-radius: 6px;
    }
  `;
  document.head.appendChild(style);

  function initSwcUI() {
    if (document.getElementById("swc-top-switcher")) return;

    const switcher = document.createElement("div");
    switcher.id = "swc-top-switcher";
    switcher.innerHTML = `
      <div class="swc-tabs">
        <button class="swc-tab-btn active" data-tab="crypto">${NOC_ICONS.radar}<span>Radar Sinyal</span></button>
        <button class="swc-tab-btn" data-tab="wifi"><span class="swc-dot" id="swc-router-dot"></span>${NOC_ICONS.router}<span>Gateway Wi-Fi</span></button>
      </div>
      <span class="swc-swipe-hint">${NOC_ICONS.swipe}<span>Geser</span></span>
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

    function setTab(tab) {
      currentTab = tab;
      switcher.querySelectorAll(".swc-tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
      if (tab === "wifi") {
        cryptoHost.style.display = "none";
        swcPanel.classList.add("active");
        pollStateOnce();
        renderSwc();
      } else {
        swcPanel.classList.remove("active");
        cryptoHost.style.display = "block";
      }
    }

    switcher.addEventListener("click", e => {
      const btn = e.target.closest(".swc-tab-btn");
      if (btn) setTab(btn.dataset.tab);
    });

    document.addEventListener("touchstart", e => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    document.addEventListener("touchend", e => {
      if (!touchStartX || e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartX = 0; touchStartY = 0;
      if (Math.abs(dx) > 75 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        if (dx < 0 && currentTab === "crypto") setTab("wifi");
        else if (dx > 0 && currentTab === "wifi") setTab("crypto");
      }
    }, { passive: true });
  }

  async function apiPost(path, payload = {}) {
    isMutating = true;
    try {
      const r = await fetch(API_BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Permintaan gagal");
      swcData = { state: j.state, devices: j.devices, logs: j.logs, schedules: j.schedules };
    } finally {
      isMutating = false;
      renderSwc();
    }
  }

  async function pollStateOnce() {
    if (isMutating) return;
    try {
      const r = await fetch(API_BASE + "/api/state");
      if (r.ok && !isMutating) {
        swcData = await r.json();
        renderSwc();
      }
    } catch (e) {
      swcData.state.routerOnline = false;
      swcData.state.lastError = "Backend lokal Termux (8765) belum aktif";
      renderSwc();
    }
  }

  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtTime(ts) {
    if (!ts) return "-";
    return new Date(ts).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  const NOC_ICONS = {
    radar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    router: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="14" width="20" height="6" rx="1.5"/><path d="M6 14v-3"/><path d="M18 14v-3"/><path d="M14.5 8.5a4 4 0 0 1 7 0"/><path d="M16.5 10.5a1.5 1.5 0 0 1 3 0"/><circle cx="6" cy="17" r="1" fill="currentColor" stroke="none"/><circle cx="9.5" cy="17" r="1" fill="currentColor" stroke="none"/></svg>',
    swipe: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l-3 3 3 3"/><path d="M4 13h16"/><path d="M17 14l3-3-3-3"/></svg>',
    scan: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    block: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/></svg>',
    restore: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
    tag: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trust: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>',
    alert: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="12"/><line x1="19" y1="16" x2="19.01" y2="16"/></svg>',
    clock: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
    plus: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    terminal: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    spinner: '<svg class="noc-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>'
  };

  function upgradeTopSwitcherIcons() {
    const sw = document.getElementById("swc-top-switcher");
    if (!sw) return;
    const cryptoBtn = sw.querySelector('[data-tab="crypto"]');
    const wifiBtn = sw.querySelector('[data-tab="wifi"]');
    const hint = sw.querySelector(".swc-swipe-hint");
    if (cryptoBtn) cryptoBtn.innerHTML = `${NOC_ICONS.radar}<span>Radar Sinyal</span>`;
    if (wifiBtn) wifiBtn.innerHTML = `<span class="swc-dot${swcData.state?.routerOnline ? " online" : ""}" id="swc-router-dot"></span>${NOC_ICONS.router}<span>Gateway Wi-Fi</span>`;
    if (hint) hint.innerHTML = `${NOC_ICONS.swipe}<span>Geser</span>`;
  }

  function renderSwc() {
    upgradeTopSwitcherIcons();
    const dot = document.getElementById("swc-router-dot");
    if (dot) dot.classList.toggle("online", !!swcData.state?.routerOnline);
    if (currentTab !== "wifi") return;

    const swcPanel = document.getElementById("swc-panel");
    if (!swcPanel) return;

    const hadSearchFocus = document.activeElement && document.activeElement.id === "swc-search";
    const selStart = hadSearchFocus ? document.activeElement.selectionStart : null;
    const selEnd = hadSearchFocus ? document.activeElement.selectionEnd : null;

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
    const rawErr = swcData.state?.lastError || "";
    const statusText = isOnline
      ? `TERHUBUNG • SYNC ${fmtTime(swcData.state.lastScanAt)}`
      : (rawErr.toLowerCase().includes("fetch") ? "BACKEND LOKAL OFFLINE (PORT 8765)" : esc(rawErr || "MENGHUBUNGKAN..."));

    const devMap = new Map(devs.map(d => [d.mac, d.alias || d.hostname || d.mac]));

    swcPanel.innerHTML = `
      <div class="swc-wrap">
        <div class="noc-gateway">
          <div class="noc-gw-top">
            <div>
              <div class="noc-gw-eyebrow">${NOC_ICONS.router} CPE GATEWAY • 192.168.1.1</div>
              <h2 class="noc-gw-title">ZTE F672Y Access Control</h2>
              <div class="noc-gw-status ${isOnline ? "" : "is-err"}">
                <span class="noc-pulse ${isOnline ? "" : "err"}"></span>
                <span>${statusText}</span>
              </div>
            </div>
            <button class="swc-btn swc-btn-primary" id="swc-btn-scan">${NOC_ICONS.scan}<span>Pindai</span></button>
          </div>
          <div class="noc-kpi-grid">
            <div class="noc-kpi" style="--kpi-accent:#10b981">
              <div class="noc-kpi-lbl">AKTIF</div>
              <div class="noc-kpi-val">${String(onlineCount).padStart(2, "0")}</div>
              <div class="noc-kpi-sub">Perangkat Online</div>
            </div>
            <div class="noc-kpi" style="--kpi-accent:#ef4444">
              <div class="noc-kpi-lbl">ACL BLOKIR</div>
              <div class="noc-kpi-val">${String(blockedCount).padStart(2, "0")}</div>
              <div class="noc-kpi-sub">Akses Diputus</div>
            </div>
            <div class="noc-kpi" style="--kpi-accent:#f59e0b">
              <div class="noc-kpi-lbl">ASING</div>
              <div class="noc-kpi-val">${String(unknownCount).padStart(2, "0")}</div>
              <div class="noc-kpi-sub">Belum Dikenal</div>
            </div>
          </div>
        </div>

        <div class="noc-toolbar">
          <div class="noc-search-wrap">
            ${NOC_ICONS.search}
            <input class="noc-input" id="swc-search" placeholder="Filter hostname, IPv4, atau alamat MAC..." value="${esc(searchQuery)}" />
          </div>
          <div class="noc-seg-bar">
            <button class="swc-chip ${filterMode === "all" ? "active" : ""}" data-f="all">Semua <span class="noc-cnt">${devs.length}</span></button>
            <button class="swc-chip ${filterMode === "online" ? "active" : ""}" data-f="online">Online <span class="noc-cnt">${onlineCount}</span></button>
            <button class="swc-chip ${filterMode === "blocked" ? "active" : ""}" data-f="blocked">Blokir <span class="noc-cnt">${blockedCount}</span></button>
            <button class="swc-chip ${filterMode === "unknown" ? "active" : ""}" data-f="unknown">Asing <span class="noc-cnt">${unknownCount}</span></button>
          </div>
        </div>

        <div class="noc-list">
          ${filtered.length === 0 ? `<div class="noc-empty">TIDAK ADA CLIENT YANG SESUAI FILTER</div>` : filtered.map(d => {
            const isBlk = d.block_mode === "blocked";
            const isOn = d.status === "online";
            const label = d.alias || d.hostname || "Client Tanpa Nama";
            return `
              <div class="noc-card ${isBlk ? "is-blocked" : (isOn ? "is-online" : "")}">
                <div class="noc-card-top">
                  <div class="noc-card-info">
                    <div class="noc-name-row">
                      <span class="noc-hostname">${esc(label)}</span>
                      <span class="noc-badge ${isOn ? "noc-badge-on" : "noc-badge-off"}">${isOn ? "ONLINE" : "OFFLINE"}</span>
                      ${isBlk ? `<span class="noc-badge noc-badge-blk">ACL DENY</span>` : ""}
                      <span class="noc-badge ${d.is_known ? "noc-badge-known" : "noc-badge-unk"}">${d.is_known ? "VERIFIED" : "UNVERIFIED"}</span>
                    </div>
                    <div class="noc-meta">
                      <span>${esc(d.ip || "-")}</span>
                      <span class="noc-sep">/</span>
                      <span>${esc((d.mac || "").toUpperCase())}</span>
                      <span class="noc-sep">/</span>
                      <span>${esc(d.conn_type || "WLAN")}</span>
                    </div>
                  </div>
                  <button class="swc-btn ${isBlk ? "swc-btn-success" : "swc-btn-danger"}" data-act="block" data-mac="${esc(d.mac)}" data-next="${isBlk ? 0 : 1}">
                    ${isBlk ? `${NOC_ICONS.restore}<span>Pulihkan</span>` : `${NOC_ICONS.block}<span>Blokir</span>`}
                  </button>
                </div>
                <div class="noc-card-actions">
                  <button class="swc-btn" data-act="rename" data-mac="${esc(d.mac)}" data-alias="${esc(label)}">
                    ${NOC_ICONS.tag}<span>Alias</span>
                  </button>
                  <button class="swc-btn" data-act="known" data-mac="${esc(d.mac)}" data-known="${d.is_known ? 0 : 1}">
                    ${d.is_known ? `${NOC_ICONS.alert}<span>Tandai Asing</span>` : `${NOC_ICONS.trust}<span>Verifikasi</span>`}
                  </button>
                </div>
              </div>
            `;
          }).join("")}
        </div>

        <div class="noc-section">
          <div class="noc-sec-head">
            <div class="noc-sec-title">${NOC_ICONS.clock}<span>Kebijakan Jadwal Blokir Otomatis</span></div>
          </div>
          <div class="noc-sch-form">
            <select class="noc-field" id="swc-sch-mac">
              ${devs.map(d => `<option value="${esc(d.mac)}">${esc(d.alias || d.hostname)} (${esc(d.mac)})</option>`).join("")}
            </select>
            <input class="noc-field" type="time" id="swc-sch-start" value="22:00" />
            <input class="noc-field" type="time" id="swc-sch-end" value="06:00" />
            <button class="swc-btn swc-btn-primary" id="swc-btn-add-sch">${NOC_ICONS.plus}<span>Tambah</span></button>
          </div>
          <div class="noc-sch-list">
            ${schedules.length === 0 ? `<div class="noc-empty">BELUM ADA ATURAN JADWAL AKTIF</div>` : schedules.map(s => `
              <div class="noc-sch-item">
                <div>
                  <strong style="color:#f1f5f9">${esc(devMap.get(s.mac) || s.mac)}</strong>
                  <span style="font-family:var(--noc-mono);color:var(--noc-cyan);margin-left:8px">${esc(s.start_time)} - ${esc(s.end_time)}</span>
                </div>
                <button class="swc-btn swc-btn-danger" style="padding:4px 8px" data-del-sch="${s.id}">${NOC_ICONS.trash}</button>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="noc-section">
          <div class="noc-sec-head">
            <div class="noc-sec-title">${NOC_ICONS.terminal}<span>Log Audit Sistem</span></div>
          </div>
          <div class="noc-log-list">
            ${logs.length === 0 ? `<div class="noc-empty">BELUM ADA AKTIVITAS TERCATAT</div>` : logs.slice(0, 12).map(l => `
              <div class="noc-log-item">
                <span class="noc-log-ts">${fmtTime(l.created_at)}</span>
                <span class="noc-log-tag ${esc(l.event_type)}">${esc(l.event_type)}</span>
                <span>${esc(l.detail)}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;

    if (hadSearchFocus) {
      const inp = document.getElementById("swc-search");
      if (inp) {
        inp.focus();
        if (selStart !== null) inp.setSelectionRange(selStart, selEnd);
      }
    }

    document.getElementById("swc-btn-scan")?.addEventListener("click", async () => {
      if (isMutating) return;
      const btn = document.getElementById("swc-btn-scan");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `${NOC_ICONS.spinner}<span>Memindai...</span>`;
      }
      try { await apiPost("/api/scan"); } catch (err) { alert(err.message); renderSwc(); }
    });

    document.getElementById("swc-search")?.addEventListener("input", e => {
      searchQuery = e.target.value;
      renderSwc();
    });

    swcPanel.querySelectorAll(".swc-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        filterMode = btn.dataset.f;
        renderSwc();
      });
    });

    swcPanel.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (isMutating) return;
        const act = btn.dataset.act, mac = btn.dataset.mac;
        try {
          if (act === "block") {
            btn.disabled = true;
            btn.innerHTML = `${NOC_ICONS.spinner}<span>Proses...</span>`;
            await apiPost("/api/device/block", { mac, block: btn.dataset.next === "1" });
          } else if (act === "rename") {
            const val = prompt("Masukkan alias perangkat:", btn.dataset.alias || "");
            if (val !== null && val.trim()) await apiPost("/api/device/meta", { mac, alias: val.trim() });
          } else if (act === "known") {
            await apiPost("/api/device/meta", { mac, is_known: btn.dataset.known === "1" });
          }
        } catch (err) {
          alert("Gagal: " + err.message);
          renderSwc();
        }
      });
    });

    document.getElementById("swc-btn-add-sch")?.addEventListener("click", async () => {
      if (isMutating) return;
      const mac = document.getElementById("swc-sch-mac")?.value;
      const start_time = document.getElementById("swc-sch-start")?.value;
      const end_time = document.getElementById("swc-sch-end")?.value;
      if (!mac || !start_time || !end_time) return;
      try { await apiPost("/api/schedule", { mac, start_time, end_time }); } catch (err) { alert(err.message); }
    });

    swcPanel.querySelectorAll("[data-del-sch]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (isMutating) return;
        try {
          const r = await fetch(`${API_BASE}/api/schedule?id=${btn.dataset.delSch}`, { method: "DELETE" });
          const j = await r.json();
          if (j.ok) { swcData = { state: j.state, devices: j.devices, logs: j.logs, schedules: j.schedules }; renderSwc(); }
        } catch (err) { alert(err.message); }
      });
    });
  }

  function connectStream() {
    pollStateOnce();
    try {
      const es = new EventSource(API_BASE + "/api/stream");
      es.onmessage = ev => {
        try {
          lastStreamMsg = Date.now();
          if (isMutating) return;
          swcData = JSON.parse(ev.data);
          renderSwc();
        } catch (_) {}
      };
      es.onerror = () => {
        es.close();
        setTimeout(connectStream, 5000);
      };
    } catch (_) {}
    setInterval(() => {
      if (Date.now() - lastStreamMsg > 6000) pollStateOnce();
    }, 5000);
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden && !isMutating) pollStateOnce(); });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { initSwcUI(); upgradeTopSwitcherIcons(); renderSwc(); connectStream(); });
  } else {
    initSwcUI();
    connectStream();
  }
})();
