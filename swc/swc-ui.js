"use strict";
(function () {
  const CANDIDATE_BASES = [
    window.location.protocol === "http:" ? "" : "https://127.0.0.1:8766",
    "http://127.0.0.1:8765"
  ];
  let API_BASE = window.location.protocol === "http:" ? "" : "https://127.0.0.1:8766";
  let currentTab = localStorage.getItem("swc_active_tab") || "crypto";
  let filterMode = "all";
  let searchQuery = "";
  let isMutating = false;
  let swcData = {
    state: { routerOnline: false, lastScanAt: null, lastError: "MENGHUBUNGKAN KE GATEWAY..." },
    devices: [],
    logs: [],
    schedules: []
  };

  const SVG = {
    radar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    gateway: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="14" width="20" height="6" rx="1.5"/><path d="M6 14V9M18 14V9M9.5 6.5a4.5 4.5 0 0 1 5 0M7 4a8 8 0 0 1 10 0"/><circle cx="6" cy="17" r="0.8" fill="currentColor"/><circle cx="9.5" cy="17" r="0.8" fill="currentColor"/></svg>',
    scan: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-15-6.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15 6.7L21 16"/><path d="M16 16h5v5"/></svg>',
    search: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/></svg>',
    block: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="5.7" y1="5.7" x2="18.3" y2="18.3"/></svg>',
    allow: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
    edit: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    verify: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="8.5 12 11 14.5 16 9.5"/></svg>',
    flag: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    clock: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>',
    plus: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    log: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="14" y2="13"/><line x1="7" y1="17" x2="11" y2="17"/></svg>',
    ext: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    spin: '<svg class="ag-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>'
  };

  const style = document.createElement("style");
  style.textContent = `
    :root {
      --ag-cream: #FAF6F0;
      --ag-cream-sub: #F3ECE1;
      --ag-card: #FFFFFF;
      --ag-card-hover: #FFF8F1;
      --ag-stroke: #E6DDD0;
      --ag-stroke-hi: #D6C7B2;
      --ag-ink: #1C1917;
      --ag-ink-muted: #57534E;
      --ag-ink-dim: #78716C;
      --ag-orange: #EA580C;
      --ag-orange-deep: #C2410C;
      --ag-orange-soft: #FFF7ED;
      --ag-ok: #059669;
      --ag-err: #DC2626;
      --ag-warn: #D97706;
      --ag-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      --ag-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body {
      padding-top: 54px !important;
    }
    body.swc-wifi-mode {
      background:
        radial-gradient(120% 45% at 50% 0%, rgba(234, 88, 12, 0.08) 0%, rgba(250, 246, 240, 0) 70%),
        var(--ag-cream) !important;
    }
    #swc-top-switcher {
      position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 54px !important;
      z-index: 999999 !important;
      background: linear-gradient(135deg, #EA580C 0%, #C2410C 100%) !important;
      border-bottom: 1px solid rgba(154, 52, 18, 0.45) !important;
      box-shadow: 0 4px 14px -4px rgba(194, 65, 12, 0.35) !important;
      display: flex !important; align-items: center !important; justify-content: space-between !important;
      padding: 0 14px !important; font-family: var(--ag-sans) !important; box-sizing: border-box;
    }
    .ag-seg {
      display: inline-flex; gap: 3px; padding: 3px; border-radius: 10px;
      background: rgba(124, 45, 18, 0.35); border: 1px solid rgba(255, 255, 255, 0.18);
    }
    .swc-tab-btn {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid transparent; background: transparent; color: rgba(255, 247, 237, 0.85);
      font-size: 12px; font-weight: 600; letter-spacing: -0.01em;
      padding: 5px 11px; border-radius: 7px; cursor: pointer;
      transition: all 0.16s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .swc-tab-btn.active {
      background: #FFFBF5;
      color: #9A3412; border-color: #FED7AA;
      box-shadow: 0 2px 6px rgba(124, 45, 18, 0.25);
    }
    .swc-tab-btn.active svg { color: #EA580C; }
    .ag-led {
      width: 7px; height: 7px; border-radius: 50%; background: #FCA5A5;
      box-shadow: 0 0 6px rgba(254, 202, 202, 0.8); flex-shrink: 0;
    }
    .ag-led.on { background: #34D399; box-shadow: 0 0 8px rgba(52, 211, 153, 0.85); }
    .ag-badge-env {
      font-family: var(--ag-mono); font-size: 10px; font-weight: 700; color: #FFF7ED;
      padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.25);
      background: rgba(124, 45, 18, 0.32); letter-spacing: 0.04em;
    }

    #swc-panel {
      display: none; min-height: calc(100vh - 54px);
      background: var(--ag-cream);
      color: var(--ag-ink); font-family: var(--ag-sans);
      padding: 14px 12px 30px; box-sizing: border-box;
    }
    .ag-container { max-width: 800px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }

    .ag-glass {
      background: var(--ag-card);
      border: 1px solid var(--ag-stroke);
      border-radius: 14px; padding: 14px;
      box-shadow: 0 4px 16px -4px rgba(120, 90, 50, 0.08), 0 1px 2px rgba(120, 90, 50, 0.04);
    }

    .ag-alert {
      background: #FFFBEB; border: 1px solid #FCD34D;
      border-radius: 12px; padding: 10px 12px;
      display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
    }
    .ag-alert-title { font-size: 12px; font-weight: 700; color: #92400E; }
    .ag-alert-sub { font-family: var(--ag-mono); font-size: 10px; color: #B45309; margin-top: 2px; }

    .ag-hdr { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .ag-overline {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: var(--ag-mono); font-size: 10px; font-weight: 700;
      letter-spacing: 0.07em; text-transform: uppercase; color: var(--ag-orange);
    }
    .ag-h1 { margin: 4px 0 0; font-size: 16.5px; font-weight: 700; letter-spacing: -0.02em; color: var(--ag-ink); }
    .ag-status-chip {
      display: inline-flex; align-items: center; gap: 6px; margin-top: 8px;
      font-family: var(--ag-mono); font-size: 10.5px; font-weight: 600; color: #065F46;
      background: #ECFDF5; border: 1px solid #A7F3D0;
      padding: 4px 9px; border-radius: 7px;
    }
    .ag-status-chip.err { color: #991B1B; border-color: #FECACA; background: #FEF2F2; }

    .ag-kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 13px; }
    .ag-kpi {
      background: var(--ag-cream); border: 1px solid var(--ag-stroke);
      border-radius: 10px; padding: 10px 11px; position: relative; overflow: hidden;
    }
    .ag-kpi::before {
      content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px;
      background: var(--kpi-tint, var(--ag-orange));
    }
    .ag-kpi-lbl { font-family: var(--ag-mono); font-size: 9.5px; font-weight: 700; color: var(--ag-ink-dim); letter-spacing: 0.06em; }
    .ag-kpi-num { font-family: var(--ag-mono); font-size: 21px; font-weight: 800; color: var(--ag-ink); margin-top: 2px; font-variant-numeric: tabular-nums; }
    .ag-kpi-sub { font-size: 10.5px; color: var(--ag-ink-muted); margin-top: 1px; }

    .ag-toolbar { display: flex; flex-direction: column; gap: 8px; }
    .ag-search { position: relative; display: flex; align-items: center; }
    .ag-search svg { position: absolute; left: 11px; color: var(--ag-ink-dim); pointer-events: none; }
    .ag-search input {
      width: 100%; background: var(--ag-card); border: 1px solid var(--ag-stroke);
      border-radius: 10px; padding: 9px 12px 9px 33px; color: var(--ag-ink);
      font-family: var(--ag-sans); font-size: 12.5px; outline: none; box-sizing: border-box;
    }
    .ag-search input::placeholder { color: var(--ag-ink-dim); }
    .ag-search input:focus { border-color: var(--ag-orange); box-shadow: 0 0 0 3px rgba(234, 88, 12, 0.14); }

    .ag-filter-bar {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
      background: var(--ag-cream-sub); border: 1px solid var(--ag-stroke); padding: 4px; border-radius: 10px;
    }
    .swc-chip {
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      background: transparent; border: 1px solid transparent; color: var(--ag-ink-muted);
      font-size: 11px; font-weight: 600; padding: 6px 4px; border-radius: 7px; cursor: pointer;
    }
    .swc-chip.active { background: var(--ag-card); color: var(--ag-orange-deep); border-color: #FED7AA; box-shadow: 0 1px 3px rgba(120, 90, 50, 0.08); }
    .ag-cnt { font-family: var(--ag-mono); font-size: 10px; color: var(--ag-ink-dim); }
    .swc-chip.active .ag-cnt { color: var(--ag-orange); font-weight: 700; }

    .swc-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      background: var(--ag-cream); border: 1px solid var(--ag-stroke-hi);
      color: var(--ag-ink); font-family: var(--ag-sans); font-size: 11.5px; font-weight: 600;
      padding: 6px 11px; border-radius: 8px; cursor: pointer; text-decoration: none; white-space: nowrap;
      transition: background 0.14s ease, border-color 0.14s ease;
    }
    .swc-btn:hover:not(:disabled) { background: var(--ag-card-hover); border-color: #FDBA74; }
    .swc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .swc-btn-primary {
      background: linear-gradient(180deg, #F97316, #EA580C);
      border-color: #C2410C; color: #FFFFFF;
      box-shadow: 0 2px 8px rgba(234, 88, 12, 0.28);
    }
    .swc-btn-primary:hover:not(:disabled) { background: linear-gradient(180deg, #EA580C, #C2410C); }
    .swc-btn-danger { background: #FEF2F2; border-color: #FECACA; color: #B91C1C; }
    .swc-btn-success { background: #ECFDF5; border-color: #A7F3D0; color: #047857; }
    .swc-btn-warn { background: #FFFBEB; border-color: #FCD34D; color: #92400E; }

    .ag-list { display: flex; flex-direction: column; gap: 8px; }
    .ag-node {
      background: var(--ag-card); border: 1px solid var(--ag-stroke);
      border-radius: 12px; padding: 12px 13px;
      display: flex; flex-direction: column; gap: 9px;
      box-shadow: 0 2px 8px -2px rgba(120, 90, 50, 0.06);
    }
    .ag-node.online { border-left: 3px solid var(--ag-ok); }
    .ag-node.blocked { background: #FFF5F5; border-color: #FECACA; border-left: 3px solid var(--ag-err); }
    .ag-node-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .ag-node-name-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .ag-node-name { font-size: 13.5px; font-weight: 700; color: var(--ag-ink); max-width: 185px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ag-pill {
      font-family: var(--ag-mono); font-size: 9px; font-weight: 700; letter-spacing: 0.05em;
      padding: 2px 6px; border-radius: 5px; text-transform: uppercase;
    }
    .p-on { background: #ECFDF5; color: #047857; border: 1px solid #A7F3D0; }
    .p-off { background: #F5F5F4; color: #57534E; border: 1px solid #E7E5E4; }
    .p-blk { background: #FEF2F2; color: #B91C1C; border: 1px solid #FECACA; }
    .p-ver { background: var(--ag-orange-soft); color: var(--ag-orange-deep); border: 1px solid #FED7AA; }
    .p-unv { background: #FFFBEB; color: #B45309; border: 1px solid #FDE68A; }
    .ag-node-meta {
      font-family: var(--ag-mono); font-size: 11px; color: var(--ag-ink-muted);
      margin-top: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    }
    .ag-node-actions {
      display: flex; align-items: center; gap: 6px; padding-top: 8px;
      border-top: 1px solid var(--ag-cream-sub);
    }
    .ag-node-actions .swc-btn { padding: 4px 9px; font-size: 11px; color: var(--ag-ink-muted); }

    .ag-sec-title {
      display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.05em; color: var(--ag-ink);
      padding-bottom: 9px; margin-bottom: 10px; border-bottom: 1px solid var(--ag-stroke);
    }
    .ag-sec-title svg { color: var(--ag-orange); }
    .ag-form { display: grid; grid-template-columns: 1fr auto auto auto; gap: 6px; }
    @media (max-width: 540px) {
      .ag-form { grid-template-columns: 1fr 1fr; }
      .ag-form select, .ag-form button { grid-column: span 2; }
    }
    .ag-field {
      background: var(--ag-cream); border: 1px solid var(--ag-stroke); color: var(--ag-ink);
      border-radius: 8px; padding: 7px 9px; font-family: var(--ag-mono); font-size: 11.5px; outline: none;
    }
    .ag-field:focus { border-color: var(--ag-orange); }
    .ag-item-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      background: var(--ag-cream); border: 1px solid var(--ag-stroke);
      padding: 7px 10px; border-radius: 8px; font-size: 11.5px; margin-top: 6px; color: var(--ag-ink);
    }
    .ag-log-line {
      font-family: var(--ag-mono); font-size: 10.5px; color: var(--ag-ink-muted);
      padding: 6px 4px; border-bottom: 1px solid var(--ag-cream-sub);
      display: flex; gap: 7px; align-items: baseline;
    }
    .ag-empty {
      text-align: center; padding: 15px; font-family: var(--ag-mono); font-size: 11px;
      color: var(--ag-ink-dim); border: 1px dashed var(--ag-stroke-hi); border-radius: 9px;
      background: var(--ag-cream);
    }
    @keyframes agSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .ag-spin { animation: agSpin 0.8s linear infinite; }
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
      <div class="ag-seg">
        <button class="swc-tab-btn" data-tab="crypto">${SVG.radar}<span>Radar Sinyal</span></button>
        <button class="swc-tab-btn" data-tab="wifi"><span class="ag-led" id="swc-router-dot"></span>${SVG.gateway}<span>Gateway Wi-Fi</span></button>
      </div>
      <span class="ag-badge-env">${window.location.protocol === "https:" ? "HTTPS:8766" : "HTTP:8765"}</span>
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
        const res = await fetch(base + path, options);
        API_BASE = base;
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Tidak dapat menjangkau server lokal 127.0.0.1:8766");
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
          ? "CERT_REQUIRED: Buka https://127.0.0.1:8766/api/state & izinkan sertifikat lokal"
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
    const needCert = window.location.protocol === "https:" && errMsg.includes("CERT_REQUIRED");
    const statusText = isOnline
      ? `CPE ONLINE • SYNC ${fmtTime(swcData.state.lastScanAt)}`
      : esc(errMsg || "MENGHUBUNGKAN...");

    const devMap = new Map(devs.map(d => [d.mac, d.alias || d.hostname || d.mac]));

    swcPanel.innerHTML = `
      <div class="ag-container">
        ${needCert ? `
          <div class="ag-alert">
            <div>
              <div class="ag-alert-title">Otorisasi Sertifikat HTTPS Lokal Diperlukan</div>
              <div class="ag-alert-sub">Ketuk tombol di samping, pilih Lanjutan → Lanjutkan ke 127.0.0.1, lalu muat ulang.</div>
            </div>
            <a class="swc-btn swc-btn-warn" href="https://127.0.0.1:8766/api/state" target="_blank" rel="noopener">${SVG.ext}<span>Otorisasi 8766</span></a>
          </div>
        ` : ""}

        <div class="ag-glass">
          <div class="ag-hdr">
            <div>
              <div class="ag-overline">${SVG.gateway} GPON ONT GATEWAY • 192.168.1.1</div>
              <h2 class="ag-h1">ZTE F672Y Subscriber Access</h2>
              <div class="ag-status-chip ${isOnline ? "" : "err"}">
                <span class="ag-led ${isOnline ? "on" : ""}"></span>
                <span>${statusText}</span>
              </div>
            </div>
            <button class="swc-btn swc-btn-primary" id="swc-btn-scan">${SVG.scan}<span>Pindai</span></button>
          </div>
          <div class="ag-kpi-grid">
            <div class="ag-kpi" style="--kpi-tint:#10b981">
              <div class="ag-kpi-lbl">ACTIVE</div>
              <div class="ag-kpi-num">${String(onlineCount).padStart(2, "0")}</div>
              <div class="ag-kpi-sub">Client Terhubung</div>
            </div>
            <div class="ag-kpi" style="--kpi-tint:#ef4444">
              <div class="ag-kpi-lbl">ACL DENY</div>
              <div class="ag-kpi-num">${String(blockedCount).padStart(2, "0")}</div>
              <div class="ag-kpi-sub">MAC Diblokir</div>
            </div>
            <div class="ag-kpi" style="--kpi-tint:#f59e0b">
              <div class="ag-kpi-lbl">UNVERIFIED</div>
              <div class="ag-kpi-num">${String(unknownCount).padStart(2, "0")}</div>
              <div class="ag-kpi-sub">Perangkat Asing</div>
            </div>
          </div>
        </div>

        <div class="ag-toolbar">
          <div class="ag-search">
            ${SVG.search}
            <input id="swc-search" placeholder="Cari hostname, alamat IPv4, atau MAC..." value="${esc(searchQuery)}" />
          </div>
          <div class="ag-filter-bar">
            <button class="swc-chip ${filterMode === "all" ? "active" : ""}" data-f="all">Semua <span class="ag-cnt">(${devs.length})</span></button>
            <button class="swc-chip ${filterMode === "online" ? "active" : ""}" data-f="online">Online <span class="ag-cnt">(${onlineCount})</span></button>
            <button class="swc-chip ${filterMode === "blocked" ? "active" : ""}" data-f="blocked">Blokir <span class="ag-cnt">(${blockedCount})</span></button>
            <button class="swc-chip ${filterMode === "unknown" ? "active" : ""}" data-f="unknown">Asing <span class="ag-cnt">(${unknownCount})</span></button>
          </div>
        </div>

        <div class="ag-list">
          ${filtered.length === 0 ? `<div class="ag-empty">TIDAK ADA DATA SUBSCRIBER PADA FILTER INI</div>` : filtered.map(d => {
            const isBlk = d.block_mode === "blocked";
            const isOn = d.status === "online";
            const label = d.alias || d.hostname || "Unnamed Client";
            return `
              <div class="ag-node ${isBlk ? "blocked" : (isOn ? "online" : "")}">
                <div class="ag-node-top">
                  <div style="min-width:0;flex:1">
                    <div class="ag-node-name-row">
                      <span class="ag-node-name">${esc(label)}</span>
                      <span class="ag-pill ${isOn ? "p-on" : "p-off"}">${isOn ? "ONLINE" : "OFFLINE"}</span>
                      ${isBlk ? `<span class="ag-pill p-blk">ACL DENY</span>` : ""}
                      <span class="ag-pill ${d.is_known ? "p-ver" : "p-unv"}">${d.is_known ? "KNOWN" : "UNKNOWN"}</span>
                    </div>
                    <div class="ag-node-meta">
                      <span>${esc(d.ip || "-")}</span>
                      <span>•</span>
                      <span>${esc((d.mac || "").toUpperCase())}</span>
                      <span>•</span>
                      <span>${esc(d.conn_type || "WLAN")}</span>
                    </div>
                  </div>
                  <button class="swc-btn ${isBlk ? "swc-btn-success" : "swc-btn-danger"}" data-act="block" data-mac="${esc(d.mac)}" data-next="${isBlk ? 0 : 1}">
                    ${isBlk ? `${SVG.allow}<span>Pulihkan</span>` : `${SVG.block}<span>Blokir</span>`}
                  </button>
                </div>
                <div class="ag-node-actions">
                  <button class="swc-btn" data-act="rename" data-mac="${esc(d.mac)}" data-alias="${esc(label)}">${SVG.edit}<span>Label</span></button>
                  <button class="swc-btn" data-act="known" data-mac="${esc(d.mac)}" data-known="${d.is_known ? 0 : 1}">
                    ${d.is_known ? `${SVG.flag}<span>Tandai Asing</span>` : `${SVG.verify}<span>Verifikasi</span>`}
                  </button>
                </div>
              </div>
            `;
          }).join("")}
        </div>

        <div class="ag-glass">
          <div class="ag-sec-title">${SVG.clock}<span>Penjadwalan Kebijakan ACL Otomatis</span></div>
          <div class="ag-form">
            <select class="ag-field" id="swc-sch-mac">
              ${devs.map(d => `<option value="${esc(d.mac)}">${esc(d.alias || d.hostname)} (${esc(d.mac)})</option>`).join("")}
            </select>
            <input class="ag-field" type="time" id="swc-sch-start" value="22:00" />
            <input class="ag-field" type="time" id="swc-sch-end" value="06:00" />
            <button class="swc-btn swc-btn-primary" id="swc-btn-add-sch">${SVG.plus}<span>Tambah</span></button>
          </div>
          <div>
            ${schedules.length === 0 ? `<div class="ag-empty" style="margin-top:8px">BELUM ADA JADWAL TERDAFTAR</div>` : schedules.map(s => `
              <div class="ag-item-row">
                <div><strong>${esc(devMap.get(s.mac) || s.mac)}</strong> <span style="font-family:var(--ag-mono);color:var(--ag-orange);margin-left:6px">${esc(s.start_time)} - ${esc(s.end_time)}</span></div>
                <button class="swc-btn swc-btn-danger" style="padding:3px 7px" data-del-sch="${s.id}">${SVG.trash}</button>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="ag-glass">
          <div class="ag-sec-title">${SVG.log}<span>Log Audit Sistem</span></div>
          <div>
            ${logs.length === 0 ? `<div class="ag-empty">BELUM ADA LOG AKTIVITAS</div>` : logs.slice(0, 12).map(l => `
              <div class="ag-log-line">
                <span style="color:var(--ag-ink-dim)">${fmtTime(l.created_at)}</span>
                <span style="color:var(--ag-orange);font-weight:700">[${esc(l.event_type)}]</span>
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
