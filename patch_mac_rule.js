const fs = require("fs");
const { ZteF672YDriver } = require("./swc/zteDriver");

(async () => {
  const drv = new ZteF672YDriver();
  let ok = false;

  await drv._withSession(async () => {
    await drv._req("/?_type=menuView&_tag=wlanAdvanced&Menu3Location=0");
    const mac = "aa:58:5c:ef:ee:a9";
    const parts = mac.split(":");
    const addBody = [
      "IF_ACTION=Apply",
      "_InstID=-1",
      `MACAddress=${encodeURIComponent(mac)}`,
      `Name=${encodeURIComponent("SWC_1_efeea9")}`,
      `Interface=${encodeURIComponent("DEV.WIFI.AP1")}`,
      ...parts.map((p, i) => `sub_MACAddress${i}=${encodeURIComponent(p)}`),
      `_sessionTOKEN=${drv.tok}`
    ].join("&");

    const res = await drv._req("/?_type=menuData&_tag=wlan_macfilterrule_lua.lua", addBody, { signStr: addBody });
    console.log("1. Respons POST IF_ACTION=Apply:");
    console.log(res.replace(/\r/g, "").trim());
    if (res.includes("<Instance>") || res.includes("DEV.WIFI.AP1")) ok = true;
  });

  if (!ok) {
    console.log("[!] Format Apply belum mengembalikan Instance, periksa respons di atas.");
    process.exit(1);
  }

  // Perbarui swc/zteDriver.js dengan format IF_ACTION=Apply + sub_MACAddress0..5
  const file = "swc/zteDriver.js";
  let code = fs.readFileSync(file, "utf8");
  const oldBlock = `          const addBody = [
            "IF_ACTION=New",
            "_InstID=-1",
            \`Name=\${encodeURIComponent(ruleName)}\`,
            \`Interface=\${encodeURIComponent(ap)}\`,
            \`MACAddress=\${encodeURIComponent(mac)}\`,
            \`_sessionTOKEN=\${this.tok}\`
          ].join("&");`;

  const newBlock = `          const parts = mac.split(":");
          const addBody = [
            "IF_ACTION=Apply",
            "_InstID=-1",
            \`MACAddress=\${encodeURIComponent(mac)}\`,
            \`Name=\${encodeURIComponent(ruleName)}\`,
            \`Interface=\${encodeURIComponent(ap)}\`,
            ...parts.map((p, i) => \`sub_MACAddress\${i}=\${encodeURIComponent(p)}\`),
            \`_sessionTOKEN=\${this.tok}\`
          ].join("&");`;

  if (!code.includes(oldBlock)) {
    throw new Error("Blok kode lama tidak ditemukan di swc/zteDriver.js");
  }
  code = code.replace(oldBlock, newBlock);
  fs.writeFileSync(file, code, "utf8");
  console.log("\n[OK] swc/zteDriver.js berhasil diperbarui dengan IF_ACTION=Apply & sub_MACAddress0..5.");
})();
