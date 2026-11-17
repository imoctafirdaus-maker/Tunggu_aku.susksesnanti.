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

  _assertXmlOk(xml, context = "Router") {
    const mErr = String(xml || "").match(/<IF_ERRORSTR>([^<]+)<\/IF_ERRORSTR>/);
    if (mErr && mErr[1].trim() !== "SUCC") {
      throw new Error(`${context}: ${mErr[1].trim()}`);
    }
    if (String(xml || "").includes("Frm_Username")) {
      throw new Error(`${context}: SessionTimeout`);
    }
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
      signal: AbortSignal.timeout(9000)
    });
    this._upCk(res);
    const txt = await res.text();
    const mTok = txt.match(/_sessionTmpToken\s*=\s*"([^"]+)"/);
    if (mTok) {
      this.tok = mTok[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    return txt;
  }

  async _runSingleSession(fn) {
    this.ck = {};
    this.tok = "";
    try {
      await this._req("/", null, { ajax: false });
      const initJson = JSON.parse(await this._req("/?_type=loginData&_tag=login_entry"));
      if (initJson.lockingTime && Number(initJson.lockingTime) > 0) {
        throw new Error(`Router terkunci sementara (${initJson.lockingTime} detik)`);
      }
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
      if (dash.includes("Frm_Username")) {
        throw new Error("SessionTimeout saat memuat dashboard router");
      }
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
  }

  async _withSession(fn) {
    const runWithRetry = async () => {
      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await this._runSingleSession(fn);
        } catch (err) {
          lastErr = err;
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 900 * attempt));
          }
        }
      }
      throw lastErr;
    };
    const next = this.lock.then(runWithRetry, runWithRetry);
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
      this._assertXmlOk(xml, "getConnectedDevices");
      const raw = this._parseInstances(xml);
      return raw.map(d => ({
        mac: (d._LuQUID_MACAddress || "").toLowerCase(),
        ip: d._LuQUID_IPAddress || "-",
        hostname: d._LuQUID_HostName || "Perangkat Tanpa Nama",
        connType: d._LuQUID_InterfaceType || d._LuQUID_AccessType || "WLAN"
      })).filter(d => d.mac);
    });
  }

  async syncBlockedMacs(blockedMacs = []) {
    const targetSet = new Set(
      (blockedMacs || []).map(m => String(m || "").trim().toLowerCase()).filter(Boolean)
    );
    const targetAPs = ["DEV.WIFI.AP1", "DEV.WIFI.AP5"];

    return this._withSession(async () => {
      await this._req("/?_type=menuView&_tag=wlanAdvanced&Menu3Location=0");

      // 1. Baca rule MAC filter saat ini
      const ruleXml = await this._req(
        `/?_type=menuData&_tag=wlan_macfilterrule_lua.lua&_sessionTOKEN=${encodeURIComponent(this.tok)}`,
        null,
        { signStr: `_sessionTOKEN=${this.tok}` }
      );
      this._assertXmlOk(ruleXml, "Baca MAC Rule");
      const existingRules = this._parseInstances(ruleXml);

      // 2. Hapus rule lama milik SWC
      for (const r of existingRules) {
        const name = r.Name || "";
        if (r._InstID && (name.startsWith("SWC_") || name === "TestSWC")) {
          const delBody = [
            "IF_ACTION=Delete",
            `_InstID=${encodeURIComponent(r._InstID)}`,
            `_sessionTOKEN=${this.tok}`
          ].join("&");
          const delRes = await this._req("/?_type=menuData&_tag=wlan_macfilterrule_lua.lua", delBody, { signStr: delBody });
          this._assertXmlOk(delRes, "Hapus MAC Rule");
        }
      }

      // 3. Tambahkan setiap MAC yang diblokir ke AP 2.4GHz (AP1) & 5GHz (AP5)
      let idx = 1;
      for (const mac of targetSet) {
        for (const ap of targetAPs) {
          const ruleName = `SWC_${idx}_${mac.replace(/:/g, "").slice(-6)}`;
          const parts = mac.split(":");
          const addBody = [
            "IF_ACTION=Apply",
            "_InstID=-1",
            `MACAddress=${encodeURIComponent(mac)}`,
            `Name=${encodeURIComponent(ruleName)}`,
            `Interface=${encodeURIComponent(ap)}`,
            ...parts.map((p, i) => `sub_MACAddress${i}=${encodeURIComponent(p)}`),
            `_sessionTOKEN=${this.tok}`
          ].join("&");
          const addRes = await this._req("/?_type=menuData&_tag=wlan_macfilterrule_lua.lua", addBody, { signStr: addBody });
          this._assertXmlOk(addRes, `Tambah MAC Rule (${mac})`);
        }
        idx++;
      }

      // 4. Atur ACLPolicy ke "Ban" atau "Disabled"
      const desiredPolicy = targetSet.size > 0 ? "Ban" : "Disabled";
      const polXml = await this._req(
        `/?_type=menuData&_tag=wlan_macfilteraclpolicy_lua.lua&_sessionTOKEN=${encodeURIComponent(this.tok)}`,
        null,
        { signStr: `_sessionTOKEN=${this.tok}` }
      );
      this._assertXmlOk(polXml, "Baca ACLPolicy");
      const apInstances = this._parseInstances(polXml).filter(inst =>
        (inst._InstID || "").startsWith("DEV.WIFI.AP")
      );

      if (apInstances.length > 0) {
        const multiParams = ["IF_ACTION=Apply", `_InstNum=${apInstances.length}`];
        apInstances.forEach((inst, i) => {
          const id = inst._InstID;
          const pol = targetAPs.includes(id) ? desiredPolicy : (inst.ACLPolicy || "Disabled");
          multiParams.push(`_InstID_${i}=${encodeURIComponent(id)}`);
          multiParams.push(`ACLPolicy_${i}=${pol}`);
        });
        multiParams.push(`_sessionTOKEN=${this.tok}`);
        const multiBody = multiParams.join("&");
        const polApplyRes = await this._req("/?_type=menuData&_tag=wlan_macfilteraclpolicy_lua.lua", multiBody, { signStr: multiBody });
        this._assertXmlOk(polApplyRes, "Terapkan ACLPolicy");
      }

      // 5. Verifikasi baca-ulang aturan dari router untuk memastikan benar-benar tersimpan
      const verifyRuleXml = await this._req(
        `/?_type=menuData&_tag=wlan_macfilterrule_lua.lua&_sessionTOKEN=${encodeURIComponent(this.tok)}`,
        null,
        { signStr: `_sessionTOKEN=${this.tok}` }
      );
      this._assertXmlOk(verifyRuleXml, "Verifikasi MAC Rule");
      const savedMacs = new Set(
        this._parseInstances(verifyRuleXml).map(r => (r.MACAddress || "").toLowerCase())
      );
      for (const mac of targetSet) {
        if (!savedMacs.has(mac)) {
          throw new Error(`Verifikasi gagal: MAC ${mac} belum masuk ke tabel ACL router`);
        }
      }

      return { synced: targetSet.size, policy: desiredPolicy };
    });
  }
}

module.exports = { ZteF672YDriver };
