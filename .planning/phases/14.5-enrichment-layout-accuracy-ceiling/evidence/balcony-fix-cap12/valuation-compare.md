# Jämförelse av värderingskörningar

Offline: inget nätverk, ingen API-nyckel, inget betalt anrop.

## Folkungagatan 61 (150148)

plats 15 → 16

| Körning | Plats | Återförsäljning | Vinst | Kredit |
| --- | --- | --- | --- | --- |
| 14.5 ±12 %, balkong ocentrerad (före rättningen) | 15 | 5 508 047 kr | 1 144 996 kr | 1 083 286 kr |
| 14.5 ±12 %, balkong centrerad (efter rättningen) | 16 | 5 288 313 kr | 938 661 kr | 883 601 kr |

Första mot sista körningen: plats ned 1, återförsäljning -219 734 kr, vinst -206 335 kr, kredit -199 685 kr.

## Körningar

| Körning | Snapshot | Modell | Modelldatum | Rader i modellen | R2 | cvRmseLog | Rankade rader |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 14.5 ±12 %, balkong ocentrerad (före rättningen) | 2026-10-13 | v2 | 2026-10-12 | 7 381 | 0,616 | 0,1143 | 77 |
| 14.5 ±12 %, balkong centrerad (efter rättningen) | 2026-10-13 | v2 | 2026-10-12 | 7 381 | 0,616 | 0,1143 | 77 |

## Topp 15 bredvid varandra

| Plats | 14.5 ±12 %, balkong ocentrerad (före rättningen) | 14.5 ±12 %, balkong centrerad (efter rättningen) |
| --- | --- | --- |
| 1 | Fatburs Kvarngata 18, 2 207 024 kr | Fatburs Kvarngata 18, 1 967 290 kr |
| 2 | Falugatan 5, 2 030 844 kr | Falugatan 5, 1 780 075 kr |
| 3 | Fatburstrappan 18, 1 866 972 kr | Fatburstrappan 18, 1 626 869 kr |
| 4 | Sågargatan 14, 1 802 047 kr | Sågargatan 14, 1 585 245 kr |
| 5 | Tjurbergsgatan 38, 1 667 399 kr | Tjurbergsgatan 38, 1 444 708 kr |
| 6 | Sysslomansgatan 26, 1 628 272 kr | Sysslomansgatan 26, 1 405 235 kr |
| 7 | Klippgatan 14E, 1 580 607 kr | Klippgatan 14E, 1 359 982 kr |
| 8 | Pokalvägen 4, 1 522 184 kr | Pokalvägen 4, 1 329 923 kr |
| 9 | Hornsgatan 119, 1 413 322 kr | Fyrverkarbacken 25, 1 214 053 kr |
| 10 | Fyrverkarbacken 25, 1 388 579 kr | Hornsgatan 119, 1 203 231 kr |
| 11 | Erstagatan 21, 1 328 918 kr | Erstagatan 21, 1 115 990 kr |
| 12 | Ola Hanssonsgatan 4, 1 202 068 kr | Ola Hanssonsgatan 4, 1 018 931 kr |
| 13 | Fyrverkarbacken 23, 1 175 196 kr | Fyrverkarbacken 23, 999 055 kr |
| 14 | Fridhemsgatan 41, 1 171 057 kr | Fridhemsgatan 41, 961 945 kr |
| 15 | **Folkungagatan 61**, 1 144 996 kr | Ringvägen 162, 940 268 kr |

## Största platsförflyttningar

Mellan första ("14.5 ±12 %, balkong ocentrerad (före rättningen)") och sista ("14.5 ±12 %, balkong centrerad (efter rättningen)") körningen. Plus betyder att lägenheten steg.

| Adress | Platser | Förflyttning |
| --- | --- | --- |
| Tideliusgatan 55 | 63 → 68 | -5 |
| Stagneliusvägen 28 | 35 → 32 | +3 |
| Wennerbergsgatan 6A | 32 → 35 | -3 |
| Love Almqvists väg 4A | 38 → 36 | +2 |
| Fyrverkarbacken 27 | 56 → 54 | +2 |
| John Bergs Plan 4 | 55 → 57 | -2 |
| Orvar Odds väg 51 | 60 → 58 | +2 |
| Tobaksspinnargatan 10 | 59 → 61 | -2 |
| Levertinsgatan 5 | 66 → 64 | +2 |
| Creutzgatan 7 | 67 → 65 | +2 |

## Koefficienter (steg 1)

Varje egenskap som beta ± SE. Ett streck betyder att kolumnen inte har någon modellfil eller att modellen saknar egenskapen.

| Egenskap | 14.5 ±12 %, balkong ocentrerad (före rättningen) | 14.5 ±12 %, balkong centrerad (efter rättningen) |
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

| Värde | 14.5 ±12 %, balkong ocentrerad (före rättningen) | 14.5 ±12 %, balkong centrerad (efter rättningen) |
| --- | --- | --- |
| Balkong | +8,3 % | +8,3 % |
| Byggår till 1930 | +3,6 % | +3,6 % |
| Byggår 1931–1960 | -2,2 % | -2,2 % |
| Byggår 1961–1990 | -11,2 % | -11,2 % |
| Byggår från 1991 | -5,3 % | -5,3 % |

Steg-2-SE saknas utan fit-rapport: 14.4 räknade ingen steg-2-SE, och den visas inte som en påhittad siffra.
