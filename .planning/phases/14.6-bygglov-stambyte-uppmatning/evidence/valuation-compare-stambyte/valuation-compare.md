# Jämförelse av värderingskörningar

Offline: inget nätverk, ingen API-nyckel, inget betalt anrop.

## Folkungagatan 61 (150148)

plats 16 → 14

| Körning | Plats | Återförsäljning | Vinst | Kredit |
| --- | --- | --- | --- | --- |
| utan stambyte | 16 | 5 288 313 kr | 938 661 kr | 883 601 kr |
| med stambyte | 14 | 5 334 850 kr | 982 299 kr | 925 831 kr |

Första mot sista körningen: plats upp 2, återförsäljning +46 537 kr, vinst +43 638 kr, kredit +42 230 kr.

## Körningar

| Körning | Snapshot | Modell | Modelldatum | Rader i modellen | R2 | cvRmseLog | Rankade rader |
| --- | --- | --- | --- | --- | --- | --- | --- |
| utan stambyte | 2026-10-13 | v2 | 2026-10-12 | 7 381 | 0,616 | 0,1143 | 77 |
| med stambyte | 2026-10-13 | v2 | 2026-10-12 | 7 381 | 0,616 | 0,1143 | 77 |

## Topp 15 bredvid varandra

| Plats | utan stambyte | med stambyte |
| --- | --- | --- |
| 1 | Fatburs Kvarngata 18, 1 967 290 kr | Fatburs Kvarngata 18, 1 967 290 kr |
| 2 | Falugatan 5, 1 780 075 kr | Falugatan 5, 1 761 383 kr |
| 3 | Fatburstrappan 18, 1 626 869 kr | Fatburstrappan 18, 1 608 972 kr |
| 4 | Sågargatan 14, 1 585 245 kr | Sågargatan 14, 1 569 085 kr |
| 5 | Tjurbergsgatan 38, 1 444 708 kr | Sysslomansgatan 26, 1 443 284 kr |
| 6 | Sysslomansgatan 26, 1 405 235 kr | Tjurbergsgatan 38, 1 428 111 kr |
| 7 | Klippgatan 14E, 1 359 982 kr | Pokalvägen 4, 1 362 723 kr |
| 8 | Pokalvägen 4, 1 329 923 kr | Klippgatan 14E, 1 343 540 kr |
| 9 | Fyrverkarbacken 25, 1 214 053 kr | Fyrverkarbacken 25, 1 201 046 kr |
| 10 | Hornsgatan 119, 1 203 231 kr | Hornsgatan 119, 1 187 574 kr |
| 11 | Erstagatan 21, 1 115 990 kr | Erstagatan 21, 1 100 123 kr |
| 12 | Ola Hanssonsgatan 4, 1 018 931 kr | Ola Hanssonsgatan 4, 1 005 283 kr |
| 13 | Fyrverkarbacken 23, 999 055 kr | Fyrverkarbacken 23, 985 928 kr |
| 14 | Fridhemsgatan 41, 961 945 kr | **Folkungagatan 61**, 982 299 kr |
| 15 | Ringvägen 162, 940 268 kr | Karlsviksgatan 9, 953 536 kr |

## Största platsförflyttningar

Mellan första ("utan stambyte") och sista ("med stambyte") körningen. Plus betyder att lägenheten steg.

| Adress | Platser | Förflyttning |
| --- | --- | --- |
| Folkskolegatan 3 | 67 → 62 | +5 |
| Karlsviksgatan 9 | 19 → 15 | +4 |
| Alströmergatan 32A | 37 → 33 | +4 |
| Ringvägen 162 | 15 → 18 | -3 |
| Wennerbergsgatan 6A | 35 → 32 | +3 |
| Stagneliusvägen 28 | 32 → 35 | -3 |
| Bondegatan 80 | 33 → 36 | -3 |
| Tjurbergsgatan 34 | 38 → 41 | -3 |
| Olof Dalins väg 16 | 42 → 45 | -3 |
| Folkungagatan 61 | 16 → 14 | +2 |

## Koefficienter (steg 1)

Varje egenskap som beta ± SE. Ett streck betyder att kolumnen inte har någon modellfil eller att modellen saknar egenskapen.

| Egenskap | utan stambyte | med stambyte |
| --- | --- | --- |
| nbLevel | 1,050 ± 0,01193 | 1,050 ± 0,01193 |
| floor | 0,01561 ± 0,0008802 | 0,01561 ± 0,0008802 |
| groundOrBelow | -0,06617 ± 0,007934 | -0,06617 ± 0,007934 |
| lnArea | 0,04037 ± 0,005519 | 0,04037 ± 0,005519 |
| monthsAgo | -0,007826 ± 0,0002688 | -0,007826 ± 0,0002688 |
| centralityKm | -0,004365 ± 0,004201 | -0,004365 ± 0,004201 |
| avgiftPerSqmMonth | -0,001008 ± 0,0001137 | -0,001008 ± 0,0001137 |
| brfDebtPerSqm | -0,000002503 ± 5,283e-7 | -0,000002503 ± 5,283e-7 |
| tomtratt | 0,000 ± - | 0,000 ± - |

## Steg 2

Värdet modellen använder, markerat när det ligger på den egna modellens tak.

| Värde | utan stambyte | med stambyte |
| --- | --- | --- |
| Balkong | +8,3 % | +8,3 % |
| Byggår till 1930 | +3,6 % | +3,6 % |
| Byggår 1931–1960 | -2,2 % | -2,2 % |
| Byggår 1961–1990 | -11,2 % | -11,2 % |
| Byggår från 1991 | -5,3 % | -5,3 % |

Steg-2-SE saknas utan fit-rapport: 14.4 räknade ingen steg-2-SE, och den visas inte som en påhittad siffra.
