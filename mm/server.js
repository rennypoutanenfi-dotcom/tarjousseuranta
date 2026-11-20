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
