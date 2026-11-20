// Myyntimonopoli – Apps Script -palvelinosa. Koottu tiedostoista mm/engine.js, mm/adapter.js, mm/server.js ja mm/gas.js.
// Älä muokkaa tätä tiedostoa käsin: muokkaa lähdetiedostoja ja aja `node mm/build.js`.
// Asennus: MYYNTIMONOPOLI.md, kohta "Palvelinosan asennus".

// ===== engine.js =====
/*
 * Myyntimonopoli – pelimoottori
 * ---------------------------------------------------------------
 * Puhdas, deterministinen pelilogiikka. Sama tiedosto ajetaan
 *   - palvelimella (Google Apps Script V8, osana Myyntimonopoli.gs)
 *   - testeissä (Node)
 *   - selaimen demotilassa
 * Moottori ei käytä kelloa eikä satunnaisuutta itse: kutsuja antaa
 * ajan (now, ms) ja satunnaislähteen (rng(n) -> kokonaisluku 0..n-1).
 *
 * Yksiköt:
 *   raha      kokonaisina sentteinä
 *   pisteet   neljäsosapisteinä (1 piste = 4)
 *   prosentit peruspisteinä (95 % = 9500, kerroin 1,20 = 12000)
 */
var MMEngine = (function () {
  "use strict";

  // ---------- Säännöt (kauden sääntöversio) ----------
  var DEFAULT_RULES = {
    version: 1,
    startCash: 50000000,          // 500 000 €
    tilePrice: 5000000,           // 50 000 €
    maxTiles: 3,
    slotsPerTile: 3,
    receivingSlots: 1,
    classes: {
      DIESEL:        { buy: 1000000, margin: 50000,  name: "Diesel" },
      PETROL_HYBRID: { buy: 2500000, margin: 200000, name: "Bensa/hybridi" },
      ELECTRIC:      { buy: 6000000, margin: 600000, name: "Sähköauto" }
    },
    channels: { bank: 10000, auction: 9000, autovex: 9500, wholesale: 8500 },
    work: {
      offer:    { cents: 50000,  q: 4 },   // 500 €, 1 piste
      deal:     { cents: 500000, q: 16 },  // 5 000 €, 4 pistettä (ennen boostia)
      handover: { cents: 10000,  q: 1 }    // 100 €, 0,25 pistettä
    },
    qPerTurn: 20,                          // 5 pistettä = 1 vuoro
    // Hitrate-boosti: alaraja peruspisteinä (2000 = 20 %) -> kerroin
    boost: [
      { min: 3500, mult: 12500 },
      { min: 3000, mult: 12000 },
      { min: 2500, mult: 11500 },
      { min: 2000, mult: 11000 }
    ],
    boostMinSample: 20,
    hitWindowDays: 60,
    hitMinAgeDays: 7,
    minPlayers: 2,
    maxPlayers: 5
  };

  // ---------- Lauta ----------
  var BOARD = [
    { name: "Lähtö", kind: "start" },
    { name: "Liidikatu", kind: "tile", group: 1 },
    { name: "Tarjoustie", kind: "tile", group: 1 },
    { name: "Koeajokuja", kind: "tile", group: 1 },
    { name: "Huutokauppa", kind: "auction" },
    { name: "Vaihtoautoväylä", kind: "tile", group: 2 },
    { name: "Autovex", kind: "autovex" },
    { name: "Hybridikatu", kind: "tile", group: 2 },
    { name: "Sähköautotie", kind: "tile", group: 2 },
    { name: "Markkinakatsaus", kind: "market" },
    { name: "Perheautokuja", kind: "tile", group: 3 },
    { name: "Nelivetoväylä", kind: "tile", group: 3 },
    { name: "Varikko", kind: "pit" },
    { name: "Rahoituskatu", kind: "tile", group: 4 },
    { name: "Sopimustie", kind: "tile", group: 4 },
    { name: "Huutokauppa", kind: "auction" },
    { name: "Avaintenkuja", kind: "tile", group: 5 },
    { name: "Luovutusväylä", kind: "tile", group: 5 },
    { name: "Autovex", kind: "autovex" },
    { name: "Premiumkatu", kind: "tile", group: 6 },
    { name: "Urheiluautotie", kind: "tile", group: 6 },
    { name: "Varikko", kind: "pit" },
    { name: "Kauppakarpaasin aukio", kind: "tile", group: 7 },
    { name: "Oma autotalo", kind: "tile", group: 7 }
  ];
  var BOARD_SIZE = BOARD.length;

  // ---------- Virheet ----------
  function GameError(code, msg) { this.code = code; this.message = msg; this.isGameError = true; }
  GameError.prototype = Object.create(Error.prototype);
  function fail(code, msg) { throw new GameError(code, msg); }

  // ---------- Apurit ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function mergeRules(base, over) {
    var r = clone(base || DEFAULT_RULES);
    if (!over) return r;
    Object.keys(over).forEach(function (k) {
      if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) && r[k] && typeof r[k] === "object" && !Array.isArray(r[k])) r[k] = mergeRules(r[k], over[k]);
      else r[k] = clone(over[k]);
    });
    return r;
  }
  // Prosenttiosuus sentteinä, pyöristys lähimpään senttiin, puolikas ylöspäin (positiiviset summat).
  function pct(cents, bp) { return Math.floor((cents * bp + 5000) / 10000); }
  function fmtEur(cents) {
    var neg = cents < 0, c = Math.abs(Math.round(cents));
    var e = Math.floor(c / 100), s = c % 100;
    var str = String(e).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return (neg ? "−" : "") + str + (s ? "," + (s < 10 ? "0" : "") + s : "") + " €";
  }
  function fmtPts(q) {
    var w = Math.floor(Math.abs(q) / 4), r = Math.abs(q) % 4;
    var s = String(w) + (r ? "," + ["", "25", "5", "75"][r] : "");
    return (q < 0 ? "−" : "") + s;
  }

  // ---------- Aikavyöhyke Europe/Helsinki ----------
  // EET (UTC+2) / EEST (UTC+3). Kesäaika EU-säännöllä: maaliskuun viimeinen sunnuntai 01:00 UTC
  // – lokakuun viimeinen sunnuntai 01:00 UTC. Ei riippuvuutta selaimen tai palvelimen Intl-tukeen.
  function lastSunday(y, monthIdx) {
    var d = new Date(Date.UTC(y, monthIdx + 1, 0));
    return d.getUTCDate() - d.getUTCDay();
  }
  function isSummer(ms) {
    var y = new Date(ms).getUTCFullYear();
    var a = Date.UTC(y, 2, lastSunday(y, 2), 1), b = Date.UTC(y, 9, lastSunday(y, 9), 1);
    return ms >= a && ms < b;
  }
  function hkOffset(ms) { return (isSummer(ms) ? 3 : 2) * 3600000; }
  function hkParts(ms) {
    var d = new Date(ms + hkOffset(ms));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
  }
  // Paikallinen seinäkelloaika -> UTC ms. Normalisoi päivän yli- ja alivuodot.
  function hkToUtc(y, m, d, h, mi) {
    var wall = Date.UTC(y, m - 1, d, h || 0, mi || 0);
    var t = wall - 2 * 3600000;
    t = wall - hkOffset(t);
    t = wall - hkOffset(t);
    return t;
  }
  function hkDayStart(ms, addDays) {
    var p = hkParts(ms);
    return hkToUtc(p.y, p.m, p.d + (addDays || 0), 0, 0);
  }
  function seasonIdOf(ms) { var p = hkParts(ms); return p.y + "-" + (p.m < 10 ? "0" : "") + p.m; }
  function seasonBounds(id) {
    var y = +id.slice(0, 4), m = +id.slice(5, 7);
    return { start: hkToUtc(y, m, 1, 0, 0), end: hkToUtc(y, m + 1, 1, 0, 0) };
  }
  function nextSeasonId(id) { var y = +id.slice(0, 4), m = +id.slice(5, 7) + 1; if (m > 12) { m = 1; y++; } return y + "-" + (m < 10 ? "0" : "") + m; }
  // Viikon alku: maanantai 00:00 Helsingin aikaa.
  function weekStart(ms) {
    var p = hkParts(ms);
    return hkToUtc(p.y, p.m, p.d - ((p.dow + 6) % 7), 0, 0);
  }

  // ---------- Hitrate ja boosti ----------
  // cases: { id: { f: ensimmäisen aidon tarjouksen aika, d: vahvistetun voimassa olevan kaupan aika tai 0 } }
  function hitrateSnapshot(cases, snapMs, rules) {
    rules = rules || DEFAULT_RULES;
    var lo = hkDayStart(snapMs, -rules.hitWindowDays);
    var hi = hkDayStart(snapMs, -rules.hitMinAgeDays + 1); // koko päivä snap-7 mukaan
    var n = 0, k = 0;
    Object.keys(cases || {}).forEach(function (id) {
      var c = cases[id];
      if (!c || !c.f || c.f < lo || c.f >= hi) return;
      n++;
      if (c.d && c.d <= snapMs) k++;
    });
    var mult = 10000;
    if (n >= rules.boostMinSample) {
      for (var i = 0; i < rules.boost.length; i++) {
        if (k * 10000 >= rules.boost[i].min * n) { mult = rules.boost[i].mult; break; }
      }
    }
    return { at: snapMs, n: n, k: k, rateBp: n ? Math.floor(k * 10000 / n) : 0, mult: mult, sample: n >= rules.boostMinSample, lo: lo, hi: hi };
  }

  // ---------- Kausi ----------
  function newSeason(o) {
    var rules = mergeRules(DEFAULT_RULES, o.rules || null);
    var b = seasonBounds(o.id);
    var s = {
      id: o.id, roomId: o.roomId, state: "active", rules: rules,
      startAt: o.startAt || b.start, endAt: b.end, closedAt: null,
      players: {}, order: [], tiles: {}, cars: {}, listings: {},
      awards: {}, ledger: [], feed: [], seq: { car: 0, turn: 0, led: 0, feed: 0 },
      results: null, corrected: false, turns: []
    };
    (o.participants || []).forEach(function (p) { addPlayer(s, p.nick, p.joinedAt || s.startAt, p.name); });
    return s;
  }
  function addPlayer(s, nick, joinedAt, name) {
    if (s.players[nick]) return s.players[nick];
    var p = { nick: nick, name: name || nick, joinedAt: joinedAt, cash: s.rules.startCash, debt: 0, pos: 0,
      used: 0, openTurn: null, recv: null, lastTurn: null, expired: 0, color: s.order.length };
    s.players[nick] = p; s.order.push(nick);
    return p;
  }
  function player(s, nick) { var p = s.players[nick]; if (!p) fail("NOT_PARTICIPANT", "Et ole tämän kauden pelaaja."); return p; }
  function assertActive(s, now) {
    if (s.state !== "active") fail("SEASON_CLOSED", "Kausi on päättynyt.");
    if (now < s.startAt) fail("SEASON_NOT_STARTED", "Kausi ei ole vielä alkanut.");
    if (now >= s.endAt) fail("SEASON_CLOSED", "Kausi on päättynyt.");
  }

  // ---------- Kirjanpito ----------
  function led(s, now, nick, kind, dc, dd, ref, note) {
    s.seq.led++;
    s.ledger.push({ i: s.seq.led, t: now, nick: nick, k: kind, dc: dc, dd: dd, ref: ref || null, n: note || null });
  }
  // Tulo: kuittaa ensin velkaa, loput kassaan.
  function income(s, now, nick, cents, kind, ref) {
    if (cents <= 0) return;
    var p = s.players[nick], toDebt = Math.min(p.debt, cents), toCash = cents - toDebt;
    p.debt -= toDebt; p.cash += toCash;
    led(s, now, nick, kind, toCash, -toDebt, ref);
  }
  // Pakollinen maksu: kassa ensin, puuttuva osa korottomaksi pelivelaksi.
  function payForced(s, now, nick, cents, kind, ref) {
    var p = s.players[nick], fromCash = Math.min(p.cash, cents), newDebt = cents - fromCash;
    p.cash -= fromCash; p.debt += newDebt;
    led(s, now, nick, kind, -fromCash, newDebt, ref);
    return newDebt;
  }
  // Vapaaehtoinen maksu: vaatii riittävän kassan ja nollavelan.
  function payVoluntary(s, now, nick, cents, kind, ref) {
    var p = s.players[nick];
    if (p.debt > 0) fail("HAS_DEBT", "Vapaaehtoisia hankintoja ei voi tehdä, kun pelivelkaa on " + fmtEur(p.debt) + ".");
    if (p.cash < cents) fail("NO_CASH", "Kassa ei riitä: tarvitaan " + fmtEur(cents) + ", kassassa " + fmtEur(p.cash) + ".");
    p.cash -= cents;
    led(s, now, nick, kind, -cents, 0, ref);
  }
  // Negatiivinen oikaisu: kassa ensin, loput velaksi. Ei myy autoja.
  function charge(s, now, nick, cents, kind, ref) { return payForced(s, now, nick, cents, kind, ref); }

  function feed(s, now, nick, type, msg, data) {
    s.seq.feed++;
    s.feed.push({ i: s.seq.feed, t: now, nick: nick, type: type, msg: msg, d: data || null });
    if (s.feed.length > 400) s.feed.splice(0, s.feed.length - 400);
  }

  // ---------- Työpalkkiot ----------
  // Palkkio kuuluu kauteen, jonka aikana työ varmennetusti tehtiin.
  // stage: offer | deal | handover. status: active | reversed (raha oikaistu, pisteet säilyvät) | void (virheellinen merkintä).
  function awardKey(nick, stage, caseId) { return nick + "|" + stage + "|" + caseId; }
  function stageLabel(stage) { return stage === "offer" ? "Aito tarjous" : stage === "deal" ? "Oikea kauppa" : "Luovutus hoidettu"; }

  function grantAward(s, now, nick, stage, caseId, t, mult, snap) {
    var p = player(s, nick), key = awardKey(nick, stage, caseId);
    if (s.awards[key]) return null; // sama työvaihe palkitaan vain kerran
    var w = s.rules.work[stage];
    var cents = stage === "deal" ? pct(w.cents, mult || 10000) : w.cents;
    var a = { key: key, nick: nick, stage: stage, caseId: caseId, t: t, cents: cents, q: w.q, mult: stage === "deal" ? (mult || 10000) : null, snap: snap || null, status: "active", hist: [{ t: now, a: "grant" }] };
    s.awards[key] = a;
    if (s.state === "closed") { s.corrected = true; }
    income(s, now, nick, cents, "work_" + stage, key);
    var txt = stageLabel(stage) + ": +" + fmtEur(cents) + " ja +" + fmtPts(w.q) + " työpistettä" + (stage === "deal" && mult && mult !== 10000 ? " (boosti " + (mult / 10000).toFixed(2).replace(".", ",") + ")" : "") + ".";
    feed(s, now, nick, "work", txt, { stage: stage, cents: cents, q: w.q, late: s.state === "closed" });
    if (s.state === "closed") recomputeResults(s);
    return a;
  }
  // Kaupan peruuntuminen: rahapalkkio oikaistaan alkuperäisellä summalla, pisteet säilyvät.
  function reverseAward(s, now, key) {
    var a = s.awards[key]; if (!a || a.status !== "active") return null;
    a.status = "reversed"; a.hist.push({ t: now, a: "reverse" });
    charge(s, now, a.nick, a.cents, "work_reverse", key);
    feed(s, now, a.nick, "work", stageLabel(a.stage) + " peruuntui: −" + fmtEur(a.cents) + ". Ansaitut työpisteet säilyvät.", { stage: a.stage, cents: -a.cents });
    if (s.state === "closed") { s.corrected = true; recomputeResults(s); }
    return a;
  }
  // Sama kauppa palautuu voimaan: sama rahapalkkio kerran, ei uusia pisteitä.
  function restoreAward(s, now, key) {
    var a = s.awards[key]; if (!a || a.status !== "reversed") return null;
    a.status = "active"; a.hist.push({ t: now, a: "restore" });
    income(s, now, a.nick, a.cents, "work_restore", key);
    feed(s, now, a.nick, "work", stageLabel(a.stage) + " palautui voimaan: +" + fmtEur(a.cents) + ".", { stage: a.stage, cents: a.cents });
    if (s.state === "closed") { s.corrected = true; recomputeResults(s); }
    return a;
  }
  // Virheellinen tai päällekkäinen merkintä: raha ja pisteet oikaistaan.
  function voidAward(s, now, key) {
    var a = s.awards[key]; if (!a || a.status === "void") return null;
    if (a.status === "active") charge(s, now, a.nick, a.cents, "work_void", key);
    a.status = "void"; a.hist.push({ t: now, a: "void" });
    feed(s, now, a.nick, "work", "Työmerkintä korjattiin: " + stageLabel(a.stage).toLowerCase() + " poistui (−" + fmtPts(a.q) + " pistettä).", { stage: a.stage, q: -a.q });
    if (s.state === "closed") { s.corrected = true; recomputeResults(s); }
    return a;
  }

  // Vuoro-oikeudet: lasketaan palkkioista ansaintajärjestyksessä. Peruttu kauppa säilyttää pisteet,
  // virheellinen merkintä ei. Oikeuden ansainta-aika = työtapahtuman aika, jolla raja ylittyi.
  function rights(s, nick) {
    var list = [];
    Object.keys(s.awards).forEach(function (k) { var a = s.awards[k]; if (a.nick === nick && a.status !== "void") list.push(a); });
    list.sort(function (a, b) { return a.t - b.t || (a.key < b.key ? -1 : 1); });
    var q = 0, at = [], per = s.rules.qPerTurn;
    list.forEach(function (a) {
      var before = Math.floor(q / per);
      q += a.q;
      var after = Math.floor(q / per);
      for (var i = before; i < after; i++) at.push(a.t);
    });
    return { q: q, earned: at.length, at: at };
  }
  function workStatus(s, nick, now) {
    var p = player(s, nick), r = rights(s, nick), per = s.rules.qPerTurn;
    var avail = Math.max(0, r.earned - p.used);
    var deficit = Math.max(0, p.used * per - r.q);
    var toNext = deficit > 0 ? deficit + per : per - (r.q % per);
    if (deficit === 0 && r.q % per === 0) toNext = per;
    var dayStart = hkDayStart(now, 0), today = 0, workNet = 0, dealsValid = 0, offers = 0, handovers = 0;
    Object.keys(s.awards).forEach(function (k) {
      var a = s.awards[k]; if (a.nick !== nick) return;
      if (a.status === "active") {
        workNet += a.cents;
        if (a.t >= dayStart) today += a.cents;
        if (a.stage === "deal") dealsValid++;
      }
      if (a.status !== "void") { if (a.stage === "offer") offers++; if (a.stage === "handover") handovers++; }
    });
    return { q: r.q, earned: r.earned, used: p.used, avail: avail, toNext: toNext, deficit: deficit, nextAt: r.at[p.used] || null, today: today, workNet: workNet, dealsValid: dealsValid, offers: offers, handovers: handovers };
  }

  // ---------- Autot ja varasto ----------
  function ownedTiles(s, nick) {
    return Object.keys(s.tiles).filter(function (i) { return s.tiles[i] === nick; }).map(Number).sort(function (a, b) { return a - b; });
  }
  function carsOnTile(s, idx) {
    return Object.keys(s.cars).map(function (id) { return s.cars[id]; })
      .filter(function (c) { return c.st !== "gone" && c.loc && c.loc.t === "tile" && c.loc.tile === idx; });
  }
  function freeSlot(s, idx) {
    var used = carsOnTile(s, idx).map(function (c) { return c.loc.slot; });
    for (var i = 0; i < s.rules.slotsPerTile; i++) if (used.indexOf(i) === -1) return i;
    return -1;
  }
  function carsOf(s, nick) {
    return Object.keys(s.cars).map(function (id) { return s.cars[id]; }).filter(function (c) { return c.owner === nick && c.st !== "gone"; });
  }
  function car(s, id) { var c = s.cars[id]; if (!c || c.st === "gone") fail("NO_CAR", "Autoa ei löydy."); return c; }
  function ownCar(s, nick, id) {
    var c = car(s, id);
    if (c.owner !== nick) fail("NOT_OWNER", "Auto ei ole sinun.");
    return c;
  }
  function clsName(s, cls) { return (s.rules.classes[cls] || { name: cls }).name; }
  function removeCar(s, c, now, how) { c.st = "gone"; c.goneAt = now; c.goneHow = how; c.loc = null; if (s.players[c.owner] && s.players[c.owner].recv === c.id) s.players[c.owner].recv = null; }
  // Kanavahinnat aina nykyisen omistajan hankintahinnasta.
  function channelPrices(s, c) {
    var ch = s.rules.channels;
    return { bank: pct(c.acq, ch.bank), auction: pct(c.acq, ch.auction), autovex: pct(c.acq, ch.autovex), wholesale: pct(c.acq, ch.wholesale) };
  }
  // Pakollisen kaupan hinta: ensimmäinen katteellinen myynti = hankinta + luokan kate, muuten hankintahinta.
  function forcedPrice(s, c) { return c.right ? c.acq + s.rules.classes[c.cls].margin : c.acq; }
  function sellCar(s, now, c, channel, kind) {
    var price = pct(c.acq, s.rules.channels[channel]);
    var loss = c.acq - price, nick = c.owner;
    income(s, now, nick, price, kind, c.id);
    removeCar(s, c, now, channel);
    return { price: price, loss: loss };
  }

  // ---------- Vuorot ----------
  function openTurn(s, p) { return p.openTurn; }
  function requireTurn(s, nick, turnId, now) {
    assertActive(s, now);
    var p = player(s, nick), t = p.openTurn;
    if (!t || (turnId && t.id !== turnId)) fail("NO_OPEN_TURN", "Sinulla ei ole avointa vuoroa.");
    return t;
  }
  function useAction(t) {
    if (t.actionUsed) fail("ACTION_USED", "Tämän vuoron varastotoimi on jo käytetty.");
    t.actionUsed = true;
  }

  // Heitto: käyttää yhden ansaitun vuoro-oikeuden. Nopat ja arvonta tulevat palvelimen rng:stä.
  function roll(s, nick, now, rng) {
    assertActive(s, now);
    var p = player(s, nick);
    if (p.openTurn) endTurnInternal(s, p, now, "roll");
    var r = rights(s, nick);
    if (r.earned - p.used <= 0) fail("NO_TURNS", "Ei käytettäviä vuoroja. Ansaitse lisää oikealla työllä.");
    var rightAt = r.at[p.used];
    p.used++;
    var d1 = rng(6) + 1, d2 = rng(6) + 1, from = p.pos, to = (from + d1 + d2) % BOARD_SIZE;
    p.pos = to;
    s.seq.turn++;
    var t = { id: "T" + s.seq.turn, nick: nick, at: now, rightIdx: p.used - 1, rightAt: rightAt, d1: d1, d2: d2, from: from, to: to,
      tileBought: false, actionUsed: false, forced: null, ended: null };
    p.openTurn = t;
    (s.turns || (s.turns = [])).push({ id: t.id, n: nick, at: now, ra: rightAt, d: [d1, d2], fr: from, to: to });
    var sq = BOARD[to];
    feed(s, now, nick, "roll", p.name + " heitti " + d1 + " + " + d2 + " ja eteni ruutuun " + sq.name + ".", { turn: t.id, d1: d1, d2: d2, from: from, to: to });
    if (sq.kind === "tile" && s.tiles[to] && s.tiles[to] !== nick) {
      t.forced = forcedPurchase(s, nick, s.tiles[to], to, now, rng, t.id);
      var tl = s.turns[s.turns.length - 1];
      tl.fc = t.forced.carId || null; tl.fp = t.forced.price || 0; tl.fs = t.forced.seller || s.tiles[to];
    }
    return t;
  }

  // Pakollinen autokauppa kilpailijan tontilla. Arvonta tasaisesti myyntikelpoisista autoista.
  function forcedPurchase(s, buyer, seller, idx, now, rng, turnId) {
    var cands = carsOnTile(s, idx).filter(function (c) { return c.owner === seller && c.st === "stock"; })
      .sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    if (!cands.length) {
      feed(s, now, buyer, "forced_none", "Kilpailijan tontilla ei ollut myyntikelpoisia autoja, joten kauppaa ei syntynyt.", { tile: idx, seller: seller });
      return { none: true, candidates: [] };
    }
    var pick = cands[rng(cands.length)];
    var price = forcedPrice(s, pick), margin = price - pick.acq, hadRight = pick.right;
    var debtBefore = s.players[buyer].debt;
    var newDebt = payForced(s, now, buyer, price, "forced_buy", pick.id);
    income(s, now, seller, price, "forced_sale", pick.id);
    var res = { carId: pick.id, cls: pick.cls, price: price, sellerMargin: margin, hadRight: hadRight, seller: seller, newDebt: newDebt, candidates: cands.map(function (c) { return c.id; }) };
    pick.hist = pick.hist || [];
    pick.hist.push({ t: now, a: "forced", from: seller, to: buyer, price: price });
    pick.owner = buyer; pick.acq = price; pick.right = false;
    // Sijoitus: oman tontin vapaa paikka (pienin lautaindeksi), sitten vastaanottopaikka, muuten heti tukkurille.
    var placed = null;
    ownedTiles(s, buyer).some(function (ti) { var sl = freeSlot(s, ti); if (sl >= 0) { placed = { t: "tile", tile: ti, slot: sl }; return true; } return false; });
    var bp = s.players[buyer], sp = s.players[seller];
    if (!placed && !bp.recv) { placed = { t: "recv" }; bp.recv = pick.id; }
    var name = clsName(s, pick.cls).toLowerCase();
    feed(s, now, buyer, "forced", bp.name + " osui " + sp.name + ":n autoliikkeeseen ja osti arvotun auton (" + name + ") " + fmtEur(price) + ":lla." +
      (margin > 0 ? " " + sp.name + " sai katetta " + fmtEur(margin) + "." : " Katetta ei syntynyt.") + " Autosta ei voi tehdä uutta katetta.", res);
    if (newDebt > 0) feed(s, now, buyer, "debt", "Kassa ei riittänyt pakolliseen ostoon. Pelivelkaa syntyi " + fmtEur(newDebt) + ".", { debt: newDebt, before: debtBefore });
    if (placed) {
      pick.loc = placed;
      res.placed = placed;
    } else {
      pick.loc = { t: "transit" };
      var w = sellCar(s, now, pick, "wholesale", "forced_wholesale");
      res.placed = null; res.wholesale = w;
      feed(s, now, buyer, "wholesale", "Autolle ei ollut tilaa, joten se myytiin heti tukkurille " + fmtEur(w.price) + ":lla. Tappio " + fmtEur(w.loss) + ".", { car: pick.id, price: w.price, loss: w.loss });
    }
    return res;
  }

  function buyTile(s, nick, now, turnId) {
    var t = requireTurn(s, nick, turnId, now), sq = BOARD[t.to];
    if (t.tileBought) fail("TILE_DONE", "Olet jo ostanut tontin tällä vuorolla.");
    if (sq.kind !== "tile") fail("NOT_TILE", "Tätä ruutua ei voi ostaa.");
    if (s.tiles[t.to]) fail("TILE_OWNED", "Tontti on jo myyty.");
    if (ownedTiles(s, nick).length >= s.rules.maxTiles) fail("MAX_TILES", "Sinulla on jo enimmäismäärä tontteja (" + s.rules.maxTiles + ").");
    payVoluntary(s, now, nick, s.rules.tilePrice, "tile_buy", "tile" + t.to);
    s.tiles[t.to] = nick;
    t.tileBought = true;
    feed(s, now, nick, "tile", s.players[nick].name + " osti tontin " + sq.name + " (" + fmtEur(s.rules.tilePrice) + ").", { tile: t.to });
    return { tile: t.to };
  }

  function bankBuy(s, nick, now, turnId, tileIdx, cls) {
    var t = requireTurn(s, nick, turnId, now);
    if (s.tiles[tileIdx] !== nick) fail("NOT_YOUR_TILE", "Tontti ei ole sinun.");
    var spec = s.rules.classes[cls]; if (!spec) fail("BAD_CLASS", "Tuntematon autoluokka.");
    var slot = freeSlot(s, tileIdx); if (slot < 0) fail("TILE_FULL", "Tontilla ei ole vapaata autopaikkaa.");
    if (t.actionUsed) fail("ACTION_USED", "Tämän vuoron varastotoimi on jo käytetty.");
    payVoluntary(s, now, nick, spec.buy, "bank_buy", null);
    t.actionUsed = true;
    s.seq.car++;
    var c = { id: "C" + s.seq.car, cls: cls, owner: nick, loc: { t: "tile", tile: tileIdx, slot: slot }, acq: spec.buy, right: true, st: "stock", hist: [{ t: now, a: "bank", to: nick, price: spec.buy }] };
    s.cars[c.id] = c;
    s.ledger[s.ledger.length - 1].ref = c.id;
    feed(s, now, nick, "bank_buy", s.players[nick].name + " hankki pankilta auton (" + spec.name.toLowerCase() + ") " + fmtEur(spec.buy) + ":lla tontille " + BOARD[tileIdx].name + ".", { car: c.id, tile: tileIdx });
    return { carId: c.id };
  }

  function moveCar(s, nick, now, turnId, carId, dest) {
    var t = requireTurn(s, nick, turnId, now), c = ownCar(s, nick, carId), p = s.players[nick];
    if (c.st !== "stock") fail("CAR_LOCKED", "Autovexiin lukittua autoa ei voi siirtää.");
    var to;
    if (dest === "recv") {
      if (c.loc.t === "recv") fail("SAME_PLACE", "Auto on jo vastaanottopaikalla.");
      if (p.recv) fail("RECV_FULL", "Vastaanottopaikka on varattu.");
      to = { t: "recv" };
    } else {
      var ti = +dest;
      if (s.tiles[ti] !== nick) fail("NOT_YOUR_TILE", "Tontti ei ole sinun.");
      if (c.loc.t === "tile" && c.loc.tile === ti) fail("SAME_PLACE", "Auto on jo tällä tontilla.");
      var sl = freeSlot(s, ti); if (sl < 0) fail("TILE_FULL", "Tontilla ei ole vapaata autopaikkaa.");
      to = { t: "tile", tile: ti, slot: sl };
    }
    useAction(t);
    if (c.loc.t === "recv") p.recv = null;
    if (to.t === "recv") p.recv = c.id;
    c.loc = to;
    feed(s, now, nick, "move", p.name + " siirsi auton " + (to.t === "recv" ? "vastaanottopaikalle." : "tontille " + BOARD[to.tile].name + "."), { car: c.id });
    return { loc: to };
  }

  function listAutovex(s, nick, now, turnId, carId) {
    var t = requireTurn(s, nick, turnId, now), c = ownCar(s, nick, carId);
    if (s.listings[nick]) fail("HAS_LISTING", "Sinulla on jo aktiivinen Autovex-listaus.");
    if (c.st !== "stock") fail("CAR_LOCKED", "Auto on jo lukittu.");
    useAction(t);
    c.st = "listed";
    s.listings[nick] = { carId: c.id, at: now, acq: c.acq, turn: t.id };
    feed(s, now, nick, "autovex", s.players[nick].name + " listasi auton Autovexiin (" + fmtEur(pct(c.acq, s.rules.channels.autovex)) + ").", { car: c.id });
    return { listing: s.listings[nick] };
  }

  function cancelListing(s, nick, now) {
    assertActive(s, now);
    var l = s.listings[nick]; if (!l) fail("NO_LISTING", "Ei aktiivista listausta.");
    var c = s.cars[l.carId]; if (c && c.st === "listed") c.st = "stock";
    delete s.listings[nick];
    feed(s, now, nick, "autovex_cancel", s.players[nick].name + " perui Autovex-listauksen. Käytetty varastotoimi ei palaudu.", { car: l.carId });
    return { ok: true };
  }

  function sellBank(s, nick, now, turnId, carId) {
    var t = requireTurn(s, nick, turnId, now), c = ownCar(s, nick, carId);
    if (s.tiles[t.to] !== nick) fail("NOT_ON_OWN_TILE", "Pankkiasiakkaalle voi myydä vain osuessasi omalle tontillesi.");
    if (c.st !== "stock") fail("CAR_LOCKED", "Autovexiin lukittua autoa ei voi myydä muualle.");
    useAction(t);
    var r = sellCar(s, now, c, "bank", "sell_bank");
    feed(s, now, nick, "sell", s.players[nick].name + " myi auton pankkiasiakkaalle " + fmtEur(r.price) + ":lla (kate 0 €).", { car: c.id, price: r.price, loss: r.loss });
    return r;
  }

  function sellAuction(s, nick, now, turnId, carId) {
    var t = requireTurn(s, nick, turnId, now), c = ownCar(s, nick, carId);
    if (BOARD[t.to].kind !== "auction") fail("NOT_AUCTION", "Huutokauppamyynti vaatii huutokaupparuutuun osumisen.");
    if (c.st !== "stock") fail("CAR_LOCKED", "Autovexiin lukittua autoa ei voi myydä muualle.");
    useAction(t);
    var r = sellCar(s, now, c, "auction", "sell_auction");
    feed(s, now, nick, "sell", s.players[nick].name + " myi auton huutokaupassa " + fmtEur(r.price) + ":lla. Tappio " + fmtEur(r.loss) + ".", { car: c.id, price: r.price, loss: r.loss });
    return r;
  }

  // Tukkuri: heti, myös vuorojen välissä. Ei käytä varastotoimea eikä anna pisteitä.
  function wholesale(s, nick, now, carId) {
    assertActive(s, now);
    var c = ownCar(s, nick, carId);
    if (c.st !== "stock") fail("CAR_LOCKED", "Autovexiin lukittua autoa ei voi myydä muualle.");
    var r = sellCar(s, now, c, "wholesale", "sell_wholesale");
    feed(s, now, nick, "sell", "Tukkurimyynti: " + s.players[nick].name + " sai " + fmtEur(r.price) + ", tappio " + fmtEur(r.loss) + ".", { car: c.id, price: r.price, loss: r.loss });
    return r;
  }

  // Vuoron päätös. Autovex-selvitys vain, jos vuoron oikeus on ansaittu listauksen jälkeen.
  function endTurnInternal(s, p, now, by) {
    var t = p.openTurn; if (!t) return null;
    t.ended = { t: now, by: by };
    p.openTurn = null; p.lastTurn = t;
    var settled = null, l = s.listings[p.nick];
    if (l && by !== "close") {
      if (t.rightAt > l.at) {
        var c = s.cars[l.carId];
        var price = pct(l.acq, s.rules.channels.autovex);
        income(s, now, p.nick, price, "sell_autovex", l.carId);
        removeCar(s, c, now, "autovex");
        delete s.listings[p.nick];
        settled = { carId: l.carId, price: price, loss: l.acq - price };
        feed(s, now, p.nick, "sell", "Autovex-kauppa toteutui: " + p.name + " sai " + fmtEur(price) + ", tappio " + fmtEur(l.acq - price) + ".", settled);
      } else {
        t.avxWait = true;
      }
    }
    t.avx = settled;
    return t;
  }
  function endTurn(s, nick, now, turnId) {
    var t = requireTurn(s, nick, turnId, now);
    return endTurnInternal(s, s.players[nick], now, "player");
  }

  // ---------- Varallisuus ja tulostaulu ----------
  function netWorth(s, nick) {
    var p = s.players[nick];
    var tiles = ownedTiles(s, nick).length * s.rules.tilePrice;
    var stock = carsOf(s, nick).reduce(function (a, c) { return a + c.acq; }, 0);
    var nw = p.cash + tiles + stock - p.debt;
    return { cash: p.cash, debt: p.debt, tiles: tiles, stock: stock, nw: nw, result: nw - s.rules.startCash };
  }
  function standings(s, now) {
    var rows = s.order.map(function (nick) {
      var w = netWorth(s, nick), ws = workStatus(s, nick, now || s.endAt);
      return { nick: nick, name: s.players[nick].name, nw: w.nw, result: w.result, workNet: ws.workNet, deals: ws.dealsValid, offers: ws.offers, handovers: ws.handovers };
    });
    rows.sort(function (a, b) { return b.result - a.result || b.workNet - a.workNet || b.deals - a.deals; });
    var rank = 0;
    rows.forEach(function (r, i) {
      var prev = rows[i - 1];
      if (!prev || prev.result !== r.result || prev.workNet !== r.workNet || prev.deals !== r.deals) rank = i + 1;
      r.rank = rank;
    });
    return rows;
  }
  function recomputeResults(s) {
    if (!s.results) return;
    s.order.forEach(function (nick) { var p = s.players[nick]; p.expired = Math.max(0, rights(s, nick).earned - p.used); });
    s.results.rows = standings(s, s.closedAt);
  }

  // ---------- Kauden sulku ----------
  function closeSeason(s, now) {
    if (s.state === "closed") return { already: true, results: s.results };
    s.order.forEach(function (nick) {
      var p = s.players[nick];
      if (p.openTurn) endTurnInternal(s, p, now, "close"); // ei Autovex-selvitystä
      var l = s.listings[nick];
      if (l) {
        var c = s.cars[l.carId]; if (c && c.st === "listed") c.st = "stock";
        delete s.listings[nick];
        feed(s, now, nick, "autovex_cancel", "Kauden päättyessä keskeneräinen Autovex-listaus peruttiin ilman maksua.", { car: l.carId });
      }
      var r = rights(s, nick);
      p.expired = Math.max(0, r.earned - p.used);
    });
    s.state = "closed"; s.closedAt = now;
    s.results = { at: now, rows: standings(s, now) };
    feed(s, now, null, "close", "Kausi " + s.id + " päättyi. Käyttämättömät vuorot raukesivat.", null);
    return { already: false, results: s.results };
  }

  // ---------- Kirjanpidon tarkistus ----------
  function auditBalances(s) {
    var sums = {};
    s.order.forEach(function (n) { sums[n] = { cash: s.rules.startCash, debt: 0 }; });
    s.ledger.forEach(function (e) { if (!sums[e.nick]) return; sums[e.nick].cash += e.dc; sums[e.nick].debt += e.dd; });
    var ok = true, diff = {};
    s.order.forEach(function (n) {
      var p = s.players[n];
      if (sums[n].cash !== p.cash || sums[n].debt !== p.debt || p.cash < 0 || p.debt < 0) { ok = false; diff[n] = { ledger: sums[n], cash: p.cash, debt: p.debt }; }
    });
    return { ok: ok, diff: diff };
  }

  // ---------- Työtapahtumien täsmäytys ----------
  // cases: tarjousseurannan tiedoista johdetut ostotapaukset
  //   { id, f: tarjouksen aika, d: kaupan aika (jos voimassa), h: luovutuksen aika (jos valmis), del: true jos poistettu }
  // seasonsFor(t) -> kausi, johon aika t kuuluu (tai null). multFor(t) -> { mult, snap } kaupan viikolle.
  // Palauttaa tehdyt muutokset. Idempotentti: sama syöte ei muuta mitään toista kertaa.
  function reconcileCases(nick, cases, ctx) {
    var ops = [];
    function seasonOf(t) {
      var s = ctx.seasonFor(t);
      if (!s || !s.players[nick] || s.state === "planned") return null;
      if (t < s.players[nick].joinedAt) return null; // ei takautuvia palkkioita ennen osallistumista
      return s;
    }
    function findAward(stage, caseId) {
      var key = awardKey(nick, stage, caseId), sid = ctx.awardIndex[key];
      if (!sid) return null;
      var s = ctx.getSeason(sid);
      return s && s.awards[key] ? { s: s, a: s.awards[key] } : null;
    }
    function remember(key, s) { ctx.awardIndex[key] = s.id; }
    cases.forEach(function (c) {
      ["offer", "deal", "handover"].forEach(function (stage) {
        var t = stage === "offer" ? c.f : stage === "deal" ? c.d : c.h;
        var ex = findAward(stage, c.id);
        if (c.del) {
          if (ex && ex.a.status !== "void") { voidAward(ex.s, ctx.now, ex.a.key); ops.push({ op: "void", key: ex.a.key, season: ex.s.id }); }
          return;
        }
        if (t) {
          if (!ex) {
            var s = seasonOf(t);
            if (!s) return;
            var m = stage === "deal" ? ctx.multFor(nick, t) : { mult: null, snap: null };
            var a = grantAward(s, ctx.now, nick, stage, c.id, t, m.mult, m.snap);
            if (a) { remember(a.key, s); ops.push({ op: "grant", key: a.key, season: s.id, cents: a.cents, q: a.q, late: s.state === "closed" }); }
          } else if (ex.a.status === "reversed") {
            restoreAward(ex.s, ctx.now, ex.a.key); ops.push({ op: "restore", key: ex.a.key, season: ex.s.id });
          }
        } else if (stage !== "offer" && ex && ex.a.status === "active") {
          reverseAward(ex.s, ctx.now, ex.a.key); ops.push({ op: "reverse", key: ex.a.key, season: ex.s.id });
        }
      });
    });
    return ops;
  }

  // ---------- Näkymät ----------
  function carView(s, c) {
    var pr = channelPrices(s, c);
    return { id: c.id, cls: c.cls, clsName: clsName(s, c.cls), owner: c.owner, loc: c.loc, acq: c.acq, right: c.right, st: c.st,
      forcedPrice: forcedPrice(s, c), margin: c.right ? s.rules.classes[c.cls].margin : 0, prices: pr,
      losses: { bank: c.acq - pr.bank, auction: c.acq - pr.auction, autovex: c.acq - pr.autovex, wholesale: c.acq - pr.wholesale } };
  }
  // Pelaajalle näytettävä tila: ei sisäisiä kirjanpitokenttiä eikä muiden työtietoja.
  function view(s, nick, now) {
    var me = s.players[nick] || null;
    var players = s.order.map(function (n) {
      var p = s.players[n], w = netWorth(s, n);
      return { nick: n, name: p.name, pos: p.pos, color: p.color, tiles: ownedTiles(s, n), nw: w.nw, result: w.result,
        cash: n === nick ? p.cash : null, debt: n === nick ? p.debt : null, hasListing: !!s.listings[n] };
    });
    var cars = Object.keys(s.cars).map(function (id) { return s.cars[id]; }).filter(function (c) { return c.st !== "gone"; }).map(function (c) { return carView(s, c); });
    var out = {
      id: s.id, state: s.state, startAt: s.startAt, endAt: s.endAt, closedAt: s.closedAt, corrected: s.corrected,
      rules: { tilePrice: s.rules.tilePrice, startCash: s.rules.startCash, classes: s.rules.classes, channels: s.rules.channels, work: s.rules.work, qPerTurn: s.rules.qPerTurn, maxTiles: s.rules.maxTiles, slotsPerTile: s.rules.slotsPerTile, boost: s.rules.boost, boostMinSample: s.rules.boostMinSample, version: s.rules.version },
      board: BOARD, tiles: s.tiles, players: players, cars: cars,
      standings: s.state === "closed" && s.results ? s.results.rows : standings(s, now),
      feed: s.feed.slice(-80)
    };
    if (me) {
      var nw = netWorth(s, nick), ws = workStatus(s, nick, now), l = s.listings[nick];
      out.me = { nick: nick, pos: me.pos, cash: me.cash, debt: me.debt, recv: me.recv, tiles: ownedTiles(s, nick), worth: nw, work: ws,
        openTurn: me.openTurn, lastTurn: me.lastTurn, expired: me.expired,
        listing: l ? { carId: l.carId, at: l.at, acq: l.acq, price: pct(l.acq, s.rules.channels.autovex), waiting: !(ws.nextAt && ws.nextAt > l.at), nextAt: ws.nextAt } : null };
    }
    return out;
  }

  return {
    DEFAULT_RULES: DEFAULT_RULES, BOARD: BOARD, GameError: GameError,
    mergeRules: mergeRules, pct: pct, fmtEur: fmtEur, fmtPts: fmtPts,
    hkParts: hkParts, hkToUtc: hkToUtc, hkDayStart: hkDayStart, hkOffset: hkOffset, seasonIdOf: seasonIdOf, seasonBounds: seasonBounds, nextSeasonId: nextSeasonId, weekStart: weekStart,
    hitrateSnapshot: hitrateSnapshot,
    newSeason: newSeason, addPlayer: addPlayer,
    grantAward: grantAward, reverseAward: reverseAward, restoreAward: restoreAward, voidAward: voidAward, awardKey: awardKey,
    rights: rights, workStatus: workStatus,
    roll: roll, buyTile: buyTile, bankBuy: bankBuy, moveCar: moveCar, listAutovex: listAutovex, cancelListing: cancelListing,
    sellBank: sellBank, sellAuction: sellAuction, wholesale: wholesale, endTurn: endTurn,
    channelPrices: channelPrices, forcedPrice: forcedPrice, ownedTiles: ownedTiles, carsOnTile: carsOnTile, freeSlot: freeSlot, carsOf: carsOf,
    netWorth: netWorth, standings: standings, closeSeason: closeSeason, auditBalances: auditBalances,
    reconcileCases: reconcileCases, view: view, carView: carView
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MMEngine;

// ===== adapter.js =====
/*
 * Myyntimonopoli – tarjousseurannan adapteri
 * ---------------------------------------------------------------
 * Muuntaa tarjousseurannan palvelimelle tallentaman myyjän kuukausidatan
 * (Sellers-taulukon months_json) ostotapauksiksi ja työtapahtumiksi.
 * Puhdas funktio: ei kelloa, ei tallennusta. Sama koodi palvelimella ja testeissä.
 *
 * Lähde tarjousseurannassa (selväkieliset kentät, salattuja lisätietoja ei tarvita):
 *   months[mk].offers[]   kuluvan kuun tarjoukset    { id, ts, closed, closedTs, st, lv, bk }
 *   months[mk].carry[]    kuukaudesta siirtyneet avoimet tarjoukset ja luovutusta odottavat kaupat
 *   months[mk].cases[]    tiivistetyt päättyneet tapaukset [id, tarjousMin, kauppaMin, luovutusMin]
 *   months[mk].lost[]     hävityt tarjoukset { id, ts, lt }
 *   months[mk].del[]      käyttäjän poistamat tarjoukset (id:t)
 *   months[mk].days{}     päiväkohtaiset määrät { "dd": [tarjoukset, kaupat] } (vanhat tiivistetyt kuukaudet)
 *
 * Työvaiheet:
 *   offer     tarjous kirjattu tarjousseurantaan (sovelluksessa ei ole luonnosvaihetta:
 *             kirjaus tehdään, kun tarjous on annettu asiakkaalle)
 *   deal      tarjous merkitty kaupaksi (closed + closedTs); uudelleenavaus = peruuntunut kauppa
 *   handover  kaupan luovutuksen tarkistuslista valmis ja luovutuksen hoiti myyjä itse
 */
var MMAdapter = (function () {
  "use strict";
  var SOURCE = "tarjousseuranta";
  var MIN = 60000;
  // Luovutuksen tarkistuslista (bittimaski). Sama lista on tarjousseurannan käyttöliittymässä.
  var LV_ITEMS = [
    "Auto pesty ja tankattu/ladattu",
    "Kauppapaperit allekirjoitettu",
    "Avaimet ja ohjeet luovutettu",
    "Rekisteröinti ja vakuutus kunnossa",
    "Asiakas opastettu autoon",
    "Jatkoyhteydenotto sovittu"
  ];
  var LV_ALL = (1 << LV_ITEMS.length) - 1;

  function ms(iso) {
    if (iso === null || iso === undefined || iso === "") return 0;
    if (typeof iso === "number") return iso;
    var t = Date.parse(iso);
    return isNaN(t) ? 0 : t;
  }
  function lvDone(o) { return !!(o && o.lv && o.lv.ts && ((o.lv.c | 0) & LV_ALL) === LV_ALL && !o.lv.x); }
  function isMonthKey(k) { return /^\d{4}-\d{2}$/.test(k); }

  // Tapaukset myyjän koko datasta. Palauttaa { cases: {id: {...}}, del: {id: true}, pseudo: [] }.
  function extract(months, hk) {
    var cases = {}, del = {}, pseudo = [];
    months = months || {};
    function put(id, c, full) {
      if (!id) return;
      var ex = cases[id];
      if (!ex) { cases[id] = c; return; }
      // täydellinen tietue voittaa tiivistetyn; tarjousaika = varhaisin
      var f = Math.min(ex.f || Infinity, c.f || Infinity);
      if (full && !ex.full) { cases[id] = c; }
      else if (full && ex.full) {
        // sama tapaus kahdessa täydessä tietueessa (esim. vanha laite): yhdistetään varovasti
        cases[id] = { f: 0, d: ex.d || c.d, h: ex.h || c.h, lost: ex.lost && c.lost, full: true };
      }
      cases[id].f = f === Infinity ? 0 : f;
    }
    function fromOffer(o) {
      if (!o || !o.id || o.bk) return; // bk = "Lisää kuukausi" -toiminnon massakirjaus, ei yksittäistä työtä
      var closed = !!o.closed && !!o.closedTs;
      put(o.id, { f: ms(o.ts), d: closed ? ms(o.closedTs) : 0, h: closed && lvDone(o) ? ms(o.lv.ts) : 0,
        lost: !o.closed && o.st === "l", full: true }, true);
    }
    Object.keys(months).forEach(function (mk) {
      if (!isMonthKey(mk)) return;
      var doc = months[mk] || {};
      (doc.offers || []).forEach(fromOffer);
      (doc.carry || []).forEach(fromOffer);
      (doc.cases || []).forEach(function (r) {
        if (!r || !r[0]) return;
        put(String(r[0]), { f: (r[1] || 0) * MIN, d: (r[2] || 0) * MIN, h: (r[3] || 0) * MIN, lost: !r[2], full: false }, false);
      });
      (doc.lost || []).forEach(function (x) {
        if (!x || !x.id || cases[x.id]) return;
        put(x.id, { f: ms(x.ts), d: 0, h: 0, lost: true, full: false }, false);
      });
      (doc.del || []).forEach(function (id) { del[id] = true; });
    });
    // Vanhat tiivistetyt kuukaudet (ennen tapauskohtaista tallennusta): päiväkohtaisista määristä
    // johdetaan anonyymit tapaukset vain hitraten otokseen. Kuukauden kaikki tarjoukset ovat joko
    // siirtyneitä (carry), hävittyjä (lost) tai kuukauden aikana kaupaksi tulleita.
    if (hk) Object.keys(months).forEach(function (mk) {
      if (!isMonthKey(mk)) return;
      var doc = months[mk] || {};
      if ((doc.offers && doc.offers.length) || doc.cases || !doc.days) return;
      var y = +mk.slice(0, 4), m = +mk.slice(5, 7);
      var known = {};
      (doc.carry || []).concat(doc.lost || []).forEach(function (o) {
        var t = ms(o.ts); if (!t) return;
        var p = hk.hkParts(t);
        if (p.y === y && p.m === m) known[p.d] = (known[p.d] || 0) + 1;
      });
      var monthEnd = hk.hkToUtc(y, m + 1, 1, 0, 0) - MIN;
      Object.keys(doc.days).forEach(function (dd) {
        var n = ((doc.days[dd] || [])[0] | 0) - (known[+dd] || 0);
        for (var i = 0; i < n; i++) pseudo.push({ id: "~" + mk + "-" + dd + "-" + i, f: hk.hkToUtc(y, m, +dd, 12, 0), d: monthEnd, pseudo: true });
      });
    });
    return { cases: cases, del: del, pseudo: pseudo };
  }

  // Työtapahtumat yhtenäisessä muodossa (lähde, tunniste, versio, tapaus, vaihe, tekijä, aika, voimassaolo).
  function events(nick, months, hk) {
    var x = extract(months, hk), out = [];
    Object.keys(x.cases).forEach(function (id) {
      var c = x.cases[id], deleted = !!x.del[id];
      [["offer", c.f], ["deal", c.d], ["handover", c.h]].forEach(function (s) {
        out.push({ source: SOURCE, eventId: SOURCE + ":" + nick + ":" + id + ":" + s[0], version: s[1] + (deleted ? ":del" : ""),
          caseId: id, stage: s[0], actor: nick, at: s[1] || null, valid: !!s[1] && !deleted });
      });
    });
    return out;
  }

  return { SOURCE: SOURCE, LV_ITEMS: LV_ITEMS, LV_ALL: LV_ALL, extract: extract, events: events, lvDone: lvDone, ms: ms };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MMAdapter;

// ===== server.js =====
/*
 * Myyntimonopoli – palvelinosa (alustariippumaton ydin)
 * ---------------------------------------------------------------
 * Komennot, käyttöoikeudet, lukitus, idempotenssi, kaudet ja työpalkkioiden täsmäytys.
 * Ympäristö (env) antaa tallennuksen, lukon, kellon, satunnaisuuden ja kirjautumisen:
 *   env.store.get(key) -> string|null      env.store.put(key, string)
 *   env.withLock(fn) -> fn()               (yksi kirjoittaja kerrallaan koko pelille)
 *   env.now() -> ms                        (palvelimen kello)
 *   env.rng(n) -> 0..n-1                   (luotettava satunnaisuus)
 *   env.authenticate(nick, pin) -> { ok, nickname, company, months } | { ok:false, error }
 *   env.readSellers([nickKey]) -> { nickKey: { nickname, company, months } }   (tarjousseurannan luotettu data)
 *   env.audit(entry)                       (pysyvä tapahtumaloki, valinnainen)
 * Apps Scriptissä env toteutetaan tiedostossa gas.js, testeissä ja demossa muistissa.
 */
var MMServer = (function () {
  "use strict";
  var E = typeof MMEngine !== "undefined" ? MMEngine : require("./engine.js");
  var A = typeof MMAdapter !== "undefined" ? MMAdapter : require("./adapter.js");

  var TOL = 72 * 3600000;               // työtapahtuman aika saa olla enintään 72 h ennen kuin palvelin näki sen
  var REG_KEEP = 150 * 86400000;        // tapausrekisteri hitratea ja oikaisuja varten
  var IDEM_MAX = 250, IDEM_TTL = 48 * 3600000;
  var INDEX = "mm:index";
  function roomKey(id) { return "mm:room:" + id; }
  function seasonKey(roomId, sid) { return "mm:season:" + roomId + ":" + sid; }

  function nickKey(n) { return String(n || "").trim().toLowerCase(); }
  function orgKey(c) { return String(c || "").trim().replace(/\s+/g, " ").toLowerCase(); }
  function err(code, msg) { return { ok: false, error: code, message: msg }; }
  function GE(code, msg) { return new E.GameError(code, msg); }

  // Komennot: mutating = muuttaa rahaa, vuoroja tai omistuksia -> vaatii idempotenssiavaimen
  var ACTIONS = {
    mm_state: {}, mm_sync: {}, mm_rooms: {}, mm_archive: {},
    mm_room_create: { m: 1 }, mm_room_join: { m: 1 }, mm_room_leave: { m: 1 }, mm_room_start: { m: 1 },
    mm_room_rules: { m: 1 }, mm_room_remove: { m: 1 },
    mm_roll: { m: 1, g: 1 }, mm_buy_tile: { m: 1, g: 1 }, mm_bank_buy: { m: 1, g: 1 }, mm_move: { m: 1, g: 1 },
    mm_list: { m: 1, g: 1 }, mm_cancel_list: { m: 1, g: 1 }, mm_sell_bank: { m: 1, g: 1 }, mm_sell_auction: { m: 1, g: 1 },
    mm_wholesale: { m: 1, g: 1 }, mm_end_turn: { m: 1, g: 1 }
  };

  function create(env) {
    function audit(e) { try { if (env.audit) env.audit(e); } catch (x) {} }

    // ---------- Transaktio: ladatut dokumentit välimuistissa, tallennus lopuksi ----------
    function Tx() { this.docs = {}; this.dirty = {}; this.pseudo = {}; }
    Tx.prototype.get = function (key) {
      if (Object.prototype.hasOwnProperty.call(this.docs, key)) return this.docs[key];
      var raw = env.store.get(key);
      var v = raw ? JSON.parse(raw) : null;
      this.docs[key] = v;
      return v;
    };
    Tx.prototype.put = function (key, v) { this.docs[key] = v; this.dirty[key] = true; };
    Tx.prototype.touch = function (key) { this.dirty[key] = true; };
    Tx.prototype.snapshot = function () { var o = {}, self = this; Object.keys(this.docs).forEach(function (k) { o[k] = JSON.stringify(self.docs[k]); }); return { docs: o, dirty: JSON.stringify(this.dirty) }; };
    Tx.prototype.restore = function (sn) { var self = this; this.docs = {}; Object.keys(sn.docs).forEach(function (k) { self.docs[k] = JSON.parse(sn.docs[k]); }); this.dirty = JSON.parse(sn.dirty); };
    Tx.prototype.commit = function () { var self = this; Object.keys(this.dirty).forEach(function (k) { env.store.put(k, JSON.stringify(self.docs[k])); }); this.dirty = {}; };

    function index(tx) {
      var ix = tx.get(INDEX);
      if (!ix) { ix = { v: 1, seq: 0, rooms: {}, users: {} }; tx.put(INDEX, ix); }
      return ix;
    }
    function getRoom(tx, id) { return id ? tx.get(roomKey(id)) : null; }
    function getSeason(tx, room, sid) { return sid ? tx.get(seasonKey(room.id, sid)) : null; }
    function curSeason(tx, room) { return room && room.cur ? getSeason(tx, room, room.cur) : null; }
    function seasonEntry(room, sid) { return room.seasons.filter(function (x) { return x.id === sid; })[0] || null; }
    function roomRules(room) { return E.mergeRules(E.DEFAULT_RULES, room.rules || null); }

    // ---------- Kaudet ----------
    function startSeason(tx, room, now, sid, startAt) {
      var participants = room.order.filter(function (k) { return room.members[k] && !room.members[k].leaving; })
        .slice(0, roomRules(room).maxPlayers)
        .map(function (k) { return { nick: k, name: room.members[k].name, joinedAt: startAt }; });
      var s = E.newSeason({ id: sid, roomId: room.id, rules: room.rules || null, startAt: startAt, participants: participants });
      tx.put(seasonKey(room.id, sid), s);
      room.cur = sid;
      room.seasons = room.seasons.filter(function (x) { return x.id !== sid; });
      room.seasons.push({ id: sid, state: "active", startAt: s.startAt, endAt: s.endAt, players: s.order.slice(), closedAt: null, corrected: false });
      s.feed.push({ i: ++s.seq.feed, t: now, nick: null, type: "start", msg: "Kausi alkoi. Pelaajat: " + participants.map(function (p) { return p.name; }).join(", ") + ".", d: null });
      return s;
    }
    function closeAndRoll(tx, room, now) {
      var s = curSeason(tx, room);
      if (!s || s.state !== "active" || now < s.endAt) return null;
      E.closeSeason(s, now);
      tx.touch(seasonKey(room.id, s.id));
      var en = seasonEntry(room, s.id);
      if (en) { en.state = "closed"; en.closedAt = now; en.corrected = !!s.corrected; }
      audit({ t: now, room: room.id, season: s.id, nick: null, action: "season_close", ok: true, info: JSON.stringify((s.results && s.results.rows || []).map(function (r) { return [r.nick, r.result]; })) });
      // poistuvat jäsenet lähtevät kauden vaihtuessa
      room.order.slice().forEach(function (k) { if (room.members[k] && room.members[k].leaving) removeMember(tx, room, k); });
      room.cur = null;
      var active = room.order.filter(function (k) { return room.members[k]; });
      if (active.length >= roomRules(room).minPlayers) {
        var sid = E.seasonIdOf(now);
        startSeason(tx, room, now, sid, E.seasonBounds(sid).start);
      }
      return s;
    }
    function removeMember(tx, room, k) {
      delete room.members[k];
      room.order = room.order.filter(function (x) { return x !== k; });
      var ix = index(tx);
      if (ix.users[k] === room.id) delete ix.users[k];
      tx.touch(INDEX);
      if (room.admin === k) room.admin = room.order[0] || null;
      if (!room.order.length) { delete ix.rooms[room.id]; }
    }

    // ---------- Työn täsmäytys ----------
    function vt(t, seen) { if (!t) return 0; return Math.max(Math.min(t, seen), seen - TOL); }
    function observe(tx, room, key, months, now) {
      var x = A.extract(months || {}, E);
      var reg = room.reg[key] || (room.reg[key] = {});
      var lim = now - REG_KEEP;
      Object.keys(x.cases).forEach(function (id) {
        var c = x.cases[id], r = reg[id];
        if (!r) {
          // hyvin vanhaa tapausta ei rekisteröidä uudelleen (se on jo karsittu): estää saman työn uuden palkinnon
          if (c.f && c.f < lim) return;
          r = reg[id] = [c.f, 0, 0, now, 0, 0, 0];
        }
        if (c.f) r[0] = c.f;
        if (c.d) { if (!r[1]) r[4] = now; r[1] = c.d; } else { r[1] = 0; r[4] = 0; }
        if (c.h) { if (!r[2]) r[5] = now; r[2] = c.h; } else { r[2] = 0; r[5] = 0; }
      });
      Object.keys(x.del).forEach(function (id) { if (reg[id]) reg[id][6] = 1; });
      Object.keys(reg).forEach(function (id) {
        if (reg[id][0] < lim && reg[id][3] < lim) {
          delete reg[id];
          ["offer", "deal", "handover"].forEach(function (st) { delete room.awardIdx[E.awardKey(key, st, id)]; });
        }
      });
      tx.pseudo[key] = x.pseudo;
    }
    function hitCases(tx, room, key) {
      var reg = room.reg[key] || {}, out = {};
      Object.keys(reg).forEach(function (id) { var r = reg[id]; if (!r[6]) out[id] = { f: r[0], d: r[1] }; });
      (tx.pseudo[key] || []).forEach(function (p) { if (!out[p.id]) out[p.id] = { f: p.f, d: p.d }; });
      return out;
    }
    function snapFor(tx, room, key, ws, rules, now) {
      var m = room.snaps[key] || (room.snaps[key] = {});
      if (m[ws]) return m[ws];
      var h = E.hitrateSnapshot(hitCases(tx, room, key), ws, rules);
      m[ws] = { n: h.n, k: h.k, rateBp: h.rateBp, mult: h.mult, at: ws, made: now };
      var keep = ws - 16 * 7 * 86400000;
      Object.keys(m).forEach(function (w) { if (+w < keep) delete m[w]; });
      return m[ws];
    }
    function reconcileMember(tx, room, key, now) {
      var reg = room.reg[key] || {};
      var cases = Object.keys(reg).map(function (id) {
        var r = reg[id];
        return { id: id, f: vt(r[0], r[3]), d: r[1] ? vt(r[1], r[4]) : 0, h: r[2] ? vt(r[2], r[5]) : 0, del: !!r[6] };
      });
      var touched = {};
      var ctx = {
        now: now, awardIndex: room.awardIdx,
        seasonFor: function (t) {
          for (var i = 0; i < room.seasons.length; i++) {
            var en = room.seasons[i];
            if (t >= en.startAt && t < en.endAt && en.players.indexOf(key) !== -1) { var s = getSeason(tx, room, en.id); if (s) { touched[s.id] = s; return s; } }
          }
          return null;
        },
        getSeason: function (sid) { var s = getSeason(tx, room, sid); if (s) touched[s.id] = s; return s; },
        multFor: function (nick, t) {
          var s = ctx.seasonFor(t);
          var sn = snapFor(tx, room, key, E.weekStart(t), s ? s.rules : roomRules(room), now);
          return { mult: sn.mult, snap: sn.at };
        }
      };
      var ops = E.reconcileCases(key, cases, ctx);
      Object.keys(touched).forEach(function (sid) {
        if (!ops.length) return;
        tx.touch(seasonKey(room.id, sid));
        var en = seasonEntry(room, sid), s = touched[sid];
        if (en) en.corrected = !!s.corrected;
      });
      return ops;
    }

    // Kotityöt jokaisen pyynnön alussa: kauden sulku/vaihto ja työn täsmäytys koko huoneelle.
    function house(tx, room, me, now) {
      if (!room) return [];
      var keys = room.order.slice();
      room.seasons.forEach(function (en) { if (en.state === "active" || now - en.endAt < 62 * 86400000) en.players.forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); }); });
      var others = keys.filter(function (k) { return k !== me.key; });
      var data = others.length ? (env.readSellers(others) || {}) : {};
      if (me.months) data[me.key] = { nickname: me.name, company: me.orgName, months: me.months };
      keys.forEach(function (k) { if (data[k]) observe(tx, room, k, data[k].months, now); });
      var myOps = [];
      // ensin työ kohdistetaan (myös juuri päättyneelle kaudelle), sitten sulku ja uusi kausi
      keys.forEach(function (k) { var ops = reconcileMember(tx, room, k, now); if (k === me.key) myOps = ops; });
      var closed = closeAndRoll(tx, room, now);
      if (closed && room.cur) keys.forEach(function (k) { var ops = reconcileMember(tx, room, k, now); if (k === me.key) myOps = myOps.concat(ops); });
      var s = curSeason(tx, room);
      if (s) s.order.forEach(function (k) { snapFor(tx, room, k, E.weekStart(now), s.rules, now); });
      tx.touch(roomKey(room.id));
      if (myOps.length) audit({ t: now, room: room.id, season: room.cur, nick: me.key, action: "work_reconcile", ok: true, info: JSON.stringify(myOps) });
      return myOps;
    }

    // ---------- Näkymä ----------
    function roomInfo(tx, room, me, now) {
      var rules = roomRules(room), s = curSeason(tx, room);
      var participants = s ? s.order : [];
      return {
        id: room.id, name: room.name, orgName: room.orgName, isAdmin: room.admin === me.key,
        adminName: room.members[room.admin] ? room.members[room.admin].name : "",
        members: room.order.map(function (k) { var m = room.members[k]; return { key: k, name: m.name, at: m.at, leaving: !!m.leaving, playing: participants.indexOf(k) !== -1 }; }),
        minPlayers: rules.minPlayers, maxPlayers: rules.maxPlayers,
        rulesNext: { startCash: rules.startCash, tilePrice: rules.tilePrice, classes: rules.classes, channels: rules.channels, work: rules.work, qPerTurn: rules.qPerTurn, boost: rules.boost, maxTiles: rules.maxTiles, slotsPerTile: rules.slotsPerTile },
        next: (function () {
          var sid = s ? E.nextSeasonId(s.id) : E.seasonIdOf(now);
          var b = E.seasonBounds(sid);
          return { id: sid, state: "planned", startAt: s ? b.start : null, endAt: b.end,
            participants: room.order.filter(function (k) { return !room.members[k].leaving; }).map(function (k) { return room.members[k].name; }) };
        })(),
        archive: room.seasons.filter(function (x) { return x.state === "closed"; }).map(function (x) {
          var sd = getSeason(tx, room, x.id);
          return { id: x.id, startAt: x.startAt, endAt: x.endAt, corrected: !!(sd && sd.corrected), top: sd && sd.results ? sd.results.rows.map(function (r) { return { name: r.name, rank: r.rank, result: r.result }; }) : [] };
        }).reverse()
      };
    }
    function seasonView(tx, room, s, me, now) {
      var v = E.view(s, me.key, now);
      if (v.me) {
        var ws = E.weekStart(now), sn = (room.snaps[me.key] || {})[ws] || null;
        v.me.hit = sn ? { rateBp: sn.rateBp, n: sn.n, k: sn.k, mult: sn.mult, weekStart: ws, nextAt: E.hkDayStart(ws, 7), minSample: s.rules.boostMinSample,
          windowDays: s.rules.hitWindowDays, minAgeDays: s.rules.hitMinAgeDays } : null;
        var mine = Object.keys(s.awards).map(function (k) { return s.awards[k]; }).filter(function (a) { return a.nick === me.key; })
          .sort(function (a, b) { return b.t - a.t; }).slice(0, 12)
          .map(function (a) { return { stage: a.stage, t: a.t, cents: a.cents, q: a.q, mult: a.mult, status: a.status }; });
        v.me.awards = mine;
        var mk = s.id, md = me.months && me.months[mk];
        v.me.goal = md && md.targetOffers ? { target: md.targetOffers } : null;
      }
      return v;
    }
    function buildView(tx, me, now, extra) {
      var ix = index(tx), room = getRoom(tx, ix.users[me.key]);
      var out = { ok: true, now: now, me: { key: me.key, name: me.name, orgName: me.orgName }, board: E.BOARD };
      if (room) {
        out.room = roomInfo(tx, room, me, now);
        var s = curSeason(tx, room);
        out.season = s ? seasonView(tx, room, s, me, now) : null;
      } else {
        out.room = null; out.season = null;
        out.rooms = Object.keys(ix.rooms).filter(function (id) { return ix.rooms[id].org === me.org; }).map(function (id) {
          var r = getRoom(tx, id); if (!r) return null;
          return { id: id, name: r.name, members: r.order.map(function (k) { return r.members[k].name; }), full: r.order.length >= roomRules(r).maxPlayers, active: !!r.cur };
        }).filter(Boolean);
      }
      if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
      return out;
    }

    // ---------- Komennot ----------
    function str(v, max) { v = String(v == null ? "" : v).trim(); return v.slice(0, max || 60); }
    function requireRoom(tx, me) {
      var room = getRoom(tx, index(tx).users[me.key]);
      if (!room) throw GE("NO_ROOM", "Et ole vielä pelihuoneessa.");
      if (room.org !== me.org) throw GE("FORBIDDEN", "Huone kuuluu toiseen organisaatioon.");
      return room;
    }
    function requireAdmin(tx, me) { var room = requireRoom(tx, me); if (room.admin !== me.key) throw GE("NOT_ADMIN", "Vain huoneen ylläpitäjä voi tehdä tämän."); return room; }
    function requireGame(tx, me, body) {
      var room = requireRoom(tx, me);
      if (body.roomId && body.roomId !== room.id) throw GE("FORBIDDEN", "Komento kohdistui toiseen huoneeseen.");
      var s = curSeason(tx, room);
      if (!s) throw GE("NO_SEASON", "Huoneessa ei ole käynnissä olevaa kautta.");
      if (body.seasonId && body.seasonId !== s.id) throw GE("SEASON_CHANGED", "Kausi on vaihtunut. Päivitä näkymä.");
      if (!s.players[me.key]) throw GE("NOT_PARTICIPANT", "Liityit kesken kauden. Pelaat seuraavalla kaudella.");
      tx.touch(seasonKey(room.id, s.id));
      return { room: room, s: s };
    }
    function validRules(r) {
      if (!r || typeof r !== "object") throw GE("BAD_RULES", "Virheelliset säännöt.");
      var out = {};
      function int(v, lo, hi, name) { v = Math.round(+v); if (!(v >= lo && v <= hi)) throw GE("BAD_RULES", "Arvo " + name + " ei kelpaa."); return v; }
      if (r.startCash != null) out.startCash = int(r.startCash, 100000, 1e10, "alkukassa");
      if (r.tilePrice != null) out.tilePrice = int(r.tilePrice, 100, 1e9, "tontin hinta");
      if (r.maxTiles != null) out.maxTiles = int(r.maxTiles, 1, 16, "tonttiraja");
      if (r.slotsPerTile != null) out.slotsPerTile = int(r.slotsPerTile, 1, 6, "autopaikat");
      if (r.qPerTurn != null) out.qPerTurn = int(r.qPerTurn, 1, 400, "pisteet per vuoro");
      if (r.classes) { out.classes = {}; ["DIESEL", "PETROL_HYBRID", "ELECTRIC"].forEach(function (c) { var x = r.classes[c]; if (x) out.classes[c] = { buy: int(x.buy, 100, 1e9, "hankintahinta"), margin: int(x.margin, 0, 1e9, "kate") }; }); }
      if (r.channels) { out.channels = {}; ["bank", "auction", "autovex", "wholesale"].forEach(function (c) { if (r.channels[c] != null) out.channels[c] = int(r.channels[c], 1000, 10000, "kanavaprosentti"); }); }
      if (r.work) { out.work = {}; ["offer", "deal", "handover"].forEach(function (k) { var x = r.work[k]; if (x) out.work[k] = { cents: int(x.cents, 0, 1e8, "palkkio"), q: int(x.q, 0, 400, "pisteet") }; }); }
      if (r.boost) {
        if (!Array.isArray(r.boost) || r.boost.length > 8) throw GE("BAD_RULES", "Virheellinen boostitaulukko.");
        out.boost = r.boost.map(function (b) { return { min: int(b.min, 0, 10000, "hitrate-raja"), mult: int(b.mult, 10000, 30000, "kerroin") }; }).sort(function (a, b) { return b.min - a.min; });
      }
      return out;
    }

    function exec(tx, action, body, me, now) {
      var ix = index(tx), g, t, r;
      switch (action) {
        case "mm_state": case "mm_sync": case "mm_rooms": return {};
        case "mm_archive": {
          var room = requireRoom(tx, me), sid = str(body.seasonId, 7), en = seasonEntry(room, sid);
          if (!en || en.state !== "closed") throw GE("NO_SEASON", "Kautta ei löydy arkistosta.");
          return { archive: E.view(getSeason(tx, room, sid), me.key, now) };
        }
        case "mm_room_create": {
          if (ix.users[me.key]) throw GE("HAS_ROOM", "Olet jo pelihuoneessa.");
          var name = str(body.name, 40) || "Myyntimonopoli";
          ix.seq++;
          var id = "R" + ix.seq + "-" + (1000 + env.rng(9000));
          var room2 = { id: id, org: me.org, orgName: me.orgName, name: name, admin: me.key, created: now, members: {}, order: [], rules: null, cur: null, seasons: [], reg: {}, awardIdx: {}, snaps: {}, idem: {} };
          room2.members[me.key] = { name: me.name, at: now }; room2.order.push(me.key);
          ix.rooms[id] = { org: me.org, name: name }; ix.users[me.key] = id;
          tx.put(roomKey(id), room2); tx.touch(INDEX);
          return { roomId: id };
        }
        case "mm_room_join": {
          if (ix.users[me.key]) throw GE("HAS_ROOM", "Olet jo pelihuoneessa. Yksi aktiivinen huone kerrallaan.");
          var rid = str(body.roomId, 30), room3 = getRoom(tx, rid);
          if (!room3 || !ix.rooms[rid]) throw GE("NO_ROOM", "Huonetta ei löydy.");
          if (room3.org !== me.org) throw GE("FORBIDDEN", "Huone kuuluu toiseen organisaatioon.");
          if (room3.order.length >= roomRules(room3).maxPlayers) throw GE("ROOM_FULL", "Huone on täynnä (" + roomRules(room3).maxPlayers + " pelaajaa).");
          room3.members[me.key] = { name: me.name, at: now }; room3.order.push(me.key);
          ix.users[me.key] = rid; tx.touch(INDEX); tx.touch(roomKey(rid));
          return { roomId: rid, waitsNext: !!room3.cur };
        }
        case "mm_room_leave": {
          var room4 = requireRoom(tx, me), s4 = curSeason(tx, room4);
          if (s4 && s4.players[me.key]) {
            room4.members[me.key].leaving = !room4.members[me.key].leaving;
            return { leaving: room4.members[me.key].leaving };
          }
          removeMember(tx, room4, me.key);
          if (!room4.order.length) { /* tyhjä huone jää arkistoksi */ }
          return { left: true };
        }
        case "mm_room_remove": {
          var room5 = requireAdmin(tx, me), k5 = nickKey(body.member), s5 = curSeason(tx, room5);
          if (!room5.members[k5] || k5 === me.key) throw GE("NO_MEMBER", "Jäsentä ei löydy.");
          if (s5 && s5.players[k5]) { room5.members[k5].leaving = true; return { leaving: true }; }
          removeMember(tx, room5, k5);
          return { removed: true };
        }
        case "mm_room_start": {
          var room6 = requireAdmin(tx, me);
          if (room6.cur) throw GE("HAS_SEASON", "Kausi on jo käynnissä.");
          var cnt = room6.order.filter(function (k) { return !room6.members[k].leaving; }).length;
          if (cnt < roomRules(room6).minPlayers) throw GE("FEW_PLAYERS", "Kauden aloittamiseen tarvitaan vähintään " + roomRules(room6).minPlayers + " pelaajaa.");
          var sid6 = E.seasonIdOf(now);
          if (seasonEntry(room6, sid6)) throw GE("HAS_SEASON", "Tämän kuukauden kausi on jo pelattu. Seuraava alkaa kuun vaihtuessa.");
          // kaikkien jäsenten työdata luetaan ennen alkua, jotta vanhat työt eivät näy uusina
          var s6 = startSeason(tx, room6, now, sid6, now);
          s6.order.forEach(function (k) { snapFor(tx, room6, k, E.weekStart(now), s6.rules, now); });
          return { seasonId: sid6 };
        }
        case "mm_room_rules": {
          var room7 = requireAdmin(tx, me);
          var nr = body.reset ? null : E.mergeRules(room7.rules || {}, validRules(body.rules));
          if (nr) delete nr.version;
          room7.rules = nr;
          return { rules: roomRules(room7) };
        }
        // ---- pelikomennot ----
        case "mm_roll":
          g = requireGame(tx, me, body);
          t = E.roll(g.s, me.key, now, env.rng);
          return { turn: t };
        case "mm_buy_tile":
          g = requireGame(tx, me, body);
          return E.buyTile(g.s, me.key, now, str(body.turnId, 12));
        case "mm_bank_buy":
          g = requireGame(tx, me, body);
          return E.bankBuy(g.s, me.key, now, str(body.turnId, 12), body.tile | 0, str(body.cls, 20));
        case "mm_move":
          g = requireGame(tx, me, body);
          return E.moveCar(g.s, me.key, now, str(body.turnId, 12), str(body.carId, 12), body.dest === "recv" ? "recv" : (body.dest | 0));
        case "mm_list":
          g = requireGame(tx, me, body);
          return E.listAutovex(g.s, me.key, now, str(body.turnId, 12), str(body.carId, 12));
        case "mm_cancel_list":
          g = requireGame(tx, me, body);
          return E.cancelListing(g.s, me.key, now);
        case "mm_sell_bank":
          g = requireGame(tx, me, body);
          return E.sellBank(g.s, me.key, now, str(body.turnId, 12), str(body.carId, 12));
        case "mm_sell_auction":
          g = requireGame(tx, me, body);
          return E.sellAuction(g.s, me.key, now, str(body.turnId, 12), str(body.carId, 12));
        case "mm_wholesale":
          g = requireGame(tx, me, body);
          return E.wholesale(g.s, me.key, now, str(body.carId, 12));
        case "mm_end_turn":
          g = requireGame(tx, me, body);
          r = E.endTurn(g.s, me.key, now, str(body.turnId, 12));
          return { turn: r };
      }
      throw GE("UNKNOWN", "Tuntematon toiminto.");
    }

    function handle(body) {
      body = body || {};
      var action = String(body.action || "");
      var spec = ACTIONS[action];
      if (!spec) return err("unknown_action", "Tuntematon toiminto.");
      var who;
      try { who = env.authenticate(String(body.nickname || ""), String(body.pin || "")); } catch (e) { who = { ok: false, error: "auth_error" }; }
      if (!who || !who.ok) return err((who && who.error) || "auth", "Kirjautuminen epäonnistui.");
      var me = { key: nickKey(who.nickname), name: String(who.nickname), org: orgKey(who.company), orgName: String(who.company || "").trim(), months: who.months || null };
      if (!me.org) return err("no_company", "Profiilissa ei ole yritystä. Lisää yritys tarjousseurannan asetuksissa, jotta voit pelata työkavereiden kanssa.");
      var idem = spec.m ? str(body.idem, 64) : "";
      if (spec.m && !idem) return err("idem_required", "Pyynnöltä puuttuu tunniste.");
      try { return env.withLock(function () {
        var now = env.now(), tx = new Tx();
        var ix = index(tx), room = getRoom(tx, ix.users[me.key]);
        if (room && !room.members[me.key]) { delete ix.users[me.key]; tx.touch(INDEX); room = null; }
        var ops = house(tx, room, me, now);
        // idempotenssi: sama avain palauttaa saman tuloksen muuttamatta mitään uudestaan
        var ikey = me.key + "|" + idem;
        var hit = idem ? ((room && room.idem[ikey]) || (ix.idem && ix.idem[ikey])) : null;
        if (hit) {
          tx.commit();
          var prev = hit.r;
          return buildView(tx, me, now, { result: prev.result, error: prev.error, message: prev.message, ok: prev.ok, replay: true, ops: ops });
        }
        var sn = tx.snapshot(), res, okRes = true, e1 = null;
        try { res = exec(tx, action, body, me, now); }
        catch (e) {
          if (!e || !e.isGameError) throw e;
          tx.restore(sn); okRes = false; e1 = e;
        }
        // pelikomennot tallennetaan huoneeseen, huoneen hallinta hakemistoon
        var ix2 = index(tx), room2 = getRoom(tx, ix2.users[me.key]) || room;
        var istore = spec.g && room2 ? room2.idem : (ix2.idem || (ix2.idem = {}));
        if (idem) {
          istore[ikey] = { t: now, r: okRes ? { ok: true, result: res } : { ok: false, error: e1.code, message: e1.message } };
          var ks = Object.keys(istore).sort(function (a, b) { return istore[a].t - istore[b].t; });
          ks.forEach(function (k, i) { if (now - istore[k].t > IDEM_TTL || ks.length - i > IDEM_MAX) delete istore[k]; });
          if (spec.g && room2) tx.touch(roomKey(room2.id)); else tx.touch(INDEX);
        }
        tx.commit();
        if (spec.m) audit({ t: now, room: room2 ? room2.id : null, season: room2 ? room2.cur : null, nick: me.key, action: action, idem: idem, ok: okRes,
          info: okRes ? JSON.stringify(res).slice(0, 2000) : e1.code });
        if (!okRes) return buildView(tx, me, now, { ok: false, error: e1.code, message: e1.message, ops: ops });
        return buildView(tx, me, now, { result: res, ops: ops });
      }); } catch (e) {
        if (e && e.mmBusy) return err("busy", "Palvelin on hetken varattu. Yritä uudelleen.");
        audit({ t: Date.now(), room: null, season: null, nick: me.key, action: action, ok: false, info: "server_error " + (e && e.message) });
        return err("server_error", "Palvelinvirhe. Mitään ei muutettu.");
      }
    }

    // Ajastettu ylläpito: kausien sulku ja vaihto sekä työn täsmäytys kaikille huoneille.
    function maintenance() {
      return env.withLock(function () {
        var now = env.now(), tx = new Tx(), ix = index(tx), done = [];
        Object.keys(ix.rooms).forEach(function (id) {
          var room = getRoom(tx, id); if (!room) return;
          house(tx, room, { key: "\u0000system", name: "", org: room.org, orgName: room.orgName, months: null }, now);
          done.push(id);
        });
        tx.commit();
        return { ok: true, rooms: done.length, now: now };
      });
    }

    return { handle: handle, maintenance: maintenance };
  }

  return { create: create, ACTIONS: ACTIONS, nickKey: nickKey, orgKey: orgKey, TOL: TOL };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MMServer;

// ===== gas.js =====
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
