# Jämförelse av värderingskörningar

Offline: inget nätverk, ingen API-nyckel, inget betalt anrop.

## Folkungagatan 61 (150148)

plats 15 → 16

| Körning | Plats | Återförsäljning | Vinst | Kredit |
| --- | --- | --- | --- | --- |
| 14.5 ±8 %, balkong ocentrerad (före rättningen) | 15 | 5 491 662 kr | 1 129 585 kr | 1 068 371 kr |
| 14.5 ±8 %, balkong centrerad (efter rättningen) | 16 | 5 280 587 kr | 931 420 kr | 876 594 kr |

Första mot sista körningen: plats ned 1, återförsäljning -211 075 kr, vinst -198 165 kr, kredit -191 777 kr.

## Körningar

| Körning | Snapshot | Modell | Modelldatum | Rader i modellen | R2 | cvRmseLog | Rankade rader |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 14.5 ±8 %, balkong ocentrerad (före rättningen) | 2026-10-13 | v2 | 2026-10-12 | 7 381 | 0,616 | 0,1143 | 77 |
| 14.5 ±8 %, balkong centrerad (efter rättningen) | 2026-10-13 | v2 | 2026-10-12 | 7 381 | 0,616 | 0,1143 | 77 |

## Topp 15 bredvid varandra

| Plats | 14.5 ±8 %, balkong ocentrerad (före rättningen) | 14.5 ±8 %, balkong centrerad (efter rättningen) |
| --- | --- | --- |
| 1 | Fatburs Kvarngata 18, 2 189 124 kr | Fatburs Kvarngata 18, 1 958 873 kr |
| 2 | Falugatan 5, 2 030 844 kr | Falugatan 5, 1 789 226 kr |
| 3 | Fatburstrappan 18, 1 849 044 kr | Fatburstrappan 18, 1 618 440 kr |
| 4 | Sågargatan 14, 1 785 858 kr | Sågargatan 14, 1 577 634 kr |
| 5 | Tjurbergsgatan 38, 1 667 399 kr | Tjurbergsgatan 38, 1 452 833 kr |
| 6 | Sysslomansgatan 26, 1 611 616 kr | Sysslomansgatan 26, 1 397 407 kr |
| 7 | Hornsgatan 119, 1 585 142 kr | Hornsgatan 119, 1 375 596 kr |
| 8 | Klippgatan 14E, 1 580 607 kr | Klippgatan 14E, 1 368 031 kr |
| 9 | Fyrverkarbacken 25, 1 531 288 kr | Fyrverkarbacken 25, 1 357 242 kr |
| 10 | Pokalvägen 4, 1 507 827 kr | Pokalvägen 4, 1 323 174 kr |
| 11 | Erstagatan 21, 1 328 918 kr | Fyrverkarbacken 23, 1 143 567 kr |
| 12 | Fyrverkarbacken 23, 1 319 250 kr | Erstagatan 21, 1 123 758 kr |
| 13 | Ola Hanssonsgatan 4, 1 202 068 kr | Ola Hanssonsgatan 4, 1 025 612 kr |
| 14 | Fridhemsgatan 41, 1 155 438 kr | Fridhemsgatan 41, 954 606 kr |
| 15 | **Folkungagatan 61**, 1 129 585 kr | Ringvägen 162, 933 639 kr |

## Största platsförflyttningar

Mellan första ("14.5 ±8 %, balkong ocentrerad (före rättningen)") och sista ("14.5 ±8 %, balkong centrerad (efter rättningen)") körningen. Plus betyder att lägenheten steg.

| Adress | Platser | Förflyttning |
| --- | --- | --- |
| Folkskolegatan 3 | 65 → 68 | -3 |
| Ringvägen 162 | 17 → 15 | +2 |
| Stagneliusvägen 28 | 34 → 32 | +2 |
| Wennerbergsgatan 6A | 33 → 35 | -2 |
| Fyrverkarbacken 27 | 50 → 48 | +2 |
| Hornsbergs Strand 15F | 54 → 52 | +2 |
| Levertinsgatan 5 | 67 → 65 | +2 |
| Fyrverkarbacken 23 | 12 → 11 | +1 |
| Erstagatan 21 | 11 → 12 | -1 |
| Folkungagatan 61 | 15 → 16 | -1 |

## Koefficienter (steg 1)

Varje egenskap som beta ± SE. Ett streck betyder att kolumnen inte har någon modellfil eller att modellen saknar egenskapen.

| Egenskap | 14.5 ±8 %, balkong ocentrerad (före rättningen) | 14.5 ±8 %, balkong centrerad (efter rättningen) |
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

| Värde | 14.5 ±8 %, balkong ocentrerad (före rättningen) | 14.5 ±8 %, balkong centrerad (efter rättningen) |
| --- | --- | --- |
| Balkong | +8,0 % (på taket ±8 %) | +8,0 % (på taket ±8 %) |
| Byggår till 1930 | +3,6 % | +3,6 % |
| Byggår 1931–1960 | -2,2 % | -2,2 % |
| Byggår 1961–1990 | -8,0 % (på taket ±8 %) | -8,0 % (på taket ±8 %) |
| Byggår från 1991 | -5,3 % | -5,3 % |

Steg-2-SE saknas utan fit-rapport: 14.4 räknade ingen steg-2-SE, och den visas inte som en påhittad siffra.
