// Tiedostopohjainen ympäristö samanaikaisuustestiin: useat prosessit/säikeet jakavat saman tallennuksen.
// Lukko = hakemiston luonti (atominen käyttöjärjestelmätasolla), kuten Apps Scriptin LockService koko skriptille.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const S = require("../server.js");

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function fileEnv(dir, opts) {
  opts = opts || {};
  const fileOf = (k) => path.join(dir, "kv", encodeURIComponent(k) + ".json");
  fs.mkdirSync(path.join(dir, "kv"), { recursive: true });
  const env = {
    store: {
      get(k) { if (opts.slowRead) sleep(opts.slowRead); try { return fs.readFileSync(fileOf(k), "utf8"); } catch (e) { return null; } },
      put(k, v) { const f = fileOf(k), tmp = f + "." + process.pid + "." + crypto.randomUUID(); fs.writeFileSync(tmp, v); fs.renameSync(tmp, f); }
    },
    now: () => opts.clock,
    rng: opts.rng || ((n) => crypto.randomInt(n)),
    withLock(fn) {
      if (opts.noLock) return fn();
      const lock = path.join(dir, "lock"), t0 = Date.now();
      for (;;) {
        try { fs.mkdirSync(lock); break; } catch (e) {
          if (e.code !== "EEXIST") throw e;
          if (Date.now() - t0 > 20000) { const b = new Error("busy"); b.mmBusy = true; throw b; }
          sleep(1 + Math.floor(Math.random() * 3));
        }
      }
      try { return fn(); } finally { fs.rmdirSync(lock); }
    },
    sellers() { return JSON.parse(fs.readFileSync(path.join(dir, "sellers.json"), "utf8")); },
    authenticate(nick, pin) {
      const s = env.sellers()[nick.trim().toLowerCase()];
      if (!s) return { ok: false, error: "not_found" };
      if (s.pin !== pin) return { ok: false, error: "bad_pin" };
      return { ok: true, nickname: s.nickname, company: s.company, months: s.months };
    },
    readSellers(keys) { const all = env.sellers(), out = {}; keys.forEach((k) => { if (all[k]) out[k] = all[k]; }); return out; },
    audit() {}
  };
  env.server = S.create(env);
  return env;
}
function writeSellers(dir, sellers) { fs.writeFileSync(path.join(dir, "sellers.json"), JSON.stringify(sellers)); }

module.exports = { fileEnv, writeSellers, sleep };
