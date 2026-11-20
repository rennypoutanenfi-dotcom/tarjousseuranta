/*
 * Myyntimonopoli – tarjousseurannan adapteri
 * ---------------------------------------------------------------
 * Muuntaa tarjousseurannan palvelimelle tallentaman myyjän kuukausidatan
 * (Sellers-taulukon months_json) ostotapauksiksi ja työtapahtumiksi.
 * Puhdas funktio: ei kelloa, ei tallennusta. Sama koodi palvelimella ja testeissä.
 *
 * Lähde tarjousseurannassa (selväkieliset kentät, salattuja lisätietoja ei tarvita):
 *   months[mk].offers[]   kuluvan kuun tarjoukset    { id, ts, closed, closedTs, st, lv, bk }
 *   months[mk].carry[]    kuukaudesta siirtyneet avoimet tarjoukset ja luovutusta odottavat kaupat
 *   months[mk].cases[]    tiivistetyt päättyneet tapaukset [id, tarjousMin, kauppaMin, luovutusMin]
 *   months[mk].lost[]     hävityt tarjoukset { id, ts, lt }
 *   months[mk].del[]      käyttäjän poistamat tarjoukset (id:t)
 *   months[mk].days{}     päiväkohtaiset määrät { "dd": [tarjoukset, kaupat] } (vanhat tiivistetyt kuukaudet)
 *
 * Työvaiheet:
 *   offer     tarjous kirjattu tarjousseurantaan (sovelluksessa ei ole luonnosvaihetta:
 *             kirjaus tehdään, kun tarjous on annettu asiakkaalle)
 *   deal      tarjous merkitty kaupaksi (closed + closedTs); uudelleenavaus = peruuntunut kauppa
 *   handover  kaupan luovutuksen tarkistuslista valmis ja luovutuksen hoiti myyjä itse
 */
var MMAdapter = (function () {
  "use strict";
  var SOURCE = "tarjousseuranta";
  var MIN = 60000;
  // Luovutuksen tarkistuslista (bittimaski). Sama lista on tarjousseurannan käyttöliittymässä.
  var LV_ITEMS = [
    "Auto pesty ja tankattu/ladattu",
    "Kauppapaperit allekirjoitettu",
    "Avaimet ja ohjeet luovutettu",
    "Rekisteröinti ja vakuutus kunnossa",
    "Asiakas opastettu autoon",
    "Jatkoyhteydenotto sovittu"
  ];
  var LV_ALL = (1 << LV_ITEMS.length) - 1;

  function ms(iso) {
    if (iso === null || iso === undefined || iso === "") return 0;
    if (typeof iso === "number") return iso;
    var t = Date.parse(iso);
    return isNaN(t) ? 0 : t;
  }
  function lvDone(o) { return !!(o && o.lv && o.lv.ts && ((o.lv.c | 0) & LV_ALL) === LV_ALL && !o.lv.x); }
  function isMonthKey(k) { return /^\d{4}-\d{2}$/.test(k); }

  // Tapaukset myyjän koko datasta. Palauttaa { cases: {id: {...}}, del: {id: true}, pseudo: [] }.
  function extract(months, hk) {
    var cases = {}, del = {}, pseudo = [];
    months = months || {};
    function put(id, c, full) {
      if (!id) return;
      var ex = cases[id];
      if (!ex) { cases[id] = c; return; }
      // täydellinen tietue voittaa tiivistetyn; tarjousaika = varhaisin
      var f = Math.min(ex.f || Infinity, c.f || Infinity);
      if (full && !ex.full) { cases[id] = c; }
      else if (full && ex.full) {
        // sama tapaus kahdessa täydessä tietueessa (esim. vanha laite): yhdistetään varovasti
        cases[id] = { f: 0, d: ex.d || c.d, h: ex.h || c.h, lost: ex.lost && c.lost, full: true };
      }
      cases[id].f = f === Infinity ? 0 : f;
    }
    function fromOffer(o) {
      if (!o || !o.id || o.bk) return; // bk = "Lisää kuukausi" -toiminnon massakirjaus, ei yksittäistä työtä
      var closed = !!o.closed && !!o.closedTs;
      put(o.id, { f: ms(o.ts), d: closed ? ms(o.closedTs) : 0, h: closed && lvDone(o) ? ms(o.lv.ts) : 0,
        lost: !o.closed && o.st === "l", full: true }, true);
    }
    Object.keys(months).forEach(function (mk) {
      if (!isMonthKey(mk)) return;
      var doc = months[mk] || {};
      (doc.offers || []).forEach(fromOffer);
      (doc.carry || []).forEach(fromOffer);
      (doc.cases || []).forEach(function (r) {
        if (!r || !r[0]) return;
        put(String(r[0]), { f: (r[1] || 0) * MIN, d: (r[2] || 0) * MIN, h: (r[3] || 0) * MIN, lost: !r[2], full: false }, false);
      });
      (doc.lost || []).forEach(function (x) {
        if (!x || !x.id || cases[x.id]) return;
        put(x.id, { f: ms(x.ts), d: 0, h: 0, lost: true, full: false }, false);
      });
      (doc.del || []).forEach(function (id) { del[id] = true; });
    });
    // Vanhat tiivistetyt kuukaudet (ennen tapauskohtaista tallennusta): päiväkohtaisista määristä
    // johdetaan anonyymit tapaukset vain hitraten otokseen. Kuukauden kaikki tarjoukset ovat joko
    // siirtyneitä (carry), hävittyjä (lost) tai kuukauden aikana kaupaksi tulleita.
    if (hk) Object.keys(months).forEach(function (mk) {
      if (!isMonthKey(mk)) return;
      var doc = months[mk] || {};
      if ((doc.offers && doc.offers.length) || doc.cases || !doc.days) return;
      var y = +mk.slice(0, 4), m = +mk.slice(5, 7);
      var known = {};
      (doc.carry || []).concat(doc.lost || []).forEach(function (o) {
        var t = ms(o.ts); if (!t) return;
        var p = hk.hkParts(t);
        if (p.y === y && p.m === m) known[p.d] = (known[p.d] || 0) + 1;
      });
      var monthEnd = hk.hkToUtc(y, m + 1, 1, 0, 0) - MIN;
      Object.keys(doc.days).forEach(function (dd) {
        var n = ((doc.days[dd] || [])[0] | 0) - (known[+dd] || 0);
        for (var i = 0; i < n; i++) pseudo.push({ id: "~" + mk + "-" + dd + "-" + i, f: hk.hkToUtc(y, m, +dd, 12, 0), d: monthEnd, pseudo: true });
      });
    });
    return { cases: cases, del: del, pseudo: pseudo };
  }

  // Työtapahtumat yhtenäisessä muodossa (lähde, tunniste, versio, tapaus, vaihe, tekijä, aika, voimassaolo).
  function events(nick, months, hk) {
    var x = extract(months, hk), out = [];
    Object.keys(x.cases).forEach(function (id) {
      var c = x.cases[id], deleted = !!x.del[id];
      [["offer", c.f], ["deal", c.d], ["handover", c.h]].forEach(function (s) {
        out.push({ source: SOURCE, eventId: SOURCE + ":" + nick + ":" + id + ":" + s[0], version: s[1] + (deleted ? ":del" : ""),
          caseId: id, stage: s[0], actor: nick, at: s[1] || null, valid: !!s[1] && !deleted });
      });
    });
    return out;
  }

  return { SOURCE: SOURCE, LV_ITEMS: LV_ITEMS, LV_ALL: LV_ALL, extract: extract, events: events, lvDone: lvDone, ms: ms };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MMAdapter;
