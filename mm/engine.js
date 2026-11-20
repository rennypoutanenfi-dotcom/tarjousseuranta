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
