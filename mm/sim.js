// Myyntimonopoli – toistettava taloussimulaatio (pelitasapainon havaintotyökalu, ei todiste reiluudesta).
// Ajo: node mm/sim.js [siemeniä=200]   -> tulostaa yhteenvedon ja kirjoittaa mm/SIMULAATIO.md
// Neljä pelaajaa, kuukauden työmäärät, pelaajat käyttävät vuoronsa joka ilta yksinkertaisella strategialla.
// Tulos jaetaan osiin: oikea työ + saadut pelikatteet − realisointitappiot (ostot eivät muuta nettovarallisuutta).
const fs = require("fs");
const path = require("path");
const E = require("./engine.js");

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const MULT = (rate) => rate >= 0.35 ? 12500 : rate >= 0.30 ? 12000 : rate >= 0.25 ? 11500 : rate >= 0.20 ? 11000 : 10000;

function runSeason(seed, players) {
  const rnd = mulberry32(seed), rng = (n) => Math.floor(rnd() * n);
  const id = "2026-11", b = E.seasonBounds(id), DAY = 86400000;
  const s = E.newSeason({ id, roomId: "SIM", participants: players.map((p) => ({ nick: p.nick, joinedAt: b.start })) });
  const comp = {}; players.forEach((p) => { comp[p.nick] = { work: 0, margin: 0, loss: 0, forcedBuys: 0, forcedValue: 0, wholesaleForced: 0, debtMax: 0, turns: 0 }; });
  // Työtapahtumat: tarjoukset arkipäivinä, kaupat 3–10 pv myöhemmin, luovutus 2–5 pv kaupasta.
  const events = [];
  players.forEach((p) => {
    for (let i = 0; i < p.offers; i++) {
      const day = Math.floor(rnd() * 29), t = b.start + day * DAY + 8 * 3600000 + Math.floor(rnd() * 9 * 3600000);
      events.push({ t, nick: p.nick, stage: "offer", id: p.nick + "o" + i });
      if (rnd() < p.rate) {
        const td = t + (3 + Math.floor(rnd() * 8)) * DAY;
        if (td < b.end) {
          events.push({ t: td, nick: p.nick, stage: "deal", id: p.nick + "o" + i, mult: MULT(p.rate) });
          const th = td + (2 + Math.floor(rnd() * 4)) * DAY;
          if (th < b.end && rnd() < 0.8) events.push({ t: th, nick: p.nick, stage: "handover", id: p.nick + "o" + i });
        }
      }
    }
  });
  events.sort((a, c) => a.t - c.t);
  let ei = 0;
  for (let day = 0; day < 30; day++) {
    const evening = b.start + day * DAY + 19 * 3600000;
    if (evening >= b.end) break;
    while (ei < events.length && events[ei].t <= evening) {
      const e = events[ei++];
      const a = E.grantAward(s, e.t, e.nick, e.stage, e.id, e.t, e.mult);
      if (a) comp[e.nick].work += a.cents;
    }
    // pelaajat vuorollaan satunnaisessa järjestyksessä
    const order = players.slice().sort(() => rnd() - 0.5);
    order.forEach((p) => {
      let guard = 0;
      while (E.workStatus(s, p.nick, evening).avail > 0 && guard++ < 40) {
        const t = E.roll(s, p.nick, evening, rng);
        comp[p.nick].turns++;
        const f = t.forced;
        if (f && !f.none) {
          comp[p.nick].forcedBuys++; comp[p.nick].forcedValue += f.price;
          comp[f.seller].margin += f.sellerMargin;
          if (f.wholesale) { comp[p.nick].loss += f.wholesale.loss; comp[p.nick].wholesaleForced++; }
        }
        const pl = s.players[p.nick];
        comp[p.nick].debtMax = Math.max(comp[p.nick].debtMax, pl.debt);
        const sq = E.BOARD[t.to], reserve = p.reserve;
        if (sq.kind === "tile" && !s.tiles[t.to] && E.ownedTiles(s, p.nick).length < 3 && pl.debt === 0 && pl.cash >= s.rules.tilePrice + reserve) E.buyTile(s, p.nick, evening, t.id);
        const own = E.ownedTiles(s, p.nick).filter((ti) => E.freeSlot(s, ti) >= 0);
        const mine = E.carsOf(s, p.nick).filter((c) => c.st === "stock");
        const recv = mine.filter((c) => c.loc.t === "recv")[0];
        let cls = null;
        if (p.style === "electric") cls = "ELECTRIC";
        else { const n = E.carsOf(s, p.nick).length; cls = ["DIESEL", "PETROL_HYBRID", "ELECTRIC"][n % 3]; }
        try {
          if (recv && own.length) E.moveCar(s, p.nick, evening, t.id, recv.id, own[0]);
          else if (pl.debt > 0 && s.tiles[t.to] === p.nick && recv) { const r = E.sellBank(s, p.nick, evening, t.id, recv.id); comp[p.nick].loss += r.loss; }
          else if (own.length && pl.debt === 0 && pl.cash >= s.rules.classes[cls].buy + reserve) E.bankBuy(s, p.nick, evening, t.id, own[0], cls);
        } catch (e) { if (!e.isGameError) throw e; }
        E.endTurn(s, p.nick, evening, t.id);
      }
    });
  }
  E.closeSeason(s, b.end);
  const audit = E.auditBalances(s);
  if (!audit.ok) throw new Error("kirjanpito ei täsmää, siemen " + seed);
  return players.map((p) => {
    const w = E.netWorth(s, p.nick), c = comp[p.nick];
    if (w.result !== c.work + c.margin - c.loss) throw new Error("tuloksen osat eivät täsmää, siemen " + seed + " " + p.nick);
    return Object.assign({ nick: p.nick, style: p.style, result: w.result, debt: w.debt, cash: w.cash, stock: w.stock, rank: s.results.rows.find((r) => r.nick === p.nick).rank, expired: s.players[p.nick].expired }, c);
  });
}

function mean(a) { return a.reduce((x, y) => x + y, 0) / (a.length || 1); }
function sd(a) { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))); }
const eur = (c) => E.fmtEur(Math.round(c / 100) * 100).replace(/ /g, " ");
const pct = (x) => (Math.round(x * 1000) / 10).toString().replace(".", ",") + " %";

function main() {
  const N = +process.argv[2] || 200;
  const rows = [];
  // A) Sama työmäärä kaikilla: strategiat vuorottelevat paikoilla, jotta istumajärjestys ei vaikuta.
  const equal = (styles) => styles.map((st, i) => ({ nick: "P" + (i + 1), offers: 40, rate: 0.28, style: st, reserve: 2000000 }));
  const A = [];
  for (let seed = 1; seed <= N; seed++) {
    const styles = seed % 2 ? ["balanced", "electric", "balanced", "electric"] : ["electric", "balanced", "electric", "balanced"];
    A.push(...runSeason(seed, equal(styles)));
  }
  // B) Eri työmäärät, kaikki tasapainoisella varastolla: kuinka paljon oikea työ ratkaisee.
  const B = [];
  const prof = [{ offers: 55, rate: 0.36 }, { offers: 42, rate: 0.30 }, { offers: 32, rate: 0.24 }, { offers: 22, rate: 0.17 }];
  for (let seed = 1; seed <= N; seed++) B.push(...runSeason(10000 + seed, prof.map((p, i) => ({ nick: "P" + (i + 1), offers: p.offers, rate: p.rate, style: "balanced", reserve: 2000000 }))));
  // C) Kaikki sähköautopainotteisia, sama työ.
  const C = [];
  for (let seed = 1; seed <= N; seed++) C.push(...runSeason(20000 + seed, equal(["electric", "electric", "electric", "electric"])));

  function summary(list) {
    return { n: list.length, result: mean(list.map((r) => r.result)), sdResult: sd(list.map((r) => r.result)), work: mean(list.map((r) => r.work)), margin: mean(list.map((r) => r.margin)), loss: mean(list.map((r) => r.loss)),
      forcedBuys: mean(list.map((r) => r.forcedBuys)), wholesaleForced: mean(list.map((r) => r.wholesaleForced)), debtEnd: mean(list.map((r) => r.debt)), debtShare: mean(list.map((r) => (r.debt > 0 ? 1 : 0))), win: mean(list.map((r) => (r.rank === 1 ? 1 : 0))), turns: mean(list.map((r) => r.turns)), expired: mean(list.map((r) => r.expired)) };
  }
  const sb = summary(A.filter((r) => r.style === "balanced")), se = summary(A.filter((r) => r.style === "electric")), sc = summary(C);
  const byP = [1, 2, 3, 4].map((i) => summary(B.filter((r) => r.nick === "P" + i)));
  // Työn osuus tulosten erosta (B): pelaajien keskimääräisten tulosten ero vs. työn ero
  const lines = [];
  lines.push("# Myyntimonopoli – taloussimulaatio");
  lines.push("");
  lines.push("Toistettava ajo: `node mm/sim.js " + N + "` (siemenet 1–" + N + " kussakin skenaariossa). Pelitasapainon havaintotyökalu, ei todiste reiluudesta. Arvot ovat ensimmäisen version oletuksia; mitään palkkiota ei ole muutettu simulaation perusteella.");
  lines.push("");
  lines.push("Pelaajat käyttävät kaikki vuoronsa joka ilta: ostavat vapaan tontin, jos kassaa jää yli 20 000 €, ja hankkivat yhden auton vuorossa. Kauppa tulee 3–10 päivää tarjouksesta, luovutus 2–5 päivää kaupasta (80 %). Tulos = oikea työ + saadut pelikatteet − realisointitappiot (ostot eivät muuta nettovarallisuutta; tämä tarkistetaan jokaisessa ajossa, samoin kirjanpidon täsmäys).");
  lines.push("");
  lines.push("## A) Sama työ (40 tarjousta, hitrate 28 %), tasapainoinen vs. sähköautopainotteinen varasto");
  lines.push("");
  lines.push("| Varasto | Tulos ka. | Hajonta | Oikea työ | Saadut katteet | Realisointitappiot | Pakko-ostot / kk | Tukkurille tilan puutteessa | Velkaa kauden lopussa | Voittaa |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  [["Tasapainoinen", sb], ["Sähköautopainotteinen", se], ["Kaikki sähköautoilla (C)", sc]].forEach(([n, x]) => {
    lines.push("| " + n + " | " + eur(x.result) + " | " + eur(x.sdResult) + " | " + eur(x.work) + " | " + eur(x.margin) + " | −" + eur(x.loss) + " | " + x.forcedBuys.toFixed(1).replace(".", ",") + " | " + x.wholesaleForced.toFixed(2).replace(".", ",") + " | " + pct(x.debtShare) + " (ka. " + eur(x.debtEnd) + ") | " + pct(x.win) + " |");
  });
  lines.push("");
  lines.push("## B) Eri työmäärät, kaikilla tasapainoinen varasto");
  lines.push("");
  lines.push("| Pelaaja | Työ / kk | Tulos ka. | Hajonta | Oikea työ | Saadut katteet | Realisointitappiot | Vuoroja | Voittaa |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
  byP.forEach((x, i) => {
    lines.push("| P" + (i + 1) + " | " + prof[i].offers + " tarjousta, " + Math.round(prof[i].rate * 100) + " % | " + eur(x.result) + " | " + eur(x.sdResult) + " | " + eur(x.work) + " | " + eur(x.margin) + " | −" + eur(x.loss) + " | " + x.turns.toFixed(1).replace(".", ",") + " | " + pct(x.win) + " |");
  });
  const gapResult = byP[0].result - byP[3].result, gapWork = byP[0].work - byP[3].work;
  lines.push("");
  lines.push("## Havainnot");
  lines.push("");
  lines.push("- Oikea työ on tuloksen suurin osa: B-skenaariossa ahkerimman ja vähiten työtä tehneen ero on keskimäärin " + eur(gapResult) + ", josta työn osuus " + eur(gapWork) + " (" + pct(gapWork / gapResult) + "). Ahkerin voittaa " + pct(byP[0].win) + " kuukausista.");
  lines.push("- Pelin osuus (katteet − tappiot) on " + eur(sb.margin - sb.loss) + " tasapainoisella ja " + eur(se.margin - se.loss) + " sähköautopainotteisella varastolla samalla työllä. Tulosten hajonta samalla työllä (" + eur(sb.sdResult) + " / " + eur(se.sdResult) + ") kertoo, paljonko arpaonni ja laudan tapahtumat vaikuttavat.");
  lines.push("- Sähköautopainotteinen varasto voittaa samalla työllä " + pct(se.win) + " kuukausista (tasapainoinen " + pct(sb.win) + "). Se tuottaa enemmän katetta osumista, mutta altistaa pakko-ostoissa velalle ja tilan puutteessa 85 %:n tukkurimyynnin tappioille.");
  lines.push("- Kun kaikki pelaavat sähköautoilla (C), velkaa on kauden lopussa " + pct(sc.debtShare) + " pelaajista ja tukkurirealisointeja tilan puutteessa " + sc.wholesaleForced.toFixed(2).replace(".", ",") + " pelaajaa kohden kuukaudessa.");
  lines.push("- Säädettävät arvot seuraavalle kaudelle: huoneen ylläpitäjä voi muuttaa alkukassaa, tontin hintaa ja työpalkkioita Huone-välilehdellä; luokkahinnat, katteet, kanavaprosentit ja boostitaulukko ovat sääntöversion kenttiä (mm/engine.js DEFAULT_RULES ja palvelimen mm_room_rules).");
  lines.push("");
  const txt = lines.join("\n") + "\n";
  fs.writeFileSync(path.join(__dirname, "SIMULAATIO.md"), txt);
  console.log(txt);
}
if (require.main === module) main();
module.exports = { runSeason };
