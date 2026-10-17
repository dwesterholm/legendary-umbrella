# Jämförelse av värderingskörningar

Offline: inget nätverk, ingen API-nyckel, inget betalt anrop.

## Folkungagatan 61 (150148)

plats 29 → 17

| Körning | Plats | Återförsäljning | Vinst | Kredit |
| --- | --- | --- | --- | --- |
| 14.4 (före) | 29 | 5 006 594 kr | 778 545 kr | 732 012 kr |
| 14.4 (efter) | 17 | 5 503 113 kr | 1 123 047 kr | 1 061 486 kr |

Första mot sista körningen: plats upp 12, återförsäljning +496 519 kr, vinst +344 502 kr, kredit +329 474 kr.

## Körningar

| Körning | Snapshot | Modell | Modelldatum | Rader i modellen | R2 | cvRmseLog | Rankade rader |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 14.4 (före) | 2026-10-13 | v1 | 2026-10-13 | 7 380 | 0,610 | 0,1152 | 77 |
| 14.4 (efter) | 2026-10-13 | v2 | 2026-10-12 | 7 379 | 0,611 | 0,1151 | 77 |

## Topp 15 bredvid varandra

| Plats | 14.4 (före) | 14.4 (efter) |
| --- | --- | --- |
| 1 | Fatburs Kvarngata 18, 1 277 085 kr | Fatburs Kvarngata 18, 2 318 010 kr |
| 2 | Erstagatan 21, 1 247 165 kr | Falugatan 5, 2 123 426 kr |
| 3 | Fatburstrappan 18, 1 243 273 kr | Fatburstrappan 18, 1 982 689 kr |
| 4 | Tjurbergsgatan 38, 1 175 043 kr | Sågargatan 14, 1 864 930 kr |
| 5 | Sysslomansgatan 26, 1 148 584 kr | Tjurbergsgatan 38, 1 727 703 kr |
| 6 | Idungatan 5, 1 142 386 kr | Sysslomansgatan 26, 1 638 343 kr |
| 7 | Hornsgatan 119, 1 132 308 kr | Klippgatan 14E, 1 636 712 kr |
| 8 | Klippgatan 14E, 1 110 148 kr | Fyrverkarbacken 25, 1 586 168 kr |
| 9 | Kungsklippan 20, 1 104 427 kr | Hornsgatan 119, 1 573 814 kr |
| 10 | Hagaesplanaden 63, 1 091 780 kr | Pokalvägen 4, 1 519 265 kr |
| 11 | Sågargatan 14, 1 087 775 kr | Erstagatan 21, 1 467 857 kr |
| 12 | Falugatan 5, 1 087 156 kr | Fyrverkarbacken 23, 1 336 563 kr |
| 13 | Kungsbro Strand 19, 1 049 066 kr | Ola Hanssonsgatan 4, 1 191 212 kr |
| 14 | Hagaesplanaden 73, 1 034 775 kr | Kungsbro Strand 19, 1 178 529 kr |
| 15 | Ola Hanssonsgatan 4, 1 033 329 kr | Fridhemsgatan 41, 1 126 397 kr |

## Största platsförflyttningar

Mellan första ("14.4 (före)") och sista ("14.4 (efter)") körningen. Plus betyder att lägenheten steg.

| Adress | Platser | Förflyttning |
| --- | --- | --- |
| Fridhemsgatan 41 | 40 → 15 | +25 |
| Fyrverkarbacken 27 | 25 → 50 | -25 |
| Tegelviksgatan 18 | 41 → 66 | -25 |
| Tideliusgatan 55 | 34 → 58 | -24 |
| Blekingegatan 36 | 36 → 59 | -23 |
| Wennerbergsgatan 6A | 54 → 33 | +21 |
| Heleneborgsgatan 30A | 47 → 28 | +19 |
| Gyllenborgsgatan 15 | 63 → 44 | +19 |
| Bergsundsgatan 14 | 55 → 40 | +15 |
| Frödingsvägen 9 | 72 → 57 | +15 |

## Koefficienter (steg 1)

Varje egenskap som beta ± SE. Ett streck betyder att kolumnen inte har någon modellfil eller att modellen saknar egenskapen.

| Egenskap | 14.4 (före) | 14.4 (efter) |
| --- | --- | --- |
| nbLevel | - | 1,066 ± 0,01186 |
| floor | - | 0,01513 ± 0,0008806 |
| groundOrBelow | - | -0,06722 ± 0,007977 |
| lnArea | - | 0,04467 ± 0,005508 |
| monthsAgo | - | -0,007753 ± 0,0002702 |
| centralityKm | - | -0,007109 ± 0,004214 |
| avgiftPerSqmMonth | - | -0,0006436 ± 0,0001967 |
| brfDebtPerSqm | - | -0,000002390 ± 8,272e-7 |
| tomtratt | - | 0,000 ± - |

## Steg 2

Värdet modellen använder, markerat när det ligger på den egna modellens tak.

| Värde | 14.4 (före) | 14.4 (efter) |
| --- | --- | --- |
| Balkong | - | +8,0 % (på taket ±8 %) |
| Byggår till 1930 | - | +3,9 % |
| Byggår 1931–1960 | - | -2,9 % |
| Byggår 1961–1990 | - | -8,0 % (på taket ±8 %) |
| Byggår från 1991 | - | -4,5 % |

Steg-2-SE saknas utan fit-rapport: 14.4 räknade ingen steg-2-SE, och den visas inte som en påhittad siffra.
