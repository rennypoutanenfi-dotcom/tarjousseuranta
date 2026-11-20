# Myyntimonopoli – taloussimulaatio

Toistettava ajo: `node mm/sim.js 200` (siemenet 1–200 kussakin skenaariossa). Pelitasapainon havaintotyökalu, ei todiste reiluudesta. Arvot ovat ensimmäisen version oletuksia; mitään palkkiota ei ole muutettu simulaation perusteella.

Pelaajat käyttävät kaikki vuoronsa joka ilta: ostavat vapaan tontin, jos kassaa jää yli 20 000 €, ja hankkivat yhden auton vuorossa. Kauppa tulee 3–10 päivää tarjouksesta, luovutus 2–5 päivää kaupasta (80 %). Tulos = oikea työ + saadut pelikatteet − realisointitappiot (ostot eivät muuta nettovarallisuutta; tämä tarkistetaan jokaisessa ajossa, samoin kirjanpidon täsmäys).

## A) Sama työ (40 tarjousta, hitrate 28 %), tasapainoinen vs. sähköautopainotteinen varasto

| Varasto | Tulos ka. | Hajonta | Oikea työ | Saadut katteet | Realisointitappiot | Pakko-ostot / kk | Tukkurille tilan puutteessa | Velkaa kauden lopussa | Voittaa |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Tasapainoinen | 77 629 € | 17 381 € | 73 031 € | 7 828 € | −3 230 € | 3,5 | 0,43 | 5,8 % (ka. 1 356 €) | 15,3 % |
| Sähköautopainotteinen | 86 771 € | 20 408 € | 73 079 € | 15 690 € | −1 998 € | 3,8 | 0,31 | 19,3 % (ka. 6 030 €) | 35 % |
| Kaikki sähköautoilla (C) | 86 919 € | 20 936 € | 73 714 € | 15 345 € | −2 141 € | 3,3 | 0,22 | 28,3 % (ka. 15 680 €) | 25,1 % |

## B) Eri työmäärät, kaikilla tasapainoinen varasto

| Pelaaja | Työ / kk | Tulos ka. | Hajonta | Oikea työ | Saadut katteet | Realisointitappiot | Vuoroja | Voittaa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| P1 | 55 tarjousta, 36 % | 130 648 € | 22 767 € | 130 264 € | 7 775 € | −7 391 € | 24,1 | 95 % |
| P2 | 42 tarjousta, 30 % | 88 362 € | 17 193 € | 82 959 € | 8 125 € | −2 723 € | 16,4 | 4,5 % |
| P3 | 32 tarjousta, 24 % | 57 019 € | 15 188 € | 51 007 € | 6 978 € | −965 € | 11,2 | 0,5 % |
| P4 | 22 tarjousta, 17 % | 28 831 € | 9 911 € | 26 433 € | 3 448 € | −1 050 € | 6,4 | 0 % |

## Havainnot

- Oikea työ on tuloksen suurin osa: B-skenaariossa ahkerimman ja vähiten työtä tehneen ero on keskimäärin 101 817 €, josta työn osuus 103 831 € (102 %). Ahkerin voittaa 95 % kuukausista.
- Pelin osuus (katteet − tappiot) on 4 598 € tasapainoisella ja 13 692 € sähköautopainotteisella varastolla samalla työllä. Tulosten hajonta samalla työllä (17 381 € / 20 408 €) kertoo, paljonko arpaonni ja laudan tapahtumat vaikuttavat.
- Sähköautopainotteinen varasto voittaa samalla työllä 35 % kuukausista (tasapainoinen 15,3 %). Se tuottaa enemmän katetta osumista, mutta altistaa pakko-ostoissa velalle ja tilan puutteessa 85 %:n tukkurimyynnin tappioille.
- Kun kaikki pelaavat sähköautoilla (C), velkaa on kauden lopussa 28,3 % pelaajista ja tukkurirealisointeja tilan puutteessa 0,22 pelaajaa kohden kuukaudessa.
- Säädettävät arvot seuraavalle kaudelle: huoneen ylläpitäjä voi muuttaa alkukassaa, tontin hintaa ja työpalkkioita Huone-välilehdellä; luokkahinnat, katteet, kanavaprosentit ja boostitaulukko ovat sääntöversion kenttiä (mm/engine.js DEFAULT_RULES ja palvelimen mm_room_rules).

