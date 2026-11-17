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

  const style = document.createElement("style");
  style.id = "swc-injected-style";
  style.textContent = `
    body { padding-top: 50px !important; }
    #swc-top-switcher {
      position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 48px !important; z-index: 999999 !important;
      background: rgba(11, 15, 25, 0.96) !important; backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      display: flex !important; align-items: center !important; justify-content: space-between !important;
      padding: 0 14px !important; font-family: system-ui, -apple-system, sans-serif !important; box-sizing: border-box;
    }
    .swc-tabs { display: flex !important; gap: 6px; background: rgba(30, 41, 59, 0.9); padding: 4px; border-radius: 10px; }
    .swc-tab-btn {
      border: none; background: transparent; color: #94a3b8; font-size: 12px; font-weight: 700;
      padding: 6px 12px; border-radius: 7px; cursor: pointer; transition: all .2s;
      display: flex; align-items: center; gap: 6px;
    }
    .swc-tab-btn.active { background: #2563eb !important; color: #fff !important; box-shadow: 0 2px 8px rgba(37, 99, 235, 0.5); }
    .swc-badge-dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; display: inline-block; }
    .swc-badge-dot.online { background: #10b981; box-shadow: 0 0 8px #10b981; }
    .swc-swipe-hint { font-size: 11px; color: #64748b; user-select: none; }

    #swc-panel {
      display: none; min-height: calc(100vh - 48px);
      background: #0b0f19; color: #f1f5f9; padding: 14px 14px 80px;
      font-family: system-ui, -apple-system, sans-serif; box-sizing: border-box;
    }
    #swc-panel.active { display: block !important; }
    .swc-wrap { max-width: 720px; margin: 0 auto; }
    .swc-hero {
      background: linear-gradient(135deg, #111827 0%, #1e293b 100%);
      border: 1px solid rgba(148, 163, 184, 0.16); border-radius: 14px;
      padding: 14px; margin-bottom: 12px;
    }
    .swc-hero-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .swc-title { font-size: 16px; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 8px; color: #fff; }
    .swc-sub { font-size: 12px; color: #94a3b8; margin-top: 4px; }
    .swc-btn {
      border: 1px solid rgba(148, 163, 184, 0.25); background: #1e293b; color: #f8fafc;
      padding: 7px 12px; border-radius: 9px; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .swc-btn:active { transform: scale(0.97); }
    .swc-btn-primary { background: #2563eb; border-color: #3b82f6; }
    .swc-btn-danger { background: rgba(220, 38, 38, 0.18); border-color: rgba(239, 68, 68, 0.45); color: #fca5a5; }
    .swc-btn-success { background: rgba(16, 185, 129, 0.18); border-color: rgba(16, 185, 129, 0.45); color: #6ee7b7; }

    .swc-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; }
    .swc-stat-box { background: rgba(15, 23, 42, 0.7); border-radius: 10px; padding: 10px; text-align: center; }
    .swc-stat-num { font-size: 18px; font-weight: 800; }
    .swc-stat-lbl { font-size: 11px; color: #94a3b8; margin-top: 2px; }

    .swc-toolbar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .swc-input {
      flex: 1; min-width: 160px; background: #111827; border: 1px solid rgba(148, 163, 184, 0.22);
      color: #f8fafc; padding: 8px 12px; border-radius: 9px; font-size: 13px; outline: none;
    }
    .swc-chips { display: flex; gap: 6px; }
    .swc-chip {
      padding: 6px 10px; border-radius: 8px; font-size: 12px; font-weight: 600;
      background: #111827; border: 1px solid rgba(148, 163, 184, 0.2); color: #94a3b8; cursor: pointer;
    }
    .swc-chip.active { background: #1d4ed8; color: #fff; border-color: #3b82f6; }

    .swc-card {
      background: #111827; border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 12px; padding: 12px; margin-bottom: 10px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .swc-card.blocked { border-color: rgba(239, 68, 68, 0.45); background: rgba(127, 29, 29, 0.14); }
    .swc-card-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .swc-dev-name { font-size: 14px; font-weight: 700; color: #f8fafc; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .swc-tag { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px; text-transform: uppercase; }
    .swc-tag-on { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .swc-tag-off { background: rgba(100, 116, 139, 0.25); color: #94a3b8; }
    .swc-tag-blk { background: rgba(239, 68, 68, 0.25); color: #f87171; }
    .swc-tag-known { background: rgba(59, 130, 246, 0.22); color: #93c5fd; }
    .swc-meta { font-size: 12px; color: #94a3b8; font-family: ui-monospace, monospace; }
    .swc-actions { display: flex; gap: 6px; flex-wrap: wrap; }

    .swc-sec-title { font-size: 13px; font-weight: 700; color: #cbd5e1; margin: 16px 0 8px; }
    .swc-sched-form { display: flex; gap: 6px; flex-wrap: wrap; background: #111827; padding: 10px; border-radius: 12px; border: 1px solid rgba(148,163,184,.15); }
    .swc-select, .swc-time {
      background: #0f172a; border: 1px solid rgba(148, 163, 184, 0.25);
      color: #f8fafc; padding: 7px 9px; border-radius: 8px; font-size: 12px;
    }
    .swc-log-item { font-size: 12px; color: #cbd5e1; padding: 7px 10px; border-bottom: 1px solid rgba(148, 163, 184, 0.1); display: flex; justify-content: space-between; gap: 8px; }
    .swc-log-time { color: #64748b; font-size: 11px; white-space: nowrap; }
  `;
  document.head.appendChild(style);

  function initSwcUI() {
    if (document.getElementById("swc-top-switcher")) return;

    const switcher = document.createElement("div");
    switcher.id = "swc-top-switcher";
    switcher.innerHTML = `
      <div class="swc-tabs">
        <button class="swc-tab-btn active" data-tab="crypto">📈 Radar Sinyal</button>
        <button class="swc-tab-btn" data-tab="wifi"><span class="swc-badge-dot" id="swc-router-dot"></span> Smart Wi-Fi</button>
      </div>
      <span class="swc-swipe-hint">⇄ Geser layar</span>
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
    const r = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Permintaan gagal");
    swcData = { state: j.state, devices: j.devices, logs: j.logs, schedules: j.schedules };
    renderSwc();
  }

  async function pollStateOnce() {
    try {
      const r = await fetch(API_BASE + "/api/state");
      if (r.ok) {
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

  function renderSwc() {
    const dot = document.getElementById("swc-router-dot");
    if (dot) dot.classList.toggle("online", !!swcData.state?.routerOnline);
    if (currentTab !== "wifi") return;

    const swcPanel = document.getElementById("swc-panel");
    if (!swcPanel) return;

    const devs = swcData.devices || [];
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

    swcPanel.innerHTML = `
      <div class="swc-wrap">
        <div class="swc-hero">
          <div class="swc-hero-top">
            <div>
              <h2 class="swc-title">🛡️ Smart Wi-Fi Control</h2>
              <div class="swc-sub">ZTE F672Y • ${swcData.state?.routerOnline ? "Terhubung (Scan: " + fmtTime(swcData.state.lastScanAt) + ")" : esc(swcData.state?.lastError || "Menghubungkan...")}</div>
            </div>
            <button class="swc-btn swc-btn-primary" id="swc-btn-scan">🔄 Pindai</button>
          </div>
          <div class="swc-stats">
            <div class="swc-stat-box"><div class="swc-stat-num" style="color:#34d399">${onlineCount}</div><div class="swc-stat-lbl">Online</div></div>
            <div class="swc-stat-box"><div class="swc-stat-num" style="color:#f87171">${blockedCount}</div><div class="swc-stat-lbl">Diblokir</div></div>
            <div class="swc-stat-box"><div class="swc-stat-num" style="color:#fbbf24">${unknownCount}</div><div class="swc-stat-lbl">Belum Dikenal</div></div>
          </div>
        </div>

        <div class="swc-toolbar">
          <input class="swc-input" id="swc-search" placeholder="Cari nama, IP, atau MAC..." value="${esc(searchQuery)}" />
          <div class="swc-chips">
            <button class="swc-chip ${filterMode === "all" ? "active" : ""}" data-f="all">Semua (${devs.length})</button>
            <button class="swc-chip ${filterMode === "online" ? "active" : ""}" data-f="online">Online</button>
            <button class="swc-chip ${filterMode === "blocked" ? "active" : ""}" data-f="blocked">Blokir</button>
            <button class="swc-chip ${filterMode === "unknown" ? "active" : ""}" data-f="unknown">Asing</button>
          </div>
        </div>

        <div id="swc-dev-list">
          ${filtered.length === 0 ? `<div class="swc-card"><div class="swc-sub">Tidak ada perangkat yang cocok.</div></div>` : filtered.map(d => {
            const isBlk = d.block_mode === "blocked";
            const isOn = d.status === "online";
            return `
              <div class="swc-card ${isBlk ? "blocked" : ""}">
                <div class="swc-card-row">
                  <div>
                    <div class="swc-dev-name">
                      ${esc(d.alias || d.hostname)}
                      <span class="swc-tag ${isOn ? "swc-tag-on" : "swc-tag-off"}">${isOn ? "ONLINE" : "OFFLINE"}</span>
                      ${isBlk ? `<span class="swc-tag swc-tag-blk">DIBLOKIR</span>` : ""}
                      ${d.is_known ? `<span class="swc-tag swc-tag-known">DIKENAL</span>` : ""}
                    </div>
                    <div class="swc-meta" style="margin-top:4px">${esc(d.ip)} • ${esc(d.mac)} • ${esc(d.conn_type)}</div>
                  </div>
                  <button class="swc-btn ${isBlk ? "swc-btn-success" : "swc-btn-danger"}" data-act="block" data-mac="${esc(d.mac)}" data-next="${isBlk ? 0 : 1}">
                    ${isBlk ? "✅ Buka" : "🚫 Blokir"}
                  </button>
                </div>
                <div class="swc-actions">
                  <button class="swc-btn" data-act="rename" data-mac="${esc(d.mac)}" data-alias="${esc(d.alias || d.hostname)}">✏️ Label</button>
                  <button class="swc-btn" data-act="known" data-mac="${esc(d.mac)}" data-known="${d.is_known ? 0 : 1}">
                    ${d.is_known ? "⭐ Tandai Asing" : "🛡️ Tandai Dikenal"}
                  </button>
                </div>
              </div>
            `;
          }).join("")}
        </div>

        <div class="swc-sec-title">⏰ Jadwal Blokir Otomatis</div>
        <div class="swc-sched-form">
          <select class="swc-select" id="swc-sch-mac" style="flex:1;min-width:140px">
            ${devs.map(d => `<option value="${esc(d.mac)}">${esc(d.alias || d.hostname)} (${esc(d.mac)})</option>`).join("")}
          </select>
          <input type="time" class="swc-time" id="swc-sch-start" value="22:00" />
          <input type="time" class="swc-time" id="swc-sch-end" value="06:00" />
          <button class="swc-btn swc-btn-primary" id="swc-sch-add">+ Jadwal</button>
        </div>
        <div style="margin-top:8px">
          ${(swcData.schedules || []).map(s => {
            const dev = devs.find(x => x.mac === s.mac);
            return `
              <div class="swc-card" style="padding:9px 12px;flex-direction:row;align-items:center;justify-content:space-between">
                <div>
                  <div style="font-size:13px;font-weight:700">${esc(dev ? (dev.alias || dev.hostname) : s.mac)}</div>
                  <div class="swc-meta">Blokir otomatis: ${esc(s.start_time)} – ${esc(s.end_time)}</div>
                </div>
                <button class="swc-btn swc-btn-danger" data-del-sch="${s.id}">Hapus</button>
              </div>
            `;
          }).join("")}
        </div>

        <div class="swc-sec-title">📜 Log Aktivitas Terbaru</div>
        <div class="swc-card" style="padding:4px 0;gap:0">
          ${(swcData.logs || []).slice(0, 12).map(l => `
            <div class="swc-log-item">
              <span>${esc(l.detail)}</span>
              <span class="swc-log-time">${fmtTime(l.created_at)}</span>
            </div>
          `).join("") || `<div class="swc-log-item"><span>Belum ada log aktivitas.</span></div>`}
        </div>
      </div>
    `;

    document.getElementById("swc-btn-scan")?.addEventListener("click", async e => {
      e.target.textContent = "⏳ Memindai...";
      try { await apiPost("/api/scan"); } catch (err) { alert(err.message); }
    });

    const sInput = document.getElementById("swc-search");
    if (sInput) {
      sInput.addEventListener("input", e => {
        searchQuery = e.target.value;
        renderSwc();
        const el = document.getElementById("swc-search");
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      });
    }

    swcPanel.querySelectorAll(".swc-chip").forEach(c => {
      c.addEventListener("click", () => { filterMode = c.dataset.f; renderSwc(); });
    });

    swcPanel.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const act = btn.dataset.act, mac = btn.dataset.mac;
        try {
          if (act === "block") {
            btn.disabled = true;
            btn.textContent = "⏳...";
            await apiPost("/api/device/block", { mac, block: btn.dataset.next === "1" });
          } else if (act === "rename") {
            const val = prompt("Masukkan nama label perangkat:", btn.dataset.alias || "");
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

    document.getElementById("swc-sch-add")?.addEventListener("click", async () => {
      const mac = document.getElementById("swc-sch-mac")?.value;
      const start_time = document.getElementById("swc-sch-start")?.value;
      const end_time = document.getElementById("swc-sch-end")?.value;
      if (!mac || !start_time || !end_time) return;
      try { await apiPost("/api/schedule", { mac, start_time, end_time }); } catch (err) { alert(err.message); }
    });

    swcPanel.querySelectorAll("[data-del-sch]").forEach(btn => {
      btn.addEventListener("click", async () => {
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { initSwcUI(); connectStream(); });
  } else {
    initSwcUI();
    connectStream();
  }
})();
