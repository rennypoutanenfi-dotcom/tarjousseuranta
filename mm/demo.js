/*
 * Myyntimonopoli – demotila (vain kehitys- ja esittelykäyttöön)
 * ---------------------------------------------------------------
 * Ajaa saman palvelinytimen (server.js) selaimen muistissa. Neljä kuvitteellista pelaajaa,
 * simuloidut työtapahtumat ja kilpailijoiden automaattiset vuorot. Mitään ei tallenneta
 * eikä lähetetä oikealle palvelimelle; sivun päivitys tyhjentää demon.
 */
var MMDemo = (function () {
  "use strict";
  var E = typeof MMEngine !== "undefined" ? MMEngine : require("./engine.js");
  var S = typeof MMServer !== "undefined" ? MMServer : require("./server.js");
  var COMPANY = "Demoautoliike";
  var DEFAULT_YOU = "Pelaaja (demo)";
  var BOTS = [
    { nick: "Aino (demo)", style: "balanced" },
    { nick: "Mikko (demo)", style: "electric" },
    { nick: "Sanna (demo)", style: "cheap" }
  ];

  function create(opts) {
    opts = opts || {};
    var YOU = opts.you || DEFAULT_YOU;
    var mem = {}, seq = 0;
    var now = opts.now || function () { return Date.now(); };
    var rnd = opts.random || Math.random;
    var sellers = {};
    function key(n) { return n.trim().toLowerCase(); }
    function addSeller(n) { sellers[key(n)] = { nickname: n, company: COMPANY, months: {} }; }
    [YOU].concat(BOTS.map(function (b) { return b.nick; })).forEach(addSeller);
    function mkOf(t) { var p = E.hkParts(t); return p.y + "-" + (p.m < 10 ? "0" : "") + p.m; }
    function offer(n, t, deal, ho) {
      var s = sellers[key(n)], mk = mkOf(t);
      var doc = s.months[mk] || (s.months[mk] = { monthKey: mk, offers: [] });
      var o = { id: "d" + (++seq) + "x" + Math.floor(rnd() * 1e6).toString(36), ts: new Date(t).toISOString(), source: 1, closed: false, closedTs: null, st: "o" };
      if (deal) { o.closed = true; o.closedTs = new Date(t + deal).toISOString(); o.st = "d"; }
      if (deal && ho) o.lv = { c: 63, ts: new Date(t + deal + ho).toISOString() };
      doc.offers.push(o);
      return o;
    }
    var env = {
      store: { get: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; }, put: function (k, v) { mem[k] = v; } },
      now: now,
      rng: function (n) { return Math.floor(rnd() * n); },
      withLock: function (fn) { return fn(); },
      authenticate: function (n) { var s = sellers[key(n)]; return s ? { ok: true, nickname: s.nickname, company: s.company, months: JSON.parse(JSON.stringify(s.months)) } : { ok: false, error: "not_found" }; },
      readSellers: function (keys) { var o = {}; keys.forEach(function (k) { if (sellers[k]) o[k] = JSON.parse(JSON.stringify(sellers[k])); }); return o; },
      audit: function () {}
    };
    var server = S.create(env);
    var idc = 0;
    function call(n, action, body) {
      var b = { action: action, nickname: n, pin: "demo" };
      if (S.ACTIONS[action] && S.ACTIONS[action].m) b.idem = "demo-" + (++idc);
      Object.keys(body || {}).forEach(function (k) { b[k] = body[k]; });
      return server.handle(b);
    }
    // Historia hitratea varten: 60 päivää tarjouksia ja kauppoja ennen demon alkua (ei pelirahaa).
    var t0 = now();
    [YOU].concat(BOTS.map(function (b) { return b.nick; })).forEach(function (n, i) {
      var rate = [0.31, 0.24, 0.36, 0.18][i];
      for (var d = 60; d >= 1; d--) {
        var k = Math.floor(rnd() * 2) + (d % 3 === 0 ? 1 : 0);
        for (var j = 0; j < k; j++) {
          var ot = t0 - d * 86400000 + j * 3600000, dl = rnd() < rate ? (1 + Math.floor(rnd() * 6)) * 86400000 : 0;
          if (ot + dl > t0 - 3600000) dl = 0; // historian kaupat ennen demon alkua
          offer(n, ot, dl, 0);
        }
      }
    });
    var r = call(YOU, "mm_room_create", { name: "Demohuone" });
    BOTS.forEach(function (b) { call(b.nick, "mm_room_join", { roomId: r.room.id }); });
    call(YOU, "mm_room_start", {});

    // Simuloitu työpäivä: muutama tarjous kaikille, välillä kauppa ja luovutus.
    function simulateWork(who) {
      var t = now(), out = [];
      [YOU].concat(BOTS.map(function (b) { return b.nick; })).forEach(function (n) {
        if (who && who !== n) return;
        var k = n === YOU ? 5 : 3 + Math.floor(rnd() * 4);
        for (var i = 0; i < k; i++) {
          var deal = rnd() < 0.3 ? 1000 : 0;
          offer(n, t - k + i, deal ? 1 : 0, deal && rnd() < 0.6 ? 1 : 0);
        }
        out.push(n);
      });
      return out;
    }
    // Kilpailijat pelaavat ansaitut vuoronsa yksinkertaisella strategialla.
    function botsPlay() {
      var log = 0;
      BOTS.forEach(function (b) {
        for (var guard = 0; guard < 12; guard++) {
          var v = call(b.nick, "mm_state");
          if (!v.season || !v.season.me || v.season.me.work.avail <= 0) break;
          var rr = call(b.nick, "mm_roll", {});
          if (!rr.ok) break;
          log++;
          var t = rr.result.turn, me = rr.season.me, sq = rr.season.board[t.to];
          if (sq.kind === "tile" && !rr.season.tiles[t.to] && me.tiles.length < 3 && me.debt === 0 && me.cash > 9000000) {
            call(b.nick, "mm_buy_tile", { turnId: t.id });
          }
          var v2 = call(b.nick, "mm_state"), me2 = v2.season.me;
          var cls = b.style === "electric" ? "ELECTRIC" : b.style === "cheap" ? (rnd() < 0.7 ? "DIESEL" : "PETROL_HYBRID") : ["DIESEL", "PETROL_HYBRID", "ELECTRIC"][Math.floor(rnd() * 3)];
          var price = v2.season.rules.classes[cls].buy;
          var tile = me2.tiles.filter(function (ti) { return v2.season.cars.filter(function (c) { return c.loc && c.loc.t === "tile" && c.loc.tile === ti; }).length < 3; })[0];
          if (tile !== undefined && me2.debt === 0 && me2.cash >= price + 2000000) call(b.nick, "mm_bank_buy", { turnId: t.id, tile: tile, cls: cls });
          else if (me2.recv && tile !== undefined) call(b.nick, "mm_move", { turnId: t.id, carId: me2.recv, dest: tile });
          call(b.nick, "mm_end_turn", { turnId: t.id });
        }
      });
      return log;
    }
    return {
      you: YOU,
      handle: function (body) { var b = JSON.parse(JSON.stringify(body)); b.nickname = YOU; b.pin = "demo"; return server.handle(b); },
      simulateWork: simulateWork, botsPlay: botsPlay, call: call, sellers: sellers
    };
  }
  return { create: create, BOTS: BOTS, COMPANY: COMPANY };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MMDemo;
