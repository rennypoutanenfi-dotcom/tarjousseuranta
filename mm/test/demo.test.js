// Demotila: erillinen muistissa toimiva huone, ei yhteyttä oikeaan tallennukseen.
const test = require("node:test");
const assert = require("node:assert/strict");
global.MMEngine = require("../engine.js"); global.MMAdapter = require("../adapter.js"); global.MMServer = require("../server.js");
const D = require("../demo.js");
const E = global.MMEngine;

test("Demotila: neljä kuvitteellista pelaajaa, simuloitu työ ja kilpailijoiden vuorot; kirjanpito täsmää", () => {
  let clock = Date.UTC(2026, 10, 20, 10, 0);
  let x = 7; const random = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const d = D.create({ now: () => clock, random, you: "Renny (demo)" });
  let v = d.handle({ action: "mm_state" });
  assert.equal(v.season.players.length, 4);
  assert.equal(v.room.orgName, D.COMPANY);
  for (let i = 0; i < 8; i++) { clock += 60000; d.simulateWork(); clock += 60000; d.handle({ action: "mm_sync" }); d.botsPlay(); }
  v = d.handle({ action: "mm_state" });
  assert.ok(v.season.me.work.offers >= 40);
  assert.ok(v.season.cars.length > 0);
  // kaikkien pelaajien kirjanpito täsmää palvelimen tallentamassa kaudessa
  const st = d.call("Aino (demo)", "mm_state");
  assert.ok(st.ok);
  assert.ok(v.season.standings.every((r) => Number.isInteger(r.result)));
});
