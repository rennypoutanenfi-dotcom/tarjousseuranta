# Myyntimonopoli – käyttö- ja ylläpito-ohje

Myyntimonopoli on tarjousseurannan sisään rakennettu kuukausittainen autoliikepeli. Oikea työ (tarjoukset, kaupat, luovutukset) tuo pelirahaa ja vuoroja; pelaajat ostavat yhteiseltä laudalta tontteja, hankkivat niille autoja ja joutuvat pakko-ostoon osuessaan kilpailijan liikkeeseen.

## 1. Mistä peli avataan

- Alavalikko → **Myyntimonopoli** (myös etusivun työkalulistassa).
- Demotila: pelin aloitussivulta **Avaa demotila** tai osoitteen perään `?mmdemo=1`. Demossa on kolme kuvitteellista kilpailijaa, simuloitu työ ja automaattiset vuorot. Demo toimii selaimen muistissa eikä koske oikeaan huoneeseen, tallennukseen tai työpalkkioihin.

## 2. Rakenne

| Tiedosto | Sisältö |
| --- | --- |
| `mm/engine.js` | Pelimoottori: säännöt, lauta, aikavyöhyke, hitrate, vuorot, autot, kirjanpito, kauden sulku. Puhdas ja deterministinen (kello ja satunnaisuus annetaan ulkoa). |
| `mm/adapter.js` | Tarjousseurannan adapteri: myyjän `months_json` → ostotapaukset ja työtapahtumat. |
| `mm/server.js` | Palvelinydin: komennot, käyttöoikeudet, lukitus, idempotenssi, kaudet, työpalkkioiden täsmäytys. Alustariippumaton. |
| `mm/gas.js` | Apps Script -kytkentä: taulukkotallennus, LockService, kirjautuminen nykyisellä loginilla, satunnaisuus, ajastus. |
| `mm/apps-script/Myyntimonopoli.gs` | Koottu palvelintiedosto, joka liitetään Apps Scriptiin (`node mm/build.js`). |
| `mm/demo.js` | Demotila (vain kehitys/esittely). |
| `mm/sim.js`, `mm/SIMULAATIO.md` | Taloussimulaatio ja sen viimeisin raportti. |
| `mm/test/` | Testit. |
| `index.html` | Pelinäkymä (välilehti `mm`) ja tarjousseurannan muutokset. |

Pelitila on palvelimella samassa Google Sheets -tiedostossa kuin tarjoukset (uudet välilehdet **MM_Data** ja **MM_Log**). Selain ei tee arvontoja eikä laske palkkioita: se näyttää palvelimen tilan, lähettää komennot idempotenssiavaimella ja animoi tallennetun heiton. Yhteinen tila päivittyy pollaamalla 10 sekunnin välein, kun pelinäkymä on auki.

## 3. Palvelinosan asennus (kerran, noin 5 min)

1. Avaa tarjousseurannan Apps Script -projekti (sama, jonka Web app -osoite on sovelluksessa).
2. **Tiedostot → +** → Script → nimeksi `Myyntimonopoli`. Liitä sinne koko `mm/apps-script/Myyntimonopoli.gs`.
3. Avaa `Koodi.gs` ja lisää `doPost`-funktion **ensimmäiseksi riviksi**:
   ```js
   var mm = mmRoute(e); if (mm) return mm;
   ```
   Rivi käsittelee vain `mm_`-alkuiset pyynnöt; kaikki nykyiset toiminnot jatkuvat ennallaan.
4. Valitse ylävalikon funktiolistasta `mmInstall` ja paina **Run** (hyväksy käyttöoikeudet). Se luo välilehdet MM_Data ja MM_Log sekä tunnin välein ajettavan ylläpidon.
5. **Deploy → Manage deployments → kynä → Version: New version → Deploy.** Web app -osoite pysyy samana.
6. Jos skripti ei ole sidottu taulukkoon (Extensions → Apps Script), aseta Project Settings → Script properties: `MM_SHEET_ID` = taulukon tunniste.

Tarkistus: sovelluksen Myyntimonopoli-välilehdellä ei enää näy ilmoitusta ”Pelin palvelinosa puuttuu”.

Kirjautuminen: palvelinosa kutsuu nykyistä `login`-toimintoa (doPost), joten PIN tarkistetaan täsmälleen samalla tavalla kuin tarjousseurannassa. Varalla on suora vertailu Sellers-välilehden `pin_hash`-sarakkeeseen yleisillä SHA-256-muodoilla.

## 4. Ensimmäisen huoneen käyttöönotto

1. Jokaisella pelaajalla pitää olla tarjousseurannan profiilissa sama **yritys** (kirjainkoko ja välilyönnit eivät haittaa). Huoneet näkyvät vain saman yrityksen myyjille.
2. Yksi myyjä avaa Myyntimonopolin ja luo huoneen. Luojasta tulee huoneen ylläpitäjä.
3. Työkaverit (1–4) avaavat Myyntimonopolin ja painavat **Liity**.
4. Ylläpitäjä painaa **Aloita kausi nyt**. Ensimmäinen kausi alkaa kaikille samalla hetkellä ja päättyy kuun lopussa. Ennen alkua tehdyistä töistä ei tule pelirahaa (ne vaikuttavat vain hitrateen).
5. Seuraavat kaudet alkavat automaattisesti kuun vaihteessa kaikille huoneen jäsenille. Kesken kauden liittyvä pelaa seuraavalla kaudella. Poistuminen kesken kauden tapahtuu kauden lopussa.

## 5. Mihin tarjousseurannan tapahtumiin palkinnot on kytketty

Palkkiot syntyvät **palvelimella** Sellers-välilehden `months_json`-datasta. Peli ei tarjoa yhtään rajapintaa palkkion tai työsuorituksen luomiseen; selaimen lähettämät summat, tekijät tai työtiedot ohitetaan.

| Työvaihe | Tarjousseurannan tapahtuma | Palkkio | Pisteet |
| --- | --- | ---: | ---: |
| Aito tarjous | Tarjous kirjattu (Kirjaa tarjous / lähdepainike). Sovelluksessa ei ole luonnosvaihetta: kirjaus tehdään, kun tarjous on annettu, ja sama luku on jo tavoitteen ja hitraten pohja. | 500 € | 1 |
| Oikea kauppa | Tarjous merkitty kaupaksi (`closed` + `closedTs`). | 5 000 € × boosti | 4 |
| Hoidettu luovutus | Kaupan **luovutuksen tarkistuslista** (6 kohtaa) valmis tarjouskortissa ja luovutuksen hoiti myyjä itse. | 100 € | 0,25 |

Tapahtumarajapinta (`MMAdapter.events`): lähde `tarjousseuranta`, pysyvä tunniste `tarjousseuranta:<myyjä>:<tapaus>:<vaihe>`, lähdeversio, ostotapaus (tarjouksen id), vaihe, tekijä, aika ja voimassaolo. Palvelin tallentaa jokaisesta tapauksesta ensimmäisen havaintohetken (vastaanottoaika).

Säännöt:
- **Varmennettu aika** = tarjousseurannan aikaleima, kuitenkin enintään palvelimen havaintohetki ja enintään 72 h sitä aiemmin. Palkkio kuuluu sen kuukauden kaudelle (Suomen aikaa).
- **Sama työvaihe palkitaan kerran** (avain myyjä + vaihe + tapaus). Uusinta, hinnan tai auton muutos, lisätietojen muokkaus tai myyntitien eteneminen ei anna uutta palkkiota.
- **Kaupan peruminen** (kauppa avataan uudelleen): rahapalkkio oikaistaan alkuperäisellä summalla, pisteet säilyvät. Kun kauppa palautuu, sama summa palautuu kerran ilman uusia pisteitä. Luovutuslistan purku toimii samoin.
- **Tarjouksen poisto**: tarjous-, kauppa- ja luovutuspalkkio ja niiden pisteet korjataan. Jo pelattuja vuoroja ei kelata; uudet pisteet kuittaavat ensin vajeen.
- **Massakirjaus** (Lisää kuukausi -toiminto kuluvalle kuulle) merkitään `bk`, eikä siitä makseta.
- **Kollegan hoitama luovutus**: tarkistuslistan valinta ”Kollega hoiti luovutuksen” – palkkiota ei tule kaupan myyjälle. Tarjousseurannassa tapaus on vain myyjän omassa datassa, joten kollega ei saa luovutuspalkkiota tässä versiossa.

Milloin palvelin lukee työn:
1. Heti jokaisen tarjousseurannan tallennuksen jälkeen (sovellus lähettää kevyen `mm_sync`-pyynnön, jos käyttäjä on pelihuoneessa). Virhe tässä ei vaikuta tarjouksen tallennukseen.
2. Jokaisen pelin pyynnön yhteydessä koko huoneelle.
3. Tunnin välein ajastetusti (`mmHourly`).

### Tarjousseurannan muutokset

- **Luovutuksen tarkistuslista** kaupan tarjouskortissa (`lv` = { c: valitut kohdat, ts: valmistumisaika, x: kollega hoiti }) ja uusi suodatin **Tarjoukset → Luovutukset**.
- Kaupat, joiden luovutus on kesken, pysyvät näkyvissä kuun vaihtuessa (enintään 45 päivää). Aiemmin kuukaudesta siirtynyt tarjous katosi datasta heti kaupaksi merkittäessä; nyt se säilyy, kunnes luovutus on tehty.
- Kuun vaihteen tiivistys tallentaa päättyneet tapaukset kenttään `cases` ([id, tarjous, kauppa, luovutus] minuutteina). Yli neljä kuukautta vanhat poistetaan, jotta 50 000 merkin solu ei täyty.
- Poistetut tarjoukset kirjataan kuukauden `del`-listaan.
- Massakirjaukset merkitään `bk: 1`.

## 6. Kausi ja hitrate

- Kausi on kalenterikuukausi Europe/Helsinki-aikaa (kesä- ja talviaika huomioitu). Alku kuuluu kauteen, loppuhetki ei.
- Sulku tapahtuu kerran: ajastetusti tai ensimmäisen pyynnön yhteydessä kauden päätyttyä. Avoimet vuorot päätetään ilman Autovex-selvitystä, keskeneräiset listaukset perutaan, käyttämättömät vuorot raukeavat ja tulokset tallentuvat arkistoon.
- Myöhässä saapuva työtapahtuma voi korjata suljetun kauden rahatulosta; tulos merkitään **korjatuksi**. Suljettuun kauteen ei synny uusia vuoroja.
- **Hitrate-snapshot** maanantaina 00.00 Suomen aikaa (tai ensimmäisellä pyynnöllä sen jälkeen): tapaukset, joiden ensimmäinen tarjous on 7–60 kalenteripäivää ennen snapshotia; osoittajana snapshot-hetkeen mennessä vahvistetut ja voimassa olevat kaupat. Alle 20 tapausta → 1,00. Kerroin lukitaan viikoksi ja tallennetaan jokaiseen kauppapalkkioon.
- Vanhoille, jo tiivistetyille kuukausille (ennen tätä versiota) tapauskohtaista dataa ei ole. Niiden osalta otos johdetaan päiväkohtaisista määristä: kuukauden tarjoukset, joita ei ole siirtyneissä tai hävityissä, ovat kuukauden aikana kaupaksi tulleita. Nämä vaikuttavat vain hitrateen, eivät palkkioihin.

## 7. MVP-oletukset

| Asia | Valinta |
| --- | --- |
| Pakko-oston auto | Tasainen arvonta palvelimella myyntikelpoisista autoista (Autovex-listatut ja vastaanottopaikan autot eivät osallistu). |
| Huone | 2–5 pelaajaa, 16 tonttia, yksi omistaja tontilla; yksi huone käyttäjällä kerrallaan. |
| Organisaatio | Tarjousseurannan profiilin yritys-kenttä. |
| Ylläpitäjä | Huoneen luoja (sovelluksessa ei ole muuta roolimallia). Siirtyy seuraavalle jäsenelle, jos ylläpitäjä poistuu. |
| Vuorot | Asynkroniset, oma noppa jokaiselle, tuplat eivät anna lisäheittoa. |
| Tontit / varasto | 3 tonttia, 3 autoa tontilla, luokat vapaasti, 1 vastaanottopaikka. |
| Maksuvalmius | Pakko-ostoon koroton pelivelka; vapaaehtoiset ostot vaativat kassan ja nollavelan. |
| Pankkiasiakas | Omalle tontille osuessa minkä tahansa oman auton voi myydä hankintahintaan. |
| Kauden loppu | Vuorot raukeavat, listaukset perutaan, ei automaattista pelaamista. |
| Sääntömuutokset | Koskevat seuraavaa kautta; käynnissä olevan kauden säännöt lukitaan alussa. Käyttöliittymässä muokattavissa alkukassa, tontin hinta ja työpalkkioiden summat; muut arvot sääntöversiossa (`DEFAULT_RULES`, `mm_room_rules`). |
| Talouden tasapaino | Ensimmäisen version arvot. Simulaation havainnot: `mm/SIMULAATIO.md`. |

## 8. Testit

```
node --test mm/test/*.test.js     # moottori, palvelin, samanaikaisuus, Apps Script -mallit, demo
node mm/sim.js 200                # taloussimulaatio -> mm/SIMULAATIO.md
node mm/build.js                  # kokoaa mm/apps-script/Myyntimonopoli.gs
```

- `engine.test.js`: hyväksymiskriteerit 1–10, 12–16 ja 18–20 sekä satunnainen kirjanpitotesti.
- `server.test.js`: työpalkkiot tarjousseurannan datasta, idempotentti heitto (11), oikeudet (21), pysyvyys uudelleenkäynnistyksen yli (22), kuukausiraja ja suljetun kauden korjaus, hitrate-lukitus, huoneen hallinta, ajastettu ylläpito.
- `concurrency.test.js` (17): oikeat rinnakkaiset säikeet yhteistä tiedostotallennusta vastaan; vertailutesti ilman lukkoa osoittaa, että testi havaitsee tuplakäytön.
- `gas.test.js`: koottu Apps Script -tiedosto ajetaan Apps Scriptin palveluja jäljittelevillä malleilla (taulukko, lukko, Utilities, ContentService) ja mallinnetulla nykyisellä doPost-taustalla. Tämä ei ole aito Apps Script -ajo.

## 9. Ylläpito

- **MM_Log**: jokainen pelikomento, työpalkkioiden täsmäytys ja kauden sulku (aika, huone, kausi, pelaaja, toiminto, idempotenssiavain, tulos).
- **MM_Data**: pelin tila (hakemisto, huoneet, kaudet). Älä muokkaa käsin; rivit ovat JSON-paloja.
- Pelin nollaus: poista MM_Data-välilehti (luodaan uudelleen tyhjänä). Tarjousseurannan dataan peli ei kirjoita mitään.
- Pelin poisto kokonaan: poista `doPost`-rivi, Myyntimonopoli-tiedosto ja `mmHourly`-ajastin.

## 10. Tunnetut rajoitukset

- Työtieto on myyjän itse kirjaamaa, kuten tarjousseurannassa muutenkin. Peli ei voi varmistaa, että kirjattu tarjous on oikeasti annettu.
- Luovutuksen hoitanut kollega ei saa palkkiota (tapaus on vain myyjän datassa).
- Hitrate-snapshot lasketaan viimeistään ensimmäisellä pyynnöllä maanantain jälkeen; jos kauppa on avattu uudelleen ennen sitä, se ei näy snapshotissa.
- Jos vanha sovellusversio on auki jollain laitteella, se voi tiivistää kuukauden ilman tapauslistaa; tällöin poistoja ei tunnisteta ja palkkiot jäävät voimaan.
