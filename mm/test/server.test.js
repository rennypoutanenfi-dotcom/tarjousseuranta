// Palvelimen testit: komennot, käyttöoikeudet, idempotenssi, pysyvyys ja tarjousseurannan työtapahtumat.
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../engine.js");
const S = require("../server.js");
const H = require("./helpers.js");
const { makeEnv, memStore, seller, addOffer, closeDeal, reopen, handover, del, call } = H;

const EUR = (e) => Math.round(e * 100);
const HOUR = 3600000, DAY = 86400000;

function setupRoom(names, opts) {
  const env = makeEnv(opts);
  names.forEach((n) => seller(env, n, "Saka Nummela"));
  let r = call(env, names[0], "mm_room_create", { name: "Nummelan halli" });
  assert.ok(r.ok, JSON.stringify(r));
  const roomId = r.room.id;
  names.slice(1).forEach((n) => { const j = call(env, n, "mm_room_join", { roomId }); assert.ok(j.ok, JSON.stringify(j)); });
  r = call(env, names[0], "mm_room_start", {});
  assert.ok(r.ok, JSON.stringify(r));
  return { env, roomId };
}
function cash(env, nick) { const v = call(env, nick, "mm_state"); return v.season.me.cash; }
function work(env, nick) { return call(env, nick, "mm_state").season.me.work; }

test("Työpalkkiot syntyvät tarjousseurannan datasta ilman pelikirjausta; vanhoista töistä ei takautuvaa rahaa", () => {
  const env = makeEnv();
  const a = seller(env, "Renny", "Saka Nummela"), b = seller(env, "Aino", "Saka Nummela");
  // vanhat työt ennen huonetta
  for (let i = 0; i < 6; i++) addOffer(a, env.clock - 5 * DAY + i * HOUR);
  let r = call(env, "Renny", "mm_room_create", { name: "Halli" });
  call(env, "Aino", "mm_room_join", { roomId: r.room.id });
  env.clock += HOUR;
  r = call(env, "Renny", "mm_room_start", {});
  assert.equal(r.season.me.cash, EUR(500000));
  env.clock += HOUR;
  // viisi uutta tarjousta seurantaan
  for (let i = 0; i < 5; i++) addOffer(a, env.clock - 10 * 60000);
  r = call(env, "Renny", "mm_state");
  assert.equal(r.season.me.cash, EUR(502500));
  assert.equal(r.season.me.work.avail, 1);
  assert.equal(r.ops.filter((o) => o.op === "grant").length, 5);
  // Toinen pelaaja näkee saman tilanteen, mutta ei Rennyn kassaa
  const v = call(env, "Aino", "mm_state");
  const rp = v.season.players.find((p) => p.nick === "renny");
  assert.equal(rp.cash, null);
  assert.equal(rp.nw, EUR(502500));
  // Toistuva synkronointi ei anna uudestaan
  r = call(env, "Renny", "mm_sync");
  assert.equal(r.ops.length, 0);
  assert.equal(r.season.me.cash, EUR(502500));
});

test("Kauppa, uudelleenavaus, palautus ja luovutus tarjousseurannan kautta; poisto korjaa pisteet", () => {
  const { env } = setupRoom(["Renny", "Aino"]);
  const a = env.sellers.renny;
  env.clock += HOUR;
  const os = [];
  for (let i = 0; i < 5; i++) os.push(addOffer(a, env.clock));
  call(env, "Renny", "mm_sync");
  closeDeal(os[0], env.clock + 1000);
  let r = call(env, "Renny", "mm_sync");
  assert.deepEqual(r.ops.map((o) => o.op), ["grant"]);
  assert.equal(r.season.me.cash, EUR(500000 + 2500 + 5000)); // otos < 20 -> kerroin 1,00
  assert.equal(r.season.me.work.q, 36);
  reopen(os[0]);
  r = call(env, "Renny", "mm_sync");
  assert.equal(r.season.me.cash, EUR(502500));
  assert.equal(r.season.me.work.q, 36); // pisteet säilyvät
  closeDeal(os[0], env.clock + 5000);
  r = call(env, "Renny", "mm_sync");
  assert.equal(r.season.me.cash, EUR(507500));
  assert.equal(r.season.me.work.q, 36); // ei uusia pisteitä
  handover(os[0], env.clock + 6000);
  r = call(env, "Renny", "mm_sync");
  assert.equal(r.season.me.cash, EUR(507600));
  assert.equal(r.season.me.work.q, 37);
  // Kollegan hoitama luovutus ei anna palkkiota tälle myyjälle
  closeDeal(os[1], env.clock + 7000);
  os[1].lv = { c: 63, ts: new Date(env.clock + 8000).toISOString(), x: 1 };
  r = call(env, "Renny", "mm_sync");
  assert.equal(r.season.me.work.handovers, 1);
  // Keskeneräinen tarkistuslista ei anna palkkiota
  closeDeal(os[2], env.clock + 9000);
  os[2].lv = { c: 31, ts: new Date(env.clock + 9500).toISOString() };
  r = call(env, "Renny", "mm_sync");
  assert.equal(r.season.me.work.handovers, 1);
  // Poistettu tarjous: tarjouspalkkio ja pisteet korjataan
  const q0 = r.season.me.work.q, c0 = r.season.me.cash;
  del(a, os[4]);
  r = call(env, "Renny", "mm_sync");
  assert.equal(r.season.me.work.q, q0 - 4);
  assert.equal(r.season.me.cash, c0 - EUR(500));
  // Massakirjaus (Lisää kuukausi) ei anna palkkioita
  addOffer(a, env.clock, { bk: 1 });
  r = call(env, "Renny", "mm_sync");
  assert.equal(r.ops.length, 0);
});

test("11. Sama heittopyyntö uusittuna palauttaa samat nopat ja saman auton; kaksi heittoa yhdellä oikeudella ei käytä kahta vuoroa", () => {
  const { env } = setupRoom(["Renny", "Aino"]);
  const a = env.sellers.renny, b = env.sellers.aino;
  env.clock += HOUR;
  // Aino rakentaa liikkeen ruutuun 3 kolmella autolla
  for (let i = 0; i < 20; i++) addOffer(b, env.clock);
  call(env, "Aino", "mm_sync");
  env.rngQueue = [0, 1]; // 1 + 2 = 3
  let r = call(env, "Aino", "mm_roll", {});
  assert.equal(r.result.turn.to, 3);
  const tid = r.result.turn.id;
  assert.ok(call(env, "Aino", "mm_buy_tile", { turnId: tid }).ok);
  assert.ok(call(env, "Aino", "mm_bank_buy", { turnId: tid, tile: 3, cls: "DIESEL" }).ok);
  for (const cls of ["PETROL_HYBRID", "ELECTRIC"]) {
    env.rngQueue = [5, 5]; // 12 askelta -> 15 tai 3
    r = call(env, "Aino", "mm_roll", {});
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(call(env, "Aino", "mm_bank_buy", { turnId: r.result.turn.id, tile: 3, cls }).ok);
  }
  call(env, "Aino", "mm_end_turn", { turnId: r.result.turn.id });
  // Renny: yksi vuoro
  for (let i = 0; i < 5; i++) addOffer(a, env.clock);
  call(env, "Renny", "mm_sync");
  env.rngQueue = [0, 1, 2]; // 1 + 2 -> ruutu 3, arvonta: kolmas auto
  const r1 = call(env, "Renny", "mm_roll", {}, "same-roll");
  assert.ok(r1.ok, JSON.stringify(r1));
  const f1 = r1.result.turn.forced;
  assert.equal(f1.candidates.length, 3);
  env.rngQueue = [3, 3, 0]; // eri satunnaisuus: uusinnan ei pidä käyttää sitä
  const r2 = call(env, "Renny", "mm_roll", {}, "same-roll");
  assert.equal(r2.replay, true);
  assert.deepEqual([r2.result.turn.d1, r2.result.turn.d2], [r1.result.turn.d1, r1.result.turn.d2]);
  assert.equal(r2.result.turn.forced.carId, f1.carId);
  assert.equal(r2.season.me.work.used, 1);
  assert.equal(r2.season.me.cash, r1.season.me.cash);
  // Toinen heittopyyntö eri avaimella: ei oikeutta -> ei muutosta
  const r3 = call(env, "Renny", "mm_roll", {}, "other-roll");
  assert.equal(r3.ok, false); assert.equal(r3.error, "NO_TURNS");
  assert.equal(r3.season.me.work.used, 1);
  assert.equal(r3.season.me.pos, 3);
  assert.equal(r3.season.me.openTurn.id, r1.result.turn.id); // epäonnistunut heitto ei päättänyt avointa vuoroa
});

test("21. Toisen organisaation huoneeseen ei voi liittyä eikä pelaaja voi lähettää omaa palkkiota tai muokata saldoja", () => {
  const { env, roomId } = setupRoom(["Renny", "Aino"]);
  seller(env, "Vieras", "Toinen Autoliike");
  let r = call(env, "Vieras", "mm_room_join", { roomId });
  assert.equal(r.ok, false); assert.equal(r.error, "FORBIDDEN");
  r = call(env, "Vieras", "mm_state");
  assert.deepEqual(r.rooms, []); // ei näe toisen organisaation huoneita
  // Väärä PIN
  r = env.server.handle({ action: "mm_state", nickname: "Renny", pin: "0000" });
  assert.equal(r.ok, false); assert.equal(r.error, "bad_pin");
  // Itse keksitty palkkio: tuntematon toiminto ja ylimääräiset kentät ohitetaan
  r = call(env, "Renny", "mm_award", { cents: 99999999 });
  assert.equal(r.error, "unknown_action");
  const before = cash(env, "Renny");
  r = call(env, "Renny", "mm_sync", { cents: 99999999, stage: "deal", nick: "renny", months: { "2026-11": { offers: [{ id: "fake", ts: new Date(env.clock).toISOString() }] } } });
  assert.equal(r.season.me.cash, before);
  // Toisen pelaajan auton myynti tai siirto estyy
  for (let i = 0; i < 10; i++) addOffer(env.sellers.aino, env.clock + 60000);
  env.clock += 2 * 60000;
  call(env, "Aino", "mm_sync");
  env.rngQueue = [0, 0];
  const t = call(env, "Aino", "mm_roll", {}).result.turn;
  call(env, "Aino", "mm_buy_tile", { turnId: t.id });
  const car = call(env, "Aino", "mm_bank_buy", { turnId: t.id, tile: 2, cls: "DIESEL" }).result.carId;
  r = call(env, "Renny", "mm_wholesale", { carId: car });
  assert.equal(r.ok, false); assert.equal(r.error, "NOT_OWNER");
  // Kohdistus toiseen huoneeseen estyy
  r = call(env, "Aino", "mm_end_turn", { turnId: t.id, roomId: "R999-1234" });
  assert.equal(r.error, "FORBIDDEN");
  // Tavallinen jäsen ei voi muuttaa sääntöjä
  r = call(env, "Aino", "mm_room_rules", { rules: { startCash: 1e9 } });
  assert.equal(r.error, "NOT_ADMIN");
  // Yritys puuttuu -> ei peliä
  seller(env, "Tyhja", "");
  r = call(env, "Tyhja", "mm_state");
  assert.equal(r.error, "no_company");
});

test("22. Pelitila säilyy palvelimen uudelleenkäynnistyksen ja uudelleenkirjautumisen yli kahdella käyttäjällä", () => {
  const store = memStore();
  const { env } = setupRoom(["Renny", "Aino"], { store });
  for (let i = 0; i < 5; i++) addOffer(env.sellers.renny, env.clock + 1000);
  env.clock += 2000;
  env.rngQueue = [0, 1]; // ruutu 3
  const t = call(env, "Renny", "mm_roll", {});
  assert.ok(t.ok);
  call(env, "Renny", "mm_buy_tile", { turnId: t.result.turn.id });
  const v1 = call(env, "Aino", "mm_state");
  // "Uudelleenkäynnistys": uusi palvelininstanssi samalla tallennuksella
  const env2 = makeEnv({ store, clock: env.clock + 1000, sellers: env.sellers });
  const v2 = H.call(env2, "Aino", "mm_state");
  assert.deepEqual(v2.season.tiles, v1.season.tiles);
  assert.deepEqual(v2.season.players.map((p) => [p.nick, p.pos, p.nw]), v1.season.players.map((p) => [p.nick, p.pos, p.nw]));
  const r2 = H.call(env2, "Renny", "mm_state");
  assert.equal(r2.season.me.cash, EUR(502500 - 50000));
  assert.equal(r2.season.me.openTurn.id, t.result.turn.id); // avoin vuoro jatkuu
  assert.ok(H.call(env2, "Renny", "mm_end_turn", { turnId: t.result.turn.id }).ok);
});

test("Kausi sulkeutuu kuun vaihteessa Helsingin aikaa, arkisto säilyy ja uusi kausi alkaa uusin varoin", () => {
  const { env } = setupRoom(["Renny", "Aino"]);
  const a = env.sellers.renny;
  for (let i = 0; i < 10; i++) addOffer(a, env.clock + 1000);
  env.clock += 2000;
  call(env, "Renny", "mm_sync");
  env.rngQueue = [0, 0];
  let t = call(env, "Renny", "mm_roll", {}).result.turn;
  call(env, "Renny", "mm_buy_tile", { turnId: t.id });
  // työ juuri ennen keskiyötä 30.11. klo 23:59 Helsinki = 21:59Z, havaittu vasta 1.12. klo 00:05
  const late = Date.UTC(2026, 10, 30, 21, 59);
  addOffer(a, late);
  env.clock = Date.UTC(2026, 10, 30, 22, 5);
  let r = call(env, "Renny", "mm_state");
  assert.equal(r.season.id, "2026-12");
  assert.equal(r.season.me.cash, EUR(500000));
  assert.equal(r.season.me.work.q, 0);
  const arch = r.room.archive.find((x) => x.id === "2026-11");
  assert.ok(arch);
  const ar = call(env, "Renny", "mm_archive", { seasonId: "2026-11" }).result.archive;
  assert.equal(ar.state, "closed");
  // marraskuun 11. tarjous kuului marraskuulle
  assert.equal(ar.me.work.offers, 11);
  assert.equal(ar.me.openTurn, null);
  assert.equal(ar.me.expired, 1); // 11 tarjousta = 2 vuoroa, 1 käytetty -> 1 raukesi
  assert.equal(ar.me.worth.result, EUR(5500)); // 11 × 500 €, tontti ei muuta nettovarallisuutta
  // vanhan kauden komento estyy
  r = call(env, "Renny", "mm_end_turn", { turnId: t.id });
  assert.equal(r.ok, false);
  // joulukuun työ kuuluu joulukuulle
  addOffer(a, env.clock + 1000);
  env.clock += 2000;
  r = call(env, "Renny", "mm_sync");
  assert.equal(r.season.me.cash, EUR(500500));
  // myöhässä tullut marraskuun kauppa korjaa suljetun kauden tuloksen
  const nov = a.months["2026-11"].offers[0];
  closeDeal(nov, Date.UTC(2026, 10, 30, 21, 0));
  r = call(env, "Renny", "mm_sync");
  const ar2 = call(env, "Renny", "mm_archive", { seasonId: "2026-11" }).result.archive;
  assert.equal(ar2.corrected, true);
  assert.equal(ar2.me.worth.result, EUR(10500));
  assert.equal(r.season.me.cash, EUR(500500));
  assert.equal(r.room.archive[0].corrected, true);
});

test("Hitrate-snapshot lukitaan viikoksi, ja kaupan kerroin tallennetaan palkkioon", () => {
  const env = makeEnv({ clock: Date.UTC(2026, 10, 10, 8, 0) });
  const a = seller(env, "Renny", "Saka Nummela"); seller(env, "Aino", "Saka Nummela");
  // historiaa: 20 tarjousta syys–lokakuulta, 7 kauppaa -> 35 %
  for (let i = 0; i < 20; i++) {
    const o = addOffer(a, Date.UTC(2026, 9, 1 + i, 8, 0));
    if (i < 7) closeDeal(o, Date.UTC(2026, 9, 2 + i, 8, 0));
  }
  const rid = call(env, "Renny", "mm_room_create", {}).room.id;
  call(env, "Aino", "mm_room_join", { roomId: rid });
  let r = call(env, "Renny", "mm_room_start", {});
  assert.equal(r.season.me.hit.mult, 12500);
  assert.equal(r.season.me.hit.n, 20);
  assert.equal(r.season.me.hit.k, 7);
  assert.equal(r.season.me.hit.weekStart, E.weekStart(env.clock));
  // uusi kauppa saman viikon aikana -> 6 250 €
  env.clock += HOUR;
  const o = addOffer(a, env.clock); closeDeal(o, env.clock + 1000);
  env.clock += 2000;
  r = call(env, "Renny", "mm_sync");
  const deal = r.season.me.awards.find((x) => x.stage === "deal");
  assert.equal(deal.cents, EUR(6250)); assert.equal(deal.mult, 12500);
  // historia muuttuu (kauppoja avataan) -> saman viikon kerroin ei muutu, jo maksettu palkkio säilyy
  a.months["2026-10"].offers.slice(0, 5).forEach(reopen);
  r = call(env, "Renny", "mm_sync");
  assert.equal(r.season.me.hit.mult, 12500);
  // seuraavalla viikolla uusi snapshot
  env.clock = Date.UTC(2026, 10, 16, 23, 0); // ti 17.11. 01:00 Helsinki
  r = call(env, "Renny", "mm_sync");
  assert.ok(r.season.me.hit.weekStart > deal.t);
  assert.equal(r.season.me.awards.find((x) => x.stage === "deal").cents, EUR(6250));
});

test("Vanhan tiivistetyn kuukauden päiväsummat otetaan hitraten otokseen, mutta niistä ei makseta palkkioita", () => {
  const A = require("../adapter.js");
  const months = {
    "2026-10": { monthKey: "2026-10", offers: [], bySourceCounts: [{ sourceId: 1, offerCount: 6, dealCount: 3 }],
      days: { "5": [3, 1], "6": [3, 2] },
      carry: [{ id: "c1", ts: "2026-10-05T08:00:00.000Z", closed: false, st: "o" }],
      lost: [{ id: "l1", ts: "2026-10-06T08:00:00.000Z", lt: "2026-10-07T08:00:00.000Z", st: "l" }] },
    "2026-11": { monthKey: "2026-11", offers: [{ id: "n1", ts: "2026-11-02T08:00:00.000Z", closed: true, closedTs: "2026-11-03T08:00:00.000Z", st: "d", lv: { c: 63, ts: "2026-11-04T08:00:00.000Z" } }], del: ["zz"] }
  };
  const x = A.extract(months, E);
  assert.deepEqual(Object.keys(x.cases).sort(), ["c1", "l1", "n1"]);
  assert.equal(x.pseudo.length, 4); // 6 tarjousta - siirtynyt - hävitty = 4 kuukauden aikana kaupaksi tullutta
  assert.ok(x.pseudo.every((p) => p.d === E.hkToUtc(2026, 11, 1, 0, 0) - 60000));
  assert.equal(x.cases.n1.h, Date.parse("2026-11-04T08:00:00.000Z"));
  assert.ok(x.del.zz);
  const ev = A.events("renny", months, E);
  assert.equal(ev.length, 9);
  const hv = ev.find((e) => e.caseId === "n1" && e.stage === "handover");
  assert.equal(hv.source, "tarjousseuranta"); assert.equal(hv.valid, true);
  assert.equal(hv.eventId, "tarjousseuranta:renny:n1:handover");
});

test("Huoneen hallinta: yksi huone kerrallaan, kesken kauden liittyvä pelaa seuraavalla kaudella, poistuminen kauden lopussa", () => {
  const { env, roomId } = setupRoom(["Renny", "Aino"]);
  seller(env, "Mikko", "saka nummela "); // sama organisaatio kirjainkoosta ja välilyönneistä riippumatta
  let r = call(env, "Mikko", "mm_state");
  assert.equal(r.rooms.length, 1);
  r = call(env, "Mikko", "mm_room_join", { roomId });
  assert.ok(r.ok);
  assert.equal(r.room.members.find((m) => m.key === "mikko").playing, false);
  assert.equal(r.season.me, undefined);
  r = call(env, "Mikko", "mm_roll", {});
  assert.equal(r.error, "NOT_PARTICIPANT");
  r = call(env, "Mikko", "mm_room_create", {});
  assert.equal(r.error, "HAS_ROOM");
  // Aino ilmoittaa poistuvansa kauden lopussa
  r = call(env, "Aino", "mm_room_leave", {});
  assert.equal(r.result.leaving, true);
  env.clock = Date.UTC(2026, 11, 1, 10, 0);
  r = call(env, "Mikko", "mm_state");
  assert.equal(r.season.id, "2026-12");
  assert.deepEqual(r.season.players.map((p) => p.nick).sort(), ["mikko", "renny"]);
  r = call(env, "Aino", "mm_state");
  assert.equal(r.room, null);
  // Ylläpitäjä muuttaa seuraavan kauden sääntöjä: nykyinen kausi ei muutu
  r = call(env, "Renny", "mm_room_rules", { rules: { startCash: EUR(400000), work: { offer: { cents: EUR(600), q: 4 } } } });
  assert.ok(r.ok);
  assert.equal(r.season.rules.startCash, EUR(500000));
  assert.equal(r.room.rulesNext.startCash, EUR(400000));
  env.clock = Date.UTC(2027, 0, 1, 10, 0);
  r = call(env, "Renny", "mm_state");
  assert.equal(r.season.id, "2027-01");
  assert.equal(r.season.me.cash, EUR(400000));
  assert.equal(r.season.rules.work.offer.cents, EUR(600));
});

test("Idempotenssiavain vaaditaan rahaa, vuoroja tai omistuksia muuttavilta komennoilta", () => {
  const { env } = setupRoom(["Renny", "Aino"]);
  const r = env.server.handle({ action: "mm_roll", nickname: "Renny", pin: "1234" });
  assert.equal(r.error, "idem_required");
});

test("Ajastettu ylläpito sulkee kauden ja täsmäyttää työn ilman käyttäjän pyyntöä", () => {
  const { env } = setupRoom(["Renny", "Aino"]);
  addOffer(env.sellers.aino, env.clock + 1000);
  env.clock += 5000;
  let m = env.server.maintenance();
  assert.equal(m.rooms, 1);
  env.clock = Date.UTC(2026, 11, 1, 0, 30);
  m = env.server.maintenance();
  const r = call(env, "Aino", "mm_archive", { seasonId: "2026-11" });
  assert.equal(r.result.archive.me.work.offers, 1);
  assert.ok(env.auditLog.some((e) => e.action === "season_close"));
});
