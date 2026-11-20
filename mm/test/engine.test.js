// Pelimoottorin testit: node --test mm/test
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../engine.js");

const EUR = (e) => Math.round(e * 100);
const T0 = Date.UTC(2026, 10, 2, 8, 0); // 2.11.2026 10:00 Helsinki

function season(names, opts) {
  const s = E.newSeason(Object.assign({ id: "2026-11", roomId: "R1", participants: names.map((n) => ({ nick: n, joinedAt: Date.UTC(2026, 9, 31, 22, 0) })) }, opts || {}));
  return s;
}
let caseSeq = 0;
function grant(s, nick, stage, n, mult, t) { for (let i = 0; i < n; i++) E.grantAward(s, t || T0, nick, stage, "c" + (++caseSeq), t || T0, mult); }
function giveTurns(s, nick, n) { grant(s, nick, "offer", 5 * n); }
// Ohjattava satunnaisuus: palauttaa jonon arvot järjestyksessä ja tallentaa kysytyt n:t.
function seq(values) { const asked = []; const f = (n) => { asked.push(n); const v = values.length ? values.shift() : 0; assert.ok(v >= 0 && v < n, "rng out of range " + v + "/" + n); return v; }; f.asked = asked; return f; }
// Testin alkuasetus: pelaaja asetetaan kaksi ruutua ennen kohdetta ja heittää 1 + 1.
// Näin heitto ei pysähdy välissä muille ruuduille. o.rng = arvontaa varten lisäarvot.
function landOn(s, nick, idx, o) {
  o = o || {};
  s.players[nick].pos = (idx - 2 + 24) % 24;
  if (!o.noGrant) giveTurns(s, nick, 1);
  const t = E.roll(s, nick, o.now || T0, seq([0, 0].concat(o.rng || [])));
  assert.equal(s.players[nick].pos, idx);
  return t;
}
function neutralTurn(s, nick, o) { return landOn(s, nick, 0, o); } // Lähtö: ei seurauksia
function adjustCash(s, nick, target) {
  const p = s.players[nick], d = target - p.cash;
  p.cash = target;
  s.ledger.push({ i: 100000 + s.ledger.length, t: T0, nick, k: "test_adjust", dc: d, dd: 0 });
}
function audit(s) { const a = E.auditBalances(s); assert.ok(a.ok, "kirjanpito ei täsmää: " + JSON.stringify(a.diff)); }

test("1. Viisi aitoa tarjousta antaa 2 500 € ja yhden vuoron", () => {
  const s = season(["A", "B"]);
  grant(s, "A", "offer", 5);
  const w = E.workStatus(s, "A", T0);
  assert.equal(s.players.A.cash, EUR(500000 + 2500));
  assert.equal(w.avail, 1);
  assert.equal(w.q, 20);
  audit(s);
});

test("2. 20 luovutusta antaa 2 000 € ja yhden vuoron; yksi luovutus on 0,25 pistettä", () => {
  const s = season(["A", "B"]);
  grant(s, "A", "handover", 1);
  assert.equal(E.workStatus(s, "A", T0).q, 1);
  assert.equal(E.fmtPts(1), "0,25");
  grant(s, "A", "handover", 19);
  const w = E.workStatus(s, "A", T0);
  assert.equal(s.players.A.cash, EUR(500000 + 2000));
  assert.equal(w.avail, 1);
  audit(s);
});

test("3. 5 tarjousta, 2 kauppaa, 1 luovutus 30 %:n hitratella", () => {
  const s = season(["A", "B"]);
  grant(s, "A", "offer", 5); grant(s, "A", "deal", 2, 12000); grant(s, "A", "handover", 1);
  const w = E.workStatus(s, "A", T0);
  assert.equal(s.players.A.cash - EUR(500000), EUR(14600));
  assert.equal(w.q, 53); assert.equal(E.fmtPts(w.q), "13,25");
  assert.equal(w.avail, 2);
  assert.equal(w.q % 20, 13); assert.equal(E.fmtPts(w.q % 20), "3,25");
  assert.equal(w.toNext, 7); assert.equal(E.fmtPts(w.toNext), "1,75");
  audit(s);
});

test("4. 100 tarjousta, 20 kauppaa, 20 luovutusta kertoimella 1,20", () => {
  const s = season(["A", "B"]);
  grant(s, "A", "offer", 100); grant(s, "A", "deal", 20, 12000); grant(s, "A", "handover", 20);
  const w = E.workStatus(s, "A", T0);
  assert.equal(s.players.A.cash - EUR(500000), EUR(172000));
  assert.equal(w.avail, 37);
  audit(s);
});

test("5. Hitrate-rajat 20/25/30/35 % ja alle 20 tapauksen otos", () => {
  const snap = E.weekStart(Date.UTC(2026, 10, 18, 12, 0)); // ma 16.11.2026 00:00
  function cases(n, k, fOffsetDays) {
    const c = {};
    for (let i = 0; i < n; i++) {
      const f = E.hkDayStart(snap, -(fOffsetDays || 10)) + 3600000;
      c["x" + i] = { f, d: i < k ? f + 86400000 : 0 };
    }
    return c;
  }
  const r = (n, k) => E.hitrateSnapshot(cases(n, k), snap).mult;
  assert.equal(r(20, 3), 10000);  // 15 %
  assert.equal(r(20, 4), 11000);  // tasan 20 %
  assert.equal(r(20, 5), 11500);  // tasan 25 %
  assert.equal(r(20, 6), 12000);  // tasan 30 %
  assert.equal(r(20, 7), 12500);  // tasan 35 %
  assert.equal(r(40, 7), 10000);  // 17,5 %
  assert.equal(r(19, 19), 10000); // alle 20 tapausta -> 1,00
  // 13/40 = 32,5 % kuuluu 30–35 %:iin
  assert.equal(E.hitrateSnapshot(cases(40, 13), snap).mult, 12000);
  // Ikkunan rajat: tasan 60 päivää ja tasan 7 päivää vanha mukaan, 6 päivää vanha ei
  const edge = {};
  edge.a = { f: E.hkDayStart(snap, -60), d: 0 };
  edge.b = { f: E.hkDayStart(snap, -7) + 23 * 3600000, d: 0 };
  edge.c = { f: E.hkDayStart(snap, -6), d: 0 };
  edge.d = { f: E.hkDayStart(snap, -61) + 23 * 3600000, d: 0 };
  assert.equal(E.hitrateSnapshot(edge, snap).n, 2);
  // Edellisen kuukauden tarjous yhdistyy tämän kuukauden kauppaan
  const prev = { p: { f: Date.UTC(2026, 9, 20, 8), d: Date.UTC(2026, 10, 3, 8) } };
  const sn = E.hitrateSnapshot(prev, snap);
  assert.equal(sn.n, 1); assert.equal(sn.k, 1);
  // Snapshotin jälkeen syntynyt kauppa ei lasketa
  const late = { p: { f: Date.UTC(2026, 9, 20, 8), d: snap + 1000 } };
  assert.equal(E.hitrateSnapshot(late, snap).k, 0);
});

function ctxFor(s) {
  const idx = {};
  return { now: T0, awardIndex: idx, seasonFor: () => s, getSeason: () => s, multFor: () => ({ mult: 10000, snap: null }) };
}

test("6. Sama työvaihe ei anna palkintoa uudestaan (uusinta, muokkaus, uudelleenavaus)", () => {
  const s = season(["A", "B"]);
  const ctx = ctxFor(s);
  const cases = [{ id: "o1", f: T0, d: T0 + 1000, h: 0 }];
  let ops = E.reconcileCases("A", cases, ctx);
  assert.equal(ops.length, 2);
  const cash1 = s.players.A.cash;
  assert.equal(E.reconcileCases("A", cases, ctx).length, 0); // uusinta
  // tarjouksen muokkaus (esim. hinta) ei näy tapauksen aikoihin -> ei muutosta
  assert.equal(E.reconcileCases("A", [{ id: "o1", f: T0, d: T0 + 1000, h: 0 }], ctx).length, 0);
  // kauppa avataan uudelleen -> rahapalkkio oikaistaan, pisteet säilyvät
  ops = E.reconcileCases("A", [{ id: "o1", f: T0, d: 0, h: 0 }], ctx);
  assert.deepEqual(ops.map((o) => o.op), ["reverse"]);
  assert.equal(s.players.A.cash, cash1 - EUR(5000));
  assert.equal(E.workStatus(s, "A", T0).q, 20);
  // suljetaan uudelleen eri aikaan -> sama palkkio palautuu kerran, ei uusia pisteitä
  ops = E.reconcileCases("A", [{ id: "o1", f: T0, d: T0 + 99999, h: 0 }], ctx);
  assert.deepEqual(ops.map((o) => o.op), ["restore"]);
  assert.equal(s.players.A.cash, cash1);
  assert.equal(E.workStatus(s, "A", T0).q, 20);
  assert.equal(E.reconcileCases("A", [{ id: "o1", f: T0, d: T0 + 99999, h: 0 }], ctx).length, 0);
  audit(s);
});

test("7. Tontin tai auton ostaminen ei muuta nettovarallisuutta", () => {
  const s = season(["A", "B"]);
  const t = landOn(s, "A", 1);
  const nw0 = E.netWorth(s, "A").nw;
  E.buyTile(s, "A", T0, t.id);
  assert.equal(E.netWorth(s, "A").nw, nw0);
  E.bankBuy(s, "A", T0, t.id, 1, "ELECTRIC");
  assert.equal(E.netWorth(s, "A").nw, nw0);
  audit(s);
});

test("8. Tontti ja yksi kutakin autoluokkaa = 145 000 €; kolme liikettä jättää 65 000 €", () => {
  const s = season(["A", "B"]);
  const startCash = s.players.A.cash;
  let spentWork = 0;
  [1, 5, 10].forEach((tile) => {
    const before = s.players.A.cash;
    const t = landOn(s, "A", tile);
    E.buyTile(s, "A", T0, t.id);
    E.bankBuy(s, "A", T0, t.id, tile, "DIESEL");
    ["PETROL_HYBRID", "ELECTRIC"].forEach((cls) => {
      const t2 = neutralTurn(s, "A");
      E.bankBuy(s, "A", T0, t2.id, tile, cls);
    });
  });
  const workIncome = s.ledger.filter((e) => e.nick === "A" && e.k.indexOf("work_") === 0).reduce((a, e) => a + e.dc, 0);
  assert.equal(startCash + workIncome - s.players.A.cash, EUR(435000));
  assert.equal(EUR(500000) - EUR(435000), EUR(65000));
  assert.equal(E.carsOf(s, "A").length, 9);
  assert.equal(E.netWorth(s, "A").nw - workIncome, EUR(500000));
  audit(s);
});

function setupShop(s, owner, tile, classes) {
  const t = landOn(s, owner, tile);
  E.buyTile(s, owner, T0, t.id);
  const ids = [];
  classes.forEach((cls, i) => {
    const tt = i === 0 ? t : neutralTurn(s, owner);
    ids.push(E.bankBuy(s, owner, T0, tt.id, tile, cls).carId);
  });
  E.endTurn(s, owner, T0);
  return ids;
}

test("9. Sähköauto A:lta B:lle 66 000 €, A:n kate 6 000 €; B:n jälleenmyynti 0 €", () => {
  const s = season(["A", "B", "C"]);
  const [ev] = setupShop(s, "A", 1, ["ELECTRIC"]);
  const aCash = s.players.A.cash;
  const tb = landOn(s, "B", 1, { rng: [0] });
  assert.equal(tb.forced.carId, ev);
  assert.equal(tb.forced.price, EUR(66000));
  assert.equal(tb.forced.sellerMargin, EUR(6000));
  assert.equal(s.players.A.cash - aCash, EUR(66000));
  const c = s.cars[ev];
  assert.equal(c.owner, "B"); assert.equal(c.acq, EUR(66000)); assert.equal(c.right, false);
  // B:n liikkeeseen
  assert.deepEqual(tb.forced.placed, { t: "recv" });
  E.endTurn(s, "B", T0);
  // B ostaa tontin ja siirtää auton vastaanottopaikalta sinne
  const tb2 = landOn(s, "B", 5);
  E.buyTile(s, "B", T0, tb2.id);
  E.moveCar(s, "B", T0, tb2.id, ev, 5);
  E.endTurn(s, "B", T0);
  const bCash = s.players.B.cash;
  const tc = landOn(s, "C", 5, { rng: [0] });
  assert.equal(tc.forced.price, EUR(66000));
  assert.equal(tc.forced.sellerMargin, 0);
  assert.equal(s.players.B.cash - bCash, EUR(66000));
  audit(s);
});

test("10. Myyntiarvonta ottaa mukaan kaikki ja vain myyntikelpoiset autot", () => {
  const s = season(["A", "B"]);
  const ids = setupShop(s, "A", 1, ["DIESEL", "PETROL_HYBRID", "ELECTRIC"]);
  // Listataan yksi Autovexiin -> ei osallistu
  const ta = neutralTurn(s, "A");
  E.listAutovex(s, "A", T0, ta.id, ids[2]);
  E.endTurn(s, "A", T0);
  // Ohjattu arvonta: valitaan viimeinen ehdokas
  const r = seq([0, 0, 1]);
  s.players.B.pos = 23; giveTurns(s, "B", 1);
  const tb = E.roll(s, "B", T0, r);
  assert.deepEqual(r.asked, [6, 6, 2]); // arvonta kahdesta myyntikelpoisesta autosta
  assert.deepEqual(tb.forced.candidates, [ids[0], ids[1]].sort());
  assert.equal(tb.forced.carId, [ids[0], ids[1]].sort()[1]);
  assert.equal(s.cars[ids[2]].owner, "A"); // listattu auto ei siirtynyt
  // Tontti ilman myyntikelpoisia autoja -> ei kauppaa
  const s2 = season(["A", "B"]);
  const t = landOn(s2, "A", 2); E.buyTile(s2, "A", T0, t.id); E.endTurn(s2, "A", T0);
  const tb2 = landOn(s2, "B", 2);
  assert.ok(tb2.forced.none);
  audit(s); audit(s2);
});

test("12. Tontilla max 3 autoa, pelaajalla max 3 tonttia; vastaanottopaikka ja tukkurirealisointi", () => {
  const s = season(["A", "B"]);
  setupShop(s, "A", 1, ["DIESEL", "DIESEL", "DIESEL"]);
  const t = neutralTurn(s, "A");
  assert.throws(() => E.bankBuy(s, "A", T0, t.id, 1, "DIESEL"), /vapaata/);
  E.endTurn(s, "A", T0);
  [5, 10, 13].forEach((ti, i) => {
    const tt = landOn(s, "A", ti);
    if (i < 2) E.buyTile(s, "A", T0, tt.id);
    else assert.throws(() => E.buyTile(s, "A", T0, tt.id), /enimmäismäärä/);
    E.endTurn(s, "A", T0);
  });
  // B: ei tontteja -> ensimmäinen pakko-osto vastaanottopaikalle, toinen heti tukkurille
  const tb = landOn(s, "B", 1, { rng: [0] });
  assert.deepEqual(tb.forced.placed, { t: "recv" });
  assert.equal(s.players.B.recv, tb.forced.carId);
  E.endTurn(s, "B", T0);
  const tb2 = landOn(s, "B", 1, { rng: [0] });
  assert.equal(tb2.forced.placed, null);
  assert.equal(tb2.forced.wholesale.price, E.pct(tb2.forced.price, 8500));
  // Vastaanottopaikan auto ei osallistu B:n arvontaan (B:llä ei tonttia)
  assert.equal(E.carsOnTile(s, 1).length, 1);
  audit(s);
});

test("13. Kassa 1 000 €, hinta 66 000 € -> velka 65 000 €; tilan puute -> velkaa 8 900 €, tappio 9 900 €", () => {
  const s = season(["A", "B"]);
  setupShop(s, "A", 1, ["ELECTRIC"]);
  giveTurns(s, "B", 1);
  adjustCash(s, "B", EUR(1000));
  // a) Tilaa on (vastaanottopaikka vapaana)
  const s2 = JSON.parse(JSON.stringify(s));
  const nw0 = E.netWorth(s2, "B").nw;
  const t2 = landOn(s2, "B", 1, { noGrant: true, rng: [0] });
  assert.equal(s2.players.B.cash, 0);
  assert.equal(s2.players.B.debt, EUR(65000));
  assert.equal(s2.cars[t2.forced.carId].acq, EUR(66000));
  assert.equal(t2.forced.newDebt, EUR(65000));
  assert.equal(E.netWorth(s2, "B").nw, nw0); // ostaminen ei muuta nettovarallisuutta
  assert.ok(s2.feed.some((f) => f.msg === "Kassa ei riittänyt pakolliseen ostoon. Pelivelkaa syntyi 65\u00a0000\u00a0€."));
  audit(s2);
  // b) Ei tonttia eikä vapaata vastaanottopaikkaa (testissä paikka varataan valmiiksi)
  s.cars.X = { id: "X", cls: "DIESEL", owner: "B", loc: { t: "recv" }, acq: 0, right: false, st: "stock" };
  s.players.B.recv = "X";
  const nwBefore = E.netWorth(s, "B").nw;
  const t = landOn(s, "B", 1, { noGrant: true, rng: [0] });
  assert.equal(t.forced.placed, null);
  assert.equal(t.forced.wholesale.price, EUR(56100));
  assert.equal(t.forced.wholesale.loss, EUR(9900));
  assert.equal(s.players.B.cash, 0);
  assert.equal(s.players.B.debt, EUR(8900));
  assert.equal(nwBefore - E.netWorth(s, "B").nw, EUR(9900));
  assert.equal(s.cars[t.forced.carId].st, "gone");
  // osto ja realisointi kirjataan erikseen samaan tapahtumaketjuun
  const kinds = s.ledger.filter((e) => e.nick === "B" && e.ref === t.forced.carId).map((e) => e.k);
  assert.deepEqual(kinds, ["forced_buy", "forced_wholesale"]);
  audit(s);
});

test("14. Myyntikanavien hinnat", () => {
  const s = season(["A", "B"]);
  const p = (acq) => E.channelPrices(s, { acq });
  assert.deepEqual(p(EUR(60000)), { bank: EUR(60000), auction: EUR(54000), autovex: EUR(57000), wholesale: EUR(51000) });
  assert.deepEqual(p(EUR(66000)), { bank: EUR(66000), auction: EUR(59400), autovex: EUR(62700), wholesale: EUR(56100) });
  assert.equal(E.pct(1, 5000), 1); // puolikas ylöspäin
});

test("15–16. Autovex: ei myydä toiselle, vanha vuoro ei eräännytä, uusi eräännyttää kerran, ei tuplavarallisuutta", () => {
  const s = season(["A", "B"]);
  const [ev] = setupShop(s, "A", 1, ["ELECTRIC"]);
  // A ansaitsee kaksi vuoroa ennen listausta (T0), listaa myöhemmin
  giveTurns(s, "A", 2);
  const L = T0 + 3600000;
  const t1 = neutralTurn(s, "A", { noGrant: true, now: L });
  E.listAutovex(s, "A", L, t1.id, ev);
  const nwListed = E.netWorth(s, "A").nw;
  E.endTurn(s, "A", L + 1);
  assert.ok(s.listings.A, "listaus ei eräänny saman vuoron päättyessä");
  // B osuu A:n tontille: listattu auto ei ole arvonnassa
  const tb = landOn(s, "B", 1, { now: L });
  assert.ok(tb.forced.none);
  assert.equal(s.cars[ev].owner, "A");
  E.endTurn(s, "B", L);
  // Vanha (ennen listausta ansaittu) vuoro ei eräännytä
  const t2 = neutralTurn(s, "A", { noGrant: true, now: L + 2 });
  E.endTurn(s, "A", L + 3);
  assert.ok(s.listings.A);
  assert.ok(t2.avxWait);
  assert.equal(E.netWorth(s, "A").nw, nwListed);
  // Uusi työ listauksen jälkeen -> uusi oikeus -> eräännyttää kerran
  for (let i = 0; i < 5; i++) E.grantAward(s, L + 10, "A", "offer", "after" + i, L + 10);
  const cashBefore = s.players.A.cash;
  const t3 = neutralTurn(s, "A", { noGrant: true, now: L + 20 });
  E.endTurn(s, "A", L + 21);
  assert.equal(t3.avx.price, EUR(57000));
  assert.equal(s.players.A.cash - cashBefore, EUR(57000));
  assert.equal(s.listings.A, undefined);
  // Toinen päättäminen ei maksa uudestaan
  assert.throws(() => E.endTurn(s, "A", L + 22), /avointa vuoroa/);
  audit(s);
});

test("18. Helsingin kuukausiraja ja kesä-/talviaika", () => {
  // 31.10.2026 klo 23:30 Helsinki (UTC+2) = 21:30Z -> lokakuu; 22:30Z = 1.11. 00:30 -> marraskuu
  assert.equal(E.seasonIdOf(Date.UTC(2026, 9, 31, 21, 30)), "2026-10");
  assert.equal(E.seasonIdOf(Date.UTC(2026, 9, 31, 22, 0)), "2026-11");
  assert.equal(E.seasonIdOf(Date.UTC(2026, 9, 31, 21, 59, 59)), "2026-10");
  const nov = E.seasonBounds("2026-11");
  assert.equal(nov.start, Date.UTC(2026, 9, 31, 22, 0));
  assert.equal(nov.end, Date.UTC(2026, 10, 30, 22, 0));
  // Kesäaika: maaliskuu 2027 vaihtuu 28.3. -> huhtikuun alku UTC+3
  assert.equal(E.seasonBounds("2027-04").start, Date.UTC(2027, 2, 31, 21, 0));
  assert.equal(E.seasonBounds("2027-03").start, Date.UTC(2027, 1, 28, 22, 0));
  // Lokakuun vaihtopäivä: 25.10.2026 01:00Z siirrytään talviaikaan
  assert.equal(E.hkParts(Date.UTC(2026, 9, 25, 0, 30)).h, 3);
  assert.equal(E.hkParts(Date.UTC(2026, 9, 25, 1, 30)).h, 3);
  // Viikon alku DST-viikon yli: ma 26.10.2026 00:00 talviaikaa = 25.10. 22:00Z
  assert.equal(E.weekStart(Date.UTC(2026, 9, 28, 10)), Date.UTC(2026, 9, 25, 22, 0));
  assert.equal(E.weekStart(Date.UTC(2026, 2, 31, 10)), Date.UTC(2026, 2, 29, 21, 0)); // ma 30.3. 00:00 EEST = 29.3. 21:00Z
});

test("19. Kauden sulku on idempotentti; vuorot raukeavat, listaukset perutaan", () => {
  const s = season(["A", "B"]);
  const [ev] = setupShop(s, "A", 1, ["ELECTRIC"]);
  giveTurns(s, "A", 2);
  const t = neutralTurn(s, "A");
  E.listAutovex(s, "A", T0, t.id, ev); // vuoro jää auki
  const nw = E.netWorth(s, "A").nw;
  const r1 = E.closeSeason(s, s.endAt);
  assert.equal(s.state, "closed");
  assert.equal(s.players.A.openTurn, null);
  assert.equal(s.listings.A, undefined);
  assert.equal(s.cars[ev].st, "stock");
  assert.equal(E.netWorth(s, "A").nw, nw); // auto hankintahintaan, ei Autovex-tuloa
  assert.equal(s.players.A.expired, 2);
  const r2 = E.closeSeason(s, s.endAt + 1000);
  assert.ok(r2.already);
  assert.deepEqual(r1.results.rows, r2.results.rows);
  assert.throws(() => E.roll(s, "A", s.endAt + 5, seq([0, 0])), /päättynyt/);
  audit(s);
});

test("20. Kauppapalkkion oikaisu ja palautus alkuperäisellä summalla; korjaus ei tuota ilmaisia vuoroja", () => {
  const s = season(["A", "B"]);
  E.grantAward(s, T0, "A", "deal", "d1", T0, 12000);
  const a = s.awards[E.awardKey("A", "deal", "d1")];
  assert.equal(a.cents, EUR(6000));
  // Kertoimen muutos myöhemmin ei vaikuta: oikaisu ja palautus käyttävät tallennettua summaa
  const c0 = s.players.A.cash;
  E.reverseAward(s, T0, a.key); assert.equal(s.players.A.cash, c0 - EUR(6000));
  E.restoreAward(s, T0, a.key); assert.equal(s.players.A.cash, c0);
  // Virheellinen tarjous korjataan: pisteet vähenevät
  grant(s, "A", "offer", 1); // 16 + 4 = 20 -> 1 vuoro
  assert.equal(E.workStatus(s, "A", T0).avail, 1);
  E.roll(s, "A", T0, seq([0, 0]));
  const offerKey = Object.keys(s.awards).find((k) => k.indexOf("|offer|") > 0);
  E.voidAward(s, T0, offerKey);
  let w = E.workStatus(s, "A", T0);
  assert.equal(w.avail, 0); assert.equal(w.deficit, 4);
  // Uudet 4 pistettä kuittaavat ensin vajeen
  grant(s, "A", "offer", 1);
  w = E.workStatus(s, "A", T0);
  assert.equal(w.avail, 0); assert.equal(w.toNext, 20);
  // Negatiivinen oikaisu tyhjällä kassalla -> velaksi
  const s2 = season(["A", "B"]);
  E.grantAward(s2, T0, "A", "deal", "d2", T0, 10000);
  s2.players.A.cash = 0; s2.ledger.push({ i: 99, t: T0, nick: "A", k: "test", dc: -(EUR(500000) + EUR(5000)), dd: 0 });
  E.reverseAward(s2, T0, E.awardKey("A", "deal", "d2"));
  assert.equal(s2.players.A.debt, EUR(5000));
  audit(s); audit(s2);
});

test("Tukkurimyynti on sallittu vuorojen välissä ja näyttää tappion", () => {
  const s = season(["A", "B"]);
  const [ev] = setupShop(s, "A", 1, ["ELECTRIC"]);
  const r = E.wholesale(s, "A", T0, ev);
  assert.equal(r.price, EUR(51000)); assert.equal(r.loss, EUR(9000));
  assert.match(s.feed[s.feed.length - 1].msg, /Tukkurimyynti: .* sai 51 000 €, tappio 9 000 €/);
  audit(s);
});

test("Pankkiasiakas ja huutokauppa: kanavan ehdot ja kate 0 €", () => {
  const s = season(["A", "B"]);
  const [d] = setupShop(s, "A", 3, ["DIESEL"]);
  const t = landOn(s, "A", 5);
  assert.throws(() => E.sellBank(s, "A", T0, t.id, d), /omalle tontillesi/);
  assert.throws(() => E.sellAuction(s, "A", T0, t.id, d), /huutokaupparuutuun/);
  E.endTurn(s, "A", T0);
  const t2 = landOn(s, "A", 15);
  const r = E.sellAuction(s, "A", T0, t2.id, d);
  assert.equal(r.price, EUR(9000));
  assert.equal(r.loss, EUR(1000));
  E.endTurn(s, "A", T0);
  // Pankkiasiakas omalla tontilla: hinta = hankintahinta, kate 0 € vaikka katteellinen oikeus on käyttämättä
  const t3 = neutralTurn(s, "A");
  const d2 = E.bankBuy(s, "A", T0, t3.id, 3, "ELECTRIC").carId;
  E.endTurn(s, "A", T0);
  const t4 = landOn(s, "A", 3);
  const r2 = E.sellBank(s, "A", T0, t4.id, d2);
  assert.equal(r2.price, EUR(60000)); assert.equal(r2.loss, 0);
  assert.throws(() => E.wholesale(s, "A", T0, d2), /löydy/); // poistunut auto ei palaa
  audit(s);
});

test("Vuorossa tonttiosto ja yksi varastotoimi; uusi heitto päättää edellisen vuoron", () => {
  const s = season(["A", "B"]);
  const t = landOn(s, "A", 7);
  E.buyTile(s, "A", T0, t.id);
  assert.throws(() => E.buyTile(s, "A", T0, t.id), /jo ostanut/);
  const c = E.bankBuy(s, "A", T0, t.id, 7, "DIESEL").carId;
  assert.throws(() => E.bankBuy(s, "A", T0, t.id, 7, "DIESEL"), /varastotoimi/);
  assert.throws(() => E.moveCar(s, "A", T0, t.id, c, "recv"), /varastotoimi/);
  // Uusi heitto ilman päättämistä: edellinen vuoro päättyy, uusi alkaa
  const t2 = neutralTurn(s, "A");
  assert.notEqual(t2.id, t.id);
  assert.equal(s.players.A.lastTurn.id, t.id);
  assert.equal(s.players.A.lastTurn.ended.by, "roll");
  // Vanhan vuoron tunnisteella ei voi enää toimia
  assert.throws(() => E.moveCar(s, "A", T0, t.id, c, "recv"), /avointa vuoroa/);
  E.moveCar(s, "A", T0, t2.id, c, "recv");
  assert.equal(s.players.A.recv, c);
  // Ei vuoroja -> heitto estetään eikä tila muutu
  E.endTurn(s, "A", T0);
  assert.throws(() => E.roll(s, "A", T0, seq([0, 0])), /Ei käytettäviä vuoroja/);
  audit(s);
});

test("Tontti on ostettavissa vain kerran ja vain vapaana; vapaaehtoinen osto vaatii nollavelan", () => {
  const s = season(["A", "B"]);
  const ta = landOn(s, "A", 2);
  E.buyTile(s, "A", T0, ta.id); E.endTurn(s, "A", T0);
  const tb = landOn(s, "B", 2);
  assert.throws(() => E.buyTile(s, "B", T0, tb.id), /jo myyty/);
  E.endTurn(s, "B", T0);
  // Velkaa 100 € (testiasetus kirjanpidon kautta) -> vapaaehtoinen tonttiosto estyy
  const s2 = season(["A", "B"]);
  const t = landOn(s2, "B", 2);
  s2.players.B.debt = 100; s2.ledger.push({ i: 1, t: T0, nick: "B", k: "test", dc: 0, dd: 100 });
  assert.throws(() => E.buyTile(s2, "B", T0, t.id), /pelivelkaa/);
  assert.equal(s2.tiles[2], undefined);
  audit(s2);
});

test("Satunnaissimulaatio: kirjanpito täsmää aina ja saldot pysyvät ei-negatiivisina", () => {
  for (let seed = 1; seed <= 30; seed++) {
    let x = seed * 2654435761 % 4294967296;
    const rnd = (n) => { x = (x * 1664525 + 1013904223) % 4294967296; return Math.floor(x / 4294967296 * n); };
    const s = season(["A", "B", "C", "D"]);
    for (let step = 0; step < 300; step++) {
      const nick = ["A", "B", "C", "D"][rnd(4)];
      const p = s.players[nick];
      try {
        const r = rnd(10);
        if (r < 3) E.grantAward(s, T0, nick, ["offer", "deal", "handover"][rnd(3)], "s" + seed + "_" + step, T0, 12000);
        else if (r < 6) { if (E.workStatus(s, nick, T0).avail > 0) E.roll(s, nick, T0, rnd); }
        else if (p.openTurn) {
          const t = p.openTurn, own = E.ownedTiles(s, nick), mine = E.carsOf(s, nick);
          const a = rnd(7);
          if (a === 0) E.buyTile(s, nick, T0, t.id);
          else if (a === 1 && own.length) E.bankBuy(s, nick, T0, t.id, own[rnd(own.length)], ["DIESEL", "PETROL_HYBRID", "ELECTRIC"][rnd(3)]);
          else if (a === 2 && mine.length) E.listAutovex(s, nick, T0, t.id, mine[rnd(mine.length)].id);
          else if (a === 3 && mine.length) E.wholesale(s, nick, T0, mine[rnd(mine.length)].id);
          else if (a === 4 && mine.length) E.sellAuction(s, nick, T0, t.id, mine[rnd(mine.length)].id);
          else if (a === 5 && mine.length && own.length) E.moveCar(s, nick, T0, t.id, mine[rnd(mine.length)].id, own[rnd(own.length)]);
          else E.endTurn(s, nick, T0);
        }
      } catch (e) { if (!e.isGameError) throw e; }
      const a = E.auditBalances(s);
      assert.ok(a.ok, "seed " + seed + " step " + step + " " + JSON.stringify(a.diff));
      // varastopaikat ja vastaanottopaikka eivät ylity
      for (let ti = 0; ti < 24; ti++) assert.ok(E.carsOnTile(s, ti).length <= 3);
      Object.keys(s.players).forEach((n) => {
        assert.ok(E.ownedTiles(s, n).length <= 3);
        assert.ok(Object.values(s.cars).filter((c) => c.owner === n && c.st !== "gone" && c.loc && c.loc.t === "recv").length <= 1);
      });
      Object.values(s.cars).forEach((c) => { if (c.st !== "gone" && c.loc.t === "tile") assert.equal(s.tiles[c.loc.tile], c.owner); });
    }
  }
});
