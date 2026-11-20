// 17. ja 11. Samanaikaiset komennot oikeilla rinnakkaisilla säikeillä yhteistä tiedostotallennusta vasten.
// Lukko vastaa Apps Scriptin LockService.getScriptLock()-lukkoa: yksi kirjoittaja kerrallaan.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const E = require("../engine.js");
const { fileEnv, writeSellers, sleep } = require("./fileenv.js");

const CLOCK = Date.UTC(2026, 10, 2, 8, 0);
const EUR = (e) => Math.round(e * 100);

function offers(n, at) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push({ id: "w" + at + "_" + i, ts: new Date(at).toISOString(), source: 1, closed: false, closedTs: null, st: "o" });
  return arr;
}
function setup(clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-conc-"));
  const sellers = {
    renny: { nickname: "Renny", company: "Saka Nummela", pin: "1111", months: {} },
    aino: { nickname: "Aino", company: "Saka Nummela", pin: "2222", months: {} }
  };
  writeSellers(dir, sellers);
  const q = [];
  const env = fileEnv(dir, { clock, rng: (n) => (q.length ? q.shift() % n : 0) });
  const call = (who, action, body, idem) => env.server.handle(Object.assign({ action, nickname: sellers[who].nickname, pin: sellers[who].pin, idem: idem || "s" + Math.random() }, body || {}));
  let r = call("renny", "mm_room_create", { name: "Testi" });
  call("aino", "mm_room_join", { roomId: r.room.id });
  r = call("renny", "mm_room_start");
  assert.ok(r.ok);
  return { dir, sellers, env, q, call, roomId: r.room.id };
}
function giveWork(ctx, who, n, at) {
  const mk = "2026-11";
  const m = ctx.sellers[who].months;
  m[mk] = m[mk] || { monthKey: mk, offers: [] };
  m[mk].offers = m[mk].offers.concat(offers(n, at));
  writeSellers(ctx.dir, ctx.sellers);
}
function runConcurrent(ctx, bodies, opts) {
  opts = opts || {};
  const gate = new SharedArrayBuffer(8), g = new Int32Array(gate);
  const ws = bodies.map((body) => new Worker(path.join(__dirname, "worker.js"), {
    workerData: { dir: ctx.dir, clock: opts.clock || CLOCK + 3600000, body, gate, noLock: !!opts.noLock, slowRead: opts.slowRead || 0 }
  }));
  const results = ws.map((w) => new Promise((res, rej) => { w.once("message", res); w.once("error", rej); }));
  while (Atomics.load(g, 1) < bodies.length) sleep(2);
  Atomics.store(g, 0, 1); Atomics.notify(g, 0);
  return Promise.all(results).finally(() => ws.forEach((w) => w.terminate()));
}
function season(ctx) {
  const ix = JSON.parse(ctx.env.store.get("mm:index"));
  const room = JSON.parse(ctx.env.store.get("mm:room:" + ctx.roomId));
  return JSON.parse(ctx.env.store.get("mm:season:" + ctx.roomId + ":" + room.cur));
}
function body(ctx, who, action, extra, idem) { return Object.assign({ action, nickname: ctx.sellers[who].nickname, pin: ctx.sellers[who].pin, idem }, extra || {}); }

test("Kahdeksan samanaikaista heittoa yhdellä vuoro-oikeudella: vain yksi onnistuu", async () => {
  const ctx = setup(CLOCK);
  giveWork(ctx, "renny", 5, CLOCK + 1000);
  const bodies = [];
  for (let i = 0; i < 8; i++) bodies.push(body(ctx, "renny", "mm_roll", {}, "roll-" + i));
  const res = await runConcurrent(ctx, bodies);
  assert.equal(res.filter((r) => r.ok).length, 1, JSON.stringify(res));
  assert.ok(res.filter((r) => !r.ok).every((r) => r.error === "NO_TURNS"));
  const s = season(ctx);
  assert.equal(s.players.renny.used, 1);
  assert.equal(s.turns.length, 1);
  assert.ok(E.auditBalances(s).ok);
});

test("Sama heittopyyntö neljästi yhtä aikaa (tuplanapautus/uusinta): sama tulos, yksi vuoro käytetty", async () => {
  const ctx = setup(CLOCK);
  giveWork(ctx, "renny", 10, CLOCK + 1000);
  const bodies = [0, 1, 2, 3].map(() => body(ctx, "renny", "mm_roll", {}, "double-tap"));
  const res = await runConcurrent(ctx, bodies);
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  assert.equal(res.filter((r) => !r.replay).length, 1);
  const dice = res.map((r) => [r.result.turn.id, r.result.turn.d1, r.result.turn.d2].join());
  assert.equal(new Set(dice).size, 1);
  assert.equal(season(ctx).players.renny.used, 1);
});

test("Kaksi pelaajaa ostaa saman tontin samaan aikaan: vain toinen saa sen ja vain häneltä veloitetaan", async () => {
  const ctx = setup(CLOCK);
  giveWork(ctx, "renny", 5, CLOCK + 1000); giveWork(ctx, "aino", 5, CLOCK + 1000);
  ctx.q.push(0, 0); const tr = ctx.call("renny", "mm_roll").result.turn;
  ctx.q.push(0, 0); const ta = ctx.call("aino", "mm_roll").result.turn;
  assert.equal(tr.to, 2); assert.equal(ta.to, 2);
  const bodies = [];
  for (let i = 0; i < 3; i++) {
    bodies.push(body(ctx, "renny", "mm_buy_tile", { turnId: tr.id }, "rt" + i));
    bodies.push(body(ctx, "aino", "mm_buy_tile", { turnId: ta.id }, "at" + i));
  }
  const res = await runConcurrent(ctx, bodies);
  assert.equal(res.filter((r) => r.ok).length, 1, JSON.stringify(res.map((r) => r.error)));
  const s = season(ctx), owner = s.tiles[2];
  assert.ok(owner === "renny" || owner === "aino");
  const other = owner === "renny" ? "aino" : "renny";
  assert.equal(s.players[owner].cash, EUR(502500 - 50000));
  assert.equal(s.players[other].cash, EUR(502500));
  assert.ok(E.auditBalances(s).ok);
});

test("Saman auton samanaikainen tukkurimyynti kuudesti: auto myydään kerran ja raha tulee kerran", async () => {
  const ctx = setup(CLOCK);
  giveWork(ctx, "renny", 5, CLOCK + 1000);
  ctx.q.push(0, 0); const t = ctx.call("renny", "mm_roll").result.turn;
  ctx.call("renny", "mm_buy_tile", { turnId: t.id });
  const car = ctx.call("renny", "mm_bank_buy", { turnId: t.id, tile: 2, cls: "ELECTRIC" }).result.carId;
  const cash0 = season(ctx).players.renny.cash;
  const bodies = [0, 1, 2, 3, 4, 5].map((i) => body(ctx, "renny", "mm_wholesale", { carId: car }, "ws" + i));
  const res = await runConcurrent(ctx, bodies);
  assert.equal(res.filter((r) => r.ok).length, 1);
  const s = season(ctx);
  assert.equal(s.players.renny.cash - cash0, EUR(51000));
  assert.equal(s.cars[car].st, "gone");
  assert.ok(E.auditBalances(s).ok);
});

test("Autovex-selvitys kahdella samanaikaisella vuoron päätöksellä: maksu vain kerran", async () => {
  const ctx = setup(CLOCK);
  giveWork(ctx, "renny", 5, CLOCK + 1000);
  ctx.q.push(0, 0); const t = ctx.call("renny", "mm_roll").result.turn;
  ctx.call("renny", "mm_buy_tile", { turnId: t.id });
  ctx.call("renny", "mm_end_turn", { turnId: t.id });
  // uusi vuoro, pankkiauto ja listaus
  giveWork(ctx, "renny", 5, CLOCK + 2000);
  ctx.q.push(5, 5); const t2 = ctx.call("renny", "mm_roll").result.turn;
  const car = ctx.call("renny", "mm_bank_buy", { turnId: t2.id, tile: 2, cls: "ELECTRIC" }).result.carId;
  ctx.call("renny", "mm_end_turn", { turnId: t2.id });
  giveWork(ctx, "renny", 5, CLOCK + 3000);
  ctx.q.push(5, 5); const t3 = ctx.call("renny", "mm_roll").result.turn;
  assert.ok(ctx.call("renny", "mm_list", { turnId: t3.id, carId: car }).ok);
  ctx.call("renny", "mm_end_turn", { turnId: t3.id });
  // listauksen jälkeen ansaittu oikeus (työn aika listauksen jälkeen)
  giveWork(ctx, "renny", 5, CLOCK + 3600000 - 1000);
  ctx.env.now = () => CLOCK + 3600000; // sama kello kuin rinnakkaisilla pyynnöillä
  ctx.q.push(5, 5); const t4 = ctx.call("renny", "mm_roll").result.turn;
  const cash0 = season(ctx).players.renny.cash;
  const bodies = [0, 1, 2, 3].map((i) => body(ctx, "renny", "mm_end_turn", { turnId: t4.id }, "end" + i));
  const res = await runConcurrent(ctx, bodies);
  assert.equal(res.filter((r) => r.ok).length, 1, JSON.stringify(res.map((r) => r.error)));
  const s = season(ctx);
  assert.equal(s.players.renny.cash - cash0, EUR(57000));
  assert.equal(s.listings.renny, undefined);
  assert.equal(s.ledger.filter((e) => e.k === "sell_autovex").length, 1);
  assert.ok(E.auditBalances(s).ok);
});

test("Vertailu ilman lukkoa: sama rinnakkainen heittotesti paljastaa tuplakäytön (testi on herkkä)", async () => {
  const ctx = setup(CLOCK);
  giveWork(ctx, "renny", 5, CLOCK + 1000);
  const bodies = [];
  for (let i = 0; i < 6; i++) bodies.push(body(ctx, "renny", "mm_roll", {}, "nolock-" + i));
  const res = await runConcurrent(ctx, bodies, { noLock: true, slowRead: 40 });
  assert.ok(res.filter((r) => r.ok).length > 1, "ilman lukkoa useampi heitto meni läpi samalla oikeudella");
});
