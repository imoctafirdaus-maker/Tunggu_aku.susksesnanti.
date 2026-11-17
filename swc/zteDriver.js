"use strict";
const crypto = require("crypto");

class ZteF672YDriver {
  constructor(opts = {}) {
    this.base = opts.base || process.env.ZTE_URL || "http://192.168.1.1";
    this.user = opts.user || process.env.ZTE_USER || "admin";
    this.pass = opts.pass || process.env.ZTE_PASS || "Web@0063";
    this.ck = {};
    this.pubKey = "";
    this.tok = "";
    this.lock = Promise.resolve();
  }

  _upCk(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.ck[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }

  _signCheck(payloadStr) {
    if (!this.pubKey) return "";
    const digest = crypto.createHash("sha256").update(payloadStr).digest("hex");
    return crypto.publicEncrypt(
      { key: this.pubKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(digest)
    ).toString("base64");
  }

  async _req(path, body = null, { ajax = true, signStr = null } = {}) {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Linux; Android 17)",
      "Referer": this.base + "/"
    };
    if (ajax) headers["X-Requested-With"] = "XMLHttpRequest";
    const cookieStr = Object.entries(this.ck).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookieStr) headers["Cookie"] = cookieStr;
    if (body !== null) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    if (signStr !== null && this.pubKey) headers["Check"] = this._signCheck(signStr);

    const res = await fetch(this.base + path, {
      method: body !== null ? "POST" : "GET",
      headers,
      body,
      signal: AbortSignal.timeout(8000)
    });
    this._upCk(res);
    return res.text();
  }

  async _withSession(fn) {
    const run = async () => {
      this.ck = {};
      this.tok = "";
      try {
        await this._req("/", null, { ajax: false });
        const initJson = JSON.parse(await this._req("/?_type=loginData&_tag=login_entry"));
        const saltXml = await this._req("/?_type=loginData&_tag=login_token");
        const mSalt = saltXml.match(/>([^<]+)</);
        if (!mSalt) throw new Error("Gagal membaca login_token router");
        const shaPass = crypto.createHash("sha256").update(this.pass + mSalt[1].trim()).digest("hex");

        const loginRes = JSON.parse(await this._req(
          "/?_type=loginData&_tag=login_entry",
          `action=login&Password=${shaPass}&Username=${encodeURIComponent(this.user)}&_sessionTOKEN=${encodeURIComponent(initJson.sess_token)}`
        ));
        if (!loginRes.login_need_refresh) {
          throw new Error(loginRes.loginErrMsg || "Login router ditolak");
        }

        const dash = await this._req("/", null, { ajax: false });
        const mTok = dash.match(/_sessionTmpToken\s*=\s*"([^"]+)"/);
        this.tok = mTok
          ? mTok[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          : loginRes.sess_token;
        const mPk = dash.match(/(-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----)/);
        if (mPk) this.pubKey = mPk[1].replace(/\\n/g, "\n");

        return await fn();
      } finally {
        if (this.tok) {
          await this._req(
            "/?_type=loginData&_tag=logout_entry",
            `IF_LogOff=1&_sessionTOKEN=${encodeURIComponent(this.tok)}`
          ).catch(() => {});
          this.tok = "";
        }
      }
    };
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => {});
    return next;
  }

  _parseInstances(xml) {
    const list = [];
    const instMatches = xml.matchAll(/<Instance>([\s\S]*?)<\/Instance>/g);
    for (const m of instMatches) {
      const obj = {};
      const pairs = m[1].matchAll(/<ParaName>([^<]+)<\/ParaName>\s*<ParaValue>([^<]*)<\/ParaValue>/g);
      for (const p of pairs) obj[p[1].trim()] = p[2].trim();
      if (Object.keys(obj).length) list.push(obj);
    }
    return list;
  }

  async getConnectedDevices() {
    return this._withSession(async () => {
      const xml = await this._req(`/?_type=hiddenData&_tag=accessdev_data&DeveiceType=ALL&_=${Date.now()}`);
      const raw = this._parseInstances(xml);
      return raw.map(d => ({
        mac: (d._LuQUID_MACAddress || "").toLowerCase(),
        ip: d._LuQUID_IPAddress || "-",
        hostname: d._LuQUID_HostName || "Perangkat Tanpa Nama",
        connType: d._LuQUID_InterfaceType || d._LuQUID_AccessType || "WLAN"
      })).filter(d => d.mac);
    });
  }

  async syncBlockedMacs(blockedMacs) {
    const targetSet = new Set(blockedMacs.map(m => m.toLowerCase()));
    return this._withSession(async () => {
      // Aktifkan konteks menu filterCriteria agar sesi Lua mengizinkan akses data
      await this._req("/?_type=menuView&_tag=filterCriteria&Menu3Location=0");
      const getQs = `_sessionTOKEN=${this.tok}`;
      const xml = await this._req(
        `/?_type=menuData&_tag=firewall_macfilterv3_lua.lua&_sessionTOKEN=${encodeURIComponent(this.tok)}`,
        null,
        { signStr: getQs }
      );

      if (xml.includes("SessionTimeout")) {
        throw new Error("SessionTimeout pada firewall_macfilterv3_lua.lua");
      }

      const existing = this._parseInstances(xml);
      // Hapus rule yang sudah tidak ada di daftar blokir
      for (const inst of existing) {
        const mac = (inst.SrcMacAddr || inst.MACAddress || "").toLowerCase();
        const instId = inst._InstID || inst.InstID || "";
        if (mac && !targetSet.has(mac) && instId) {
          const delBody = `IF_ACTION=Delete&IF_INSTNUM=1&_InstID=${encodeURIComponent(instId)}&_sessionTOKEN=${encodeURIComponent(this.tok)}`;
          await this._req("/?_type=menuData&_tag=firewall_macfilterv3_lua.lua", delBody, { signStr: delBody });
        }
      }

      // Tambahkan MAC baru ke daftar blokir router
      const existingMacs = new Set(existing.map(x => (x.SrcMacAddr || x.MACAddress || "").toLowerCase()));
      for (const mac of targetSet) {
        if (!existingMacs.has(mac)) {
          const addBody = [
            "IF_ACTION=Apply",
            "IF_INSTNUM=1",
            "_InstID=-1",
            "Enable=1",
            `Name=SWC_${mac.replace(/:/g, "")}`,
            `SrcMacAddr=${encodeURIComponent(mac)}`,
            "DstMacAddr=",
            "Protocol=ALL",
            "Target=Drop",
            `_sessionTOKEN=${encodeURIComponent(this.tok)}`
          ].join("&");
          await this._req("/?_type=menuData&_tag=firewall_macfilterv3_lua.lua", addBody, { signStr: addBody });
        }
      }
      return { synced: targetSet.size };
    });
  }
}

module.exports = { ZteF672YDriver };
