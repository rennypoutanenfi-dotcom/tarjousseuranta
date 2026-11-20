// Kokoaa Apps Script -tiedoston: node mm/build.js -> mm/apps-script/Myyntimonopoli.gs
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const parts = ["engine.js", "adapter.js", "server.js", "gas.js"].map((f) => "// ===== " + f + " =====\n" + fs.readFileSync(path.join(dir, f), "utf8"));
const head = "// Myyntimonopoli – Apps Script -palvelinosa. Koottu tiedostoista mm/engine.js, mm/adapter.js, mm/server.js ja mm/gas.js.\n" +
  "// Älä muokkaa tätä tiedostoa käsin: muokkaa lähdetiedostoja ja aja `node mm/build.js`.\n" +
  "// Asennus: MYYNTIMONOPOLI.md, kohta \"Palvelinosan asennus\".\n\n";
fs.mkdirSync(path.join(dir, "apps-script"), { recursive: true });
fs.writeFileSync(path.join(dir, "apps-script", "Myyntimonopoli.gs"), head + parts.join("\n"));
console.log("mm/apps-script/Myyntimonopoli.gs", fs.statSync(path.join(dir, "apps-script", "Myyntimonopoli.gs")).size, "tavua");
