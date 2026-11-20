// Testiympäristö palvelimelle: muistitallennus, ohjattava kello, ohjattava satunnaisuus ja
// tarjousseurannan kaltainen myyjädata (Sellers.months_json).
const S = require("../server.js");

function memStore() {
  const m = new Map();
  return { m, get: (k) => (m.has(k) ? m.get(k) : null), put: (k, v) => { m.set(k, v); } };
}

function makeEnv(opts) {
  opts = opts || {};
  const env = {
    store: opts.store || memStore(),
    clock: opts.clock || Date.UTC(2026, 10, 2, 8, 0),
    rngQueue: [],
    sellers: opts.sellers || {},
    auditLog: [],
    locked: false
  };
  env.now = () => env.clock;
  env.rng = (n) => { if (env.rngQueue.length) { const v = env.rngQueue.shift(); return v % n; } return Math.floor(Math.random() * n); };
  env.withLock = (fn) => { if (env.locked) throw new Error("lock reentry"); env.locked = true; try { return fn(); } finally { env.locked = false; } };
  env.authenticate = (nick, pin) => {
    const s = env.sellers[nick.trim().toLowerCase()];
    if (!s) return { ok: false, error: "not_found" };
    if (s.pin !== pin) return { ok: false, error: "bad_pin" };
    return { ok: true, nickname: s.nickname, company: s.company, months: JSON.parse(JSON.stringify(s.months)) };
  };
  env.readSellers = (keys) => {
    const out = {};
    keys.forEach((k) => { const s = env.sellers[k]; if (s) out[k] = { nickname: s.nickname, company: s.company, months: JSON.parse(JSON.stringify(s.months)) }; });
    return out;
  };
  env.audit = (e) => env.auditLog.push(e);
  env.server = S.create(env);
  return env;
}

function seller(env, nickname, company, pin) {
  env.sellers[nickname.toLowerCase()] = { nickname, company, pin: pin || "1234", months: {} };
  return env.sellers[nickname.toLowerCase()];
}
function mkOf(ms) { const d = new Date(ms + 2 * 3600000); return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0"); }
let idc = 0;
// Tarjousseurannan tarjous (sama muoto kuin sovelluksen quickAddOffer)
function addOffer(sel, at, extra) {
  const mk = mkOf(at);
  const doc = sel.months[mk] || (sel.months[mk] = { monthKey: mk, workDays: 20, targetOffers: 40, offers: [] });
  const o = Object.assign({ id: "o" + (++idc), ts: new Date(at).toISOString(), source: 1, closed: false, closedTs: null, st: "o" }, extra || {});
  doc.offers.push(o);
  return o;
}
function closeDeal(o, at) { o.closed = true; o.closedTs = new Date(at).toISOString(); o.st = "d"; }
function reopen(o) { o.closed = false; o.closedTs = null; o.st = "o"; }
function handover(o, at) { o.lv = { c: 63, ts: new Date(at).toISOString() }; }
function del(sel, o) {
  Object.keys(sel.months).forEach((mk) => {
    const doc = sel.months[mk];
    const i = (doc.offers || []).findIndex((x) => x.id === o.id);
    if (i >= 0) { doc.offers.splice(i, 1); (doc.del || (doc.del = [])).push(o.id); }
  });
}

let idemSeq = 0;
function call(env, nick, action, body, idem) {
  const s = env.sellers[nick.toLowerCase()];
  const b = Object.assign({ action, nickname: s ? s.nickname : nick, pin: s ? s.pin : "x" }, body || {});
  if (S.ACTIONS[action] && S.ACTIONS[action].m && b.idem === undefined) b.idem = idem || "k" + (++idemSeq);
  return env.server.handle(b);
}

module.exports = { makeEnv, memStore, seller, addOffer, closeDeal, reopen, handover, del, call, mkOf };
