// Apps Script -tiedosto (mm/apps-script/Myyntimonopoli.gs) ajetaan Node-virtuaalikoneessa
// Apps Scriptin palveluja jäljittelevillä malleilla. Mallinnettu tarjousseurannan tausta (doPost)
// käyttää samaa Sellers-välilehden rakennetta kuin tekninen kuvaus.
// HUOM: tämä ei ole aito Apps Script -ympäristö; se varmistaa koodin toiminnan malleja vastaan.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("child_process").execFileSync(process.execPath, [path.join(__dirname, "..", "build.js")]);
const GS = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Myyntimonopoli.gs"), "utf8");

function makeSheets() {
  const sheets = {};
  function conv(v) {
    if (typeof v !== "string") return v;
    if (v.length > 50000) throw new Error("Your input contains more than the maximum of 50000 characters in a single cell.");
    if (v.charAt(0) === "'") return v.slice(1);
    if (v.charAt(0) === "=") return "#ERROR!";                // kaava
    if (/^-?\d+(\.\d+)?$/.test(v)) return +v;                 // automaattinen lukumuunnos
    if (v === "TRUE" || v === "FALSE") return v === "TRUE";
    return v;
  }
  function Sheet(name) {
    this.name = name; this.d = []; this.maxR = 1000; this.maxC = 26;
  }
  Sheet.prototype.getLastRow = function () { for (let r = this.d.length - 1; r >= 0; r--) if (this.d[r] && this.d[r].some((x) => x !== "" && x != null)) return r + 1; return 0; };
  Sheet.prototype.getLastColumn = function () { let m = 0; this.d.forEach((row) => { if (row) for (let c = row.length - 1; c >= 0; c--) if (row[c] !== "" && row[c] != null) { m = Math.max(m, c + 1); break; } }); return m; };
  Sheet.prototype.getMaxRows = function () { return this.maxR; };
  Sheet.prototype.getMaxColumns = function () { return this.maxC; };
  Sheet.prototype.insertRowsAfter = function (a, n) { this.maxR += n; };
  Sheet.prototype.insertColumnsAfter = function (a, n) { this.maxC += n; };
  Sheet.prototype.getRange = function (r, c, nr, nc) {
    nr = nr || 1; nc = nc || 1;
    if (r < 1 || c < 1 || r + nr - 1 > this.maxR || c + nc - 1 > this.maxC) throw new Error("Range out of bounds " + [r, c, nr, nc]);
    const sh = this;
    return {
      getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = sh.d[r - 1 + i] && sh.d[r - 1 + i][c - 1 + j]; row.push(v === undefined || v === null ? "" : v); } out.push(row); } return out; },
      getValue() { return this.getValues()[0][0]; },
      setValues(vals) {
        if (vals.length !== nr || vals.some((x) => x.length !== nc)) throw new Error("dimension mismatch");
        for (let i = 0; i < nr; i++) { sh.d[r - 1 + i] = sh.d[r - 1 + i] || []; for (let j = 0; j < nc; j++) sh.d[r - 1 + i][c - 1 + j] = conv(vals[i][j]); }
        return this;
      },
      setValue(v) { return this.setValues([[v]]); }
    };
  };
  Sheet.prototype.getDataRange = function () { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); };
  Sheet.prototype.appendRow = function (arr) { const r = this.getLastRow() + 1; if (r > this.maxR) this.maxR = r; if (arr.length > this.maxC) this.maxC = arr.length; this.getRange(r, 1, 1, arr.length).setValues([arr]); };
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new Sheet(n))
  };
  return { ss, sheets };
}

function context(sheetsObj, opts) {
  opts = opts || {};
  const triggers = [];
  const props = {};
  const ctx = {
    console, JSON, Math, Date, Object, Array, String, Number, Error, parseInt, isNaN, Infinity,
    SpreadsheetApp: { getActiveSpreadsheet: () => sheetsObj.ss, openById: () => sheetsObj.ss },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" },
      computeDigest: (alg, s) => Array.from(crypto.createHash("sha256").update(s, "utf8").digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString("base64"),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString("base64url")
    },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyHours: (h) => ({ create: () => { const t = { fn, h, getHandlerFunction: () => fn }; triggers.push(t); return t; } }) }) })
    }
  };
  vm.createContext(ctx);
  if (!opts.noLegacy) vm.runInContext(LEGACY, ctx, { filename: "Koodi.gs" });
  vm.runInContext(GS, ctx, { filename: "Myyntimonopoli.gs" });
  ctx.__triggers = triggers;
  return ctx;
}

// Mallinnettu nykyinen tarjousseurannan tausta: register, login, saveMonths (kuukausikentät yhdistetään), leaderboard.
const LEGACY = `
function sha_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(function (b) { var h = (b & 255).toString(16); return h.length === 1 ? "0" + h : h; }).join(""); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sellers_() { var ss = SpreadsheetApp.getActiveSpreadsheet(); var sh = ss.getSheetByName("Sellers"); if (!sh) { sh = ss.insertSheet("Sellers"); sh.getRange(1, 1, 1, 6).setValues([["nickname_key", "nickname", "company", "pin_hash", "months_json", "updated_at"]]); } return sh; }
function find_(key) { var sh = sellers_(), v = sh.getDataRange().getValues(); for (var i = 1; i < v.length; i++) if (v[i][0] === key) return { row: i + 1, v: v[i] }; return null; }
function doPost(e) {
  var mm = mmRoute(e); if (mm) return mm;
  var b = JSON.parse(e.postData.contents), key = String(b.nickname || "").trim().toLowerCase(), sh = sellers_();
  if (b.action === "register") { if (find_(key)) return out_({ ok: false, error: "taken" }); sh.appendRow([key, b.nickname, b.company, sha_(String(b.pin)), "{}", new Date().toISOString()]); return out_({ ok: true }); }
  if (b.action === "leaderboard") { var v = sh.getDataRange().getValues().slice(1); return out_({ ok: true, sellers: v.map(function (r) { return { nickname: r[1], company: r[2], months: JSON.parse(r[4] || "{}") }; }) }); }
  var f = find_(key);
  if (!f) return out_({ ok: false, error: "not_found" });
  if (f.v[3] !== sha_(String(b.pin))) return out_({ ok: false, error: "bad_pin" });
  var months = JSON.parse(f.v[4] || "{}");
  if (b.action === "login") return out_({ ok: true, profile: { nickname: f.v[1], company: f.v[2], months: months } });
  if (b.action === "saveMonths") {
    Object.keys(b.months).forEach(function (mk) { months[mk] = Object.assign({}, months[mk] || {}, b.months[mk]); });
    sh.getRange(f.row, 5, 1, 2).setValues([["'" + JSON.stringify(months), new Date().toISOString()]]);
    return out_({ ok: true, profile: { nickname: f.v[1], company: f.v[2], months: months } });
  }
  return out_({ ok: false, error: "unknown_action" });
}`;

function post(ctx, body) { return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()); }

test("Apps Script -tiedosto: asennus, reititys, kirjautuminen nykyisellä loginilla, pelikomennot ja pysyvyys", () => {
  const sh = makeSheets();
  let ctx = context(sh);
  // nykyinen sovellus toimii ennallaan
  assert.ok(post(ctx, { action: "register", nickname: "Renny", company: "Saka Nummela", pin: "1234" }).ok);
  assert.ok(post(ctx, { action: "register", nickname: "Aino", company: "Saka Nummela", pin: "5678" }).ok);
  assert.ok(post(ctx, { action: "login", nickname: "Renny", pin: "1234" }).ok);
  assert.equal(post(ctx, { action: "login", nickname: "Renny", pin: "9999" }).error, "bad_pin");
  // asennus
  const msg = ctx.mmInstall();
  assert.match(msg, /Myyjiä Sellers-välilehdellä: 2/);
  assert.equal(ctx.__triggers.length, 1);
  ctx.mmInstall();
  assert.equal(ctx.__triggers.length, 1); // ei tuplatriggeriä
  assert.equal(post(ctx, { action: "mm_ping" }).mm, true);
  // väärä PIN
  assert.equal(post(ctx, { action: "mm_state", nickname: "Renny", pin: "0000" }).error, "bad_pin");
  let r = post(ctx, { action: "mm_room_create", nickname: "Renny", pin: "1234", idem: "a1", name: "Halli" });
  assert.ok(r.ok, JSON.stringify(r));
  r = post(ctx, { action: "mm_room_join", nickname: "Aino", pin: "5678", idem: "a2", roomId: r.room.id });
  assert.ok(r.ok);
  r = post(ctx, { action: "mm_room_start", nickname: "Renny", pin: "1234", idem: "a3" });
  assert.ok(r.ok);
  const start = Date.now();
  // tarjousseurannan tallennus (sama saveMonths kuin sovelluksessa) -> työpalkkiot
  const mk = r.season.id;
  const offers = [];
  for (let i = 0; i < 5; i++) offers.push({ id: "g" + i, ts: new Date(start + 1000).toISOString(), source: 1, closed: false, closedTs: null, st: "o" });
  assert.ok(post(ctx, { action: "saveMonths", nickname: "Renny", pin: "1234", months: { [mk]: { offers } } }).ok);
  // palvelimen kello on todellinen, joten odotetaan hetki
  while (Date.now() < start + 1100) {}
  r = post(ctx, { action: "mm_sync", nickname: "Renny", pin: "1234" });
  assert.equal(r.season.me.cash, 50250000);
  assert.equal(r.season.me.work.avail, 1);
  r = post(ctx, { action: "mm_roll", nickname: "Renny", pin: "1234", idem: "roll1" });
  assert.ok(r.ok, JSON.stringify(r));
  const r2 = post(ctx, { action: "mm_roll", nickname: "Renny", pin: "1234", idem: "roll1" });
  assert.equal(r2.replay, true);
  assert.equal(r2.result.turn.d1, r.result.turn.d1);
  assert.ok(sh.sheets.MM_Log.getLastRow() > 3);
  // "palvelimen uudelleenkäynnistys": uusi suoritusympäristö samoilla taulukoilla
  ctx = context(sh);
  const v = post(ctx, { action: "mm_state", nickname: "Aino", pin: "5678" });
  assert.equal(v.season.players.find((p) => p.nick === "renny").pos, r.result.turn.to);
  assert.equal(v.season.players.find((p) => p.nick === "renny").cash, null);
  // ajastettu ylläpito
  assert.ok(ctx.mmHourly().ok);
});

test("Taulukkotallennus: suuret arvot paloitellaan ja kaava- tai lukumuunnos ei riko dataa", () => {
  const sh = makeSheets();
  const ctx = context(sh);
  const store = vm.runInContext("mmSheetStore_()", ctx);
  const big = JSON.stringify({ x: "=".repeat(10) + "a".repeat(120000) + "-1" });
  store.put("k1", big);
  store.put("k2", "=SUM(A1)");
  store.put("k3", "12345");
  store.put("k4", "TRUE");
  const s2 = vm.runInContext("mmSheetStore_()", ctx);
  assert.equal(s2.get("k1"), big);
  assert.equal(s2.get("k2"), "=SUM(A1)");
  assert.equal(s2.get("k3"), "12345");
  assert.equal(s2.get("k4"), "TRUE");
  store.put("k1", "lyhyt");
  assert.equal(vm.runInContext("mmSheetStore_()", ctx).get("k1"), "lyhyt");
  assert.equal(s2.get("nope"), null);
});

test("Varakirjautuminen pin_hash-sarakkeella, jos nykyistä login-toimintoa ei voi kutsua", () => {
  const sh = makeSheets();
  const legacy = context(sh);
  post(legacy, { action: "register", nickname: "Renny", company: "Saka Nummela", pin: "1234" });
  const ctx = context(sh, { noLegacy: true });
  const ok = vm.runInContext('mmAuth_("Renny", "1234")', ctx);
  assert.equal(ok.ok, true); assert.equal(ok.company, "Saka Nummela");
  assert.equal(vm.runInContext('mmAuth_("Renny", "1111")', ctx).ok, false);
  assert.equal(vm.runInContext('mmAuth_("Ei", "1111")', ctx).error, "not_found");
});

test("Satunnaisuus on tasainen myös pienillä n-arvoilla", () => {
  const ctx = context(makeSheets());
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 60000; i++) counts[vm.runInContext("mmRng_(6)", ctx)]++;
  counts.forEach((c) => assert.ok(Math.abs(c - 10000) < 450, String(counts)));
  const c3 = [0, 0, 0];
  for (let i = 0; i < 30000; i++) c3[vm.runInContext("mmRng_(3)", ctx)]++;
  c3.forEach((c) => assert.ok(Math.abs(c - 10000) < 450, String(c3)));
});
