/*
 * Myyntimonopoli – Google Apps Script -kytkentä
 * ---------------------------------------------------------------
 * Tämä osa sitoo pelin palvelinytimen nykyiseen Apps Script -taustaan:
 *   - Tallennus: saman Google Sheets -tiedoston uusi välilehti MM_Data (avain + JSON-palat)
 *   - Tapahtumaloki: välilehti MM_Log (jokainen pelikomento, sulku ja työpalkkioiden täsmäytys)
 *   - Lukko: LockService.getScriptLock() – yksi kirjoittaja kerrallaan
 *   - Kirjautuminen: nykyinen login-toiminto (doPost action "login"), joten PIN-tarkistus on täsmälleen sama
 *   - Työdata: välilehti Sellers (A nickname_key, B nickname, C company, D pin_hash, E months_json)
 *   - Satunnaisuus: Utilities.getUuid() (palvelimen satunnaislähde), tasainen jakauma hylkäysotannalla
 *
 * Asennus: katso MYYNTIMONOPOLI.md. Lyhyesti: liitä tämä tiedosto Apps Script -projektiin uutena
 * tiedostona, lisää doPost-funktion ENSIMMÄISEKSI riviksi
 *     var mm = mmRoute(e); if (mm) return mm;
 * aja kerran funktio mmInstall ja julkaise uusi versio (Deploy → Manage deployments → New version).
 */
var MM_VERSION = "1.0.0";
var MM_DATA = "MM_Data", MM_LOG = "MM_Log", MM_SELLERS = "Sellers";
var MM_CHUNK = 45000;          // Sheets-solun raja on 50 000 merkkiä
var MM_PREFIX = "~";           // estää kaavatulkinnan (=, +, -) ja automaattiset muunnokset

function mmRoute(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (x) { return null; }
  if (!body || String(body.action || "").indexOf("mm_") !== 0) return null;
  var res;
  if (body.action === "mm_ping") res = { ok: true, mm: true, version: MM_VERSION };
  else res = mmServer_().handle(body);
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

var mmServerInst_ = null;
function mmServer_() {
  if (mmServerInst_) return mmServerInst_;
  var store = mmSheetStore_();
  var sellersCache = null;
  var env = {
    store: store,
    now: function () { return Date.now(); },
    rng: mmRng_,
    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) { var b = new Error("busy"); b.mmBusy = true; throw b; }
      try { store.reset(); sellersCache = null; return fn(); } finally { lock.releaseLock(); }
    },
    authenticate: mmAuth_,
    readSellers: function (keys) {
      if (!sellersCache) sellersCache = mmReadSellers_();
      var out = {};
      keys.forEach(function (k) { if (sellersCache[k]) out[k] = sellersCache[k]; });
      return out;
    },
    audit: function (en) {
      var sh = mmSheet_(MM_LOG, ["aika", "huone", "kausi", "pelaaja", "toiminto", "avain", "ok", "tiedot"]);
      sh.appendRow([new Date(en.t).toISOString(), en.room || "", en.season || "", en.nick || "", en.action || "", en.idem || "", en.ok ? "ok" : "virhe", "'" + String(en.info || "").slice(0, 45000)]);
    }
  };
  mmServerInst_ = MMServer.create(env);
  return mmServerInst_;
}

// ---------- Taulukko ----------
function mmSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("MM_SHEET_ID");
  if (!id) {
    // nykyisen koodin mahdolliset vakiot
    if (typeof SHEET_ID !== "undefined" && SHEET_ID) id = SHEET_ID;
    else if (typeof SPREADSHEET_ID !== "undefined" && SPREADSHEET_ID) id = SPREADSHEET_ID;
  }
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("Taulukkoa ei löytynyt. Aseta skriptin ominaisuus MM_SHEET_ID (Project Settings → Script properties).");
  return ss;
}
function mmSheet_(name, header) {
  var ss = mmSpreadsheet_(), sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); if (header) sh.getRange(1, 1, 1, header.length).setValues([header]); }
  return sh;
}
function mmSheetStore_() {
  var sh = null, rows = null;
  function sheet() { if (!sh) sh = mmSheet_(MM_DATA, ["avain", "päivitetty", "palat", "data"]); return sh; }
  function load() {
    if (rows) return;
    rows = {};
    var s = sheet(), n = s.getLastRow();
    if (n < 2) return;
    var v = s.getRange(2, 1, n - 1, 1).getValues();
    for (var i = 0; i < v.length; i++) if (v[i][0]) rows[String(v[i][0])] = i + 2;
  }
  return {
    reset: function () { rows = null; },
    get: function (k) {
      load();
      var row = rows[k]; if (!row) return null;
      var s = sheet(), all = s.getRange(row, 1, 1, s.getLastColumn()).getValues()[0], n = +all[2] || 0;
      if (!n) return null;
      var vals = all.slice(3, 3 + n);
      return vals.map(function (x) { x = String(x); return x.charAt(0) === MM_PREFIX ? x.slice(1) : x; }).join("");
    },
    put: function (k, v) {
      load();
      var s = sheet(), parts = [];
      for (var i = 0; i < v.length; i += MM_CHUNK) parts.push(MM_PREFIX + v.slice(i, i + MM_CHUNK));
      if (!parts.length) parts.push(MM_PREFIX);
      var row = rows[k];
      if (!row) { row = Math.max(s.getLastRow(), 1) + 1; rows[k] = row; }
      if (row > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), row - s.getMaxRows());
      var width = Math.max(3 + parts.length, s.getLastColumn());
      if (width > s.getMaxColumns()) s.insertColumnsAfter(s.getMaxColumns(), width - s.getMaxColumns());
      var vals = [k, new Date().toISOString(), parts.length].concat(parts);
      while (vals.length < width) vals.push("");
      s.getRange(row, 1, 1, width).setValues([vals]);
    }
  };
}
function mmReadSellers_() {
  var sh = mmSpreadsheet_().getSheetByName(MM_SELLERS);
  if (!sh) throw new Error("Välilehteä Sellers ei löytynyt.");
  var v = sh.getDataRange().getValues(), out = {};
  for (var i = 0; i < v.length; i++) {
    var key = String(v[i][0] || "").trim().toLowerCase();
    if (!key || key === "nickname_key") continue;
    var months = {};
    try { months = JSON.parse(String(v[i][4] || "{}")); } catch (x) { months = {}; }
    out[key] = { nickname: String(v[i][1] || key), company: String(v[i][2] || ""), months: months, pinHash: String(v[i][3] || "") };
  }
  return out;
}

// ---------- Kirjautuminen ----------
// Ensisijaisesti nykyinen login-toiminto, jolloin PIN-tarkistus on sama kuin tarjousseurannassa.
// Varalla suora vertailu Sellers-välilehden pin_hash-sarakkeeseen yleisillä SHA-256-muodoilla.
function mmAuth_(nick, pin) {
  nick = String(nick || "").trim(); pin = String(pin || "").trim();
  if (!nick || !pin) return { ok: false, error: "auth" };
  if (typeof doPost === "function") {
    try {
      var payload = JSON.stringify({ action: "login", nickname: nick, pin: pin });
      var out = doPost({ postData: { contents: payload, type: "text/plain", length: payload.length, name: "postData" }, parameter: {}, parameters: {}, contentLength: payload.length, queryString: "", pathInfo: "" });
      var res = JSON.parse(out.getContent());
      if (res && res.ok && res.profile) return { ok: true, nickname: res.profile.nickname || nick, company: res.profile.company || "", months: res.profile.months || {} };
      if (res && (res.error === "bad_pin" || res.error === "not_found")) return { ok: false, error: res.error };
    } catch (x) { /* varamenetelmä alla */ }
  }
  var all = mmReadSellers_(), key = String(nick).trim().toLowerCase(), s = all[key];
  if (!s) return { ok: false, error: "not_found" };
  var stored = s.pinHash.trim();
  var cands = [pin, key + pin, key + ":" + pin, key + "|" + pin, pin + key, pin + ":" + key, String(nick) + pin, String(nick) + ":" + pin];
  for (var i = 0; i < cands.length; i++) {
    var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, cands[i], Utilities.Charset.UTF_8);
    var hex = d.map(function (b) { var h = (b & 255).toString(16); return h.length === 1 ? "0" + h : h; }).join("");
    if (stored.toLowerCase() === hex || stored === Utilities.base64Encode(d) || stored === Utilities.base64EncodeWebSafe(d)) {
      return { ok: true, nickname: s.nickname, company: s.company, months: s.months };
    }
  }
  return { ok: false, error: "bad_pin" };
}

// ---------- Satunnaisuus ----------
function mmRng_(n) {
  if (!(n >= 1)) throw new Error("rng");
  var lim = Math.floor(4294967296 / n) * n;
  for (var i = 0; i < 100; i++) {
    var x = parseInt(Utilities.getUuid().replace(/-/g, "").slice(0, 8), 16);
    if (x < lim) return x % n;
  }
  throw new Error("rng");
}

// ---------- Ylläpito ----------
function mmInstall() {
  mmSheet_(MM_DATA, ["avain", "päivitetty", "palat", "data"]);
  mmSheet_(MM_LOG, ["aika", "huone", "kausi", "pelaaja", "toiminto", "avain", "ok", "tiedot"]);
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "mmHourly") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("mmHourly").timeBased().everyHours(1).create();
  var n = Object.keys(mmReadSellers_()).length;
  return "Myyntimonopoli asennettu: välilehdet MM_Data ja MM_Log, tunnin välein ajettava ylläpito. Myyjiä Sellers-välilehdellä: " + n + ".";
}
function mmHourly() { return mmServer_().maintenance(); }
