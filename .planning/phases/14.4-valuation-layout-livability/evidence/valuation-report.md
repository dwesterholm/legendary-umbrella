# Valuation report: what replacing the 20 % ceiling with real features did (VAL-05)

Snapshot 2026-10-13. Before = the frozen run with the version-1 model and the ceiling on. After = the committed model (version 2) with no ceiling. Offline replay of stored data: nothing was fetched and no setting was changed.

How to read this: "Kredit" is the part of a flat's gap (renovated resale value minus expected final price) that the profit counts. The old ceiling cut it at 20 % of resale; now it is the whole gap. Every row below shows where its credit moved and which cause moved it, in kronor.

## Rows that hit the 20 % ceiling before

17 rows carried the old ceiling flag in the frozen record. Each row is followed from the old credit to the new one. Every kr column is a change in the credit (+ raises it, - lowers it), and from "Tak borttaget" onwards they add up to "Skillnad efter" minus "Kredit före".

| Adress | Plats före -> efter | Kredit före | Tak borttaget | Ny anpassning | Dagar | Avgift | BRF-skuld | Tomträtt | Övrigt | Skillnad efter | Residual | Flagga (förv. slutpris / utgångspris) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Fatburs Kvarngata 18 | 1 -> 1 | 1 291 130 | +882 989 | +117 513 | -28 409 | -77 917 | +34 437 | 0 | +111 760 | 2 331 503 | -30,6 % | ja / ja |
| Erstagatan 21 | 2 -> 11 | 1 222 441 | +163 186 | +335 041 | +190 637 | -223 192 | -208 699 | 0 | -33 025 | 1 446 389 | -18,4 % | nej / ja |
| Fatburstrappan 18 | 3 -> 3 | 1 324 414 | +796 309 | +112 524 | -43 352 | -128 533 | -103 392 | 0 | +110 322 | 2 068 292 | -26,4 % | ja / ja |
| Tjurbergsgatan 38 | 4 -> 5 | 1 149 609 | +165 022 | +316 182 | +87 661 | -59 599 | +59 310 | 0 | -21 061 | 1 697 124 | -22,5 % | ja / ja |
| Sysslomansgatan 26 | 5 -> 6 | 1 129 602 | +262 850 | +409 850 | -160 564 | -58 798 | +24 844 | 0 | +4 760 | 1 612 544 | -21,0 % | ja / ja |
| Idungatan 5 | 6 -> 19 | 1 147 417 | +125 806 | -57 985 | -114 570 | +4 108 | 0 | 0 | +3 950 | 1 108 725 | -13,1 % | nej / ja |
| Hornsgatan 119 | 7 -> 9 | 1 198 845 | +572 137 | -10 650 | -156 752 | +16 449 | +31 948 | 0 | -10 980 | 1 640 997 | -21,9 % | ja / ja |
| Hagaesplanaden 63 | 10 -> 20 | 1 181 616 | +238 301 | -258 740 | +123 773 | -71 738 | -134 802 | 0 | +97 046 | 1 175 456 | -15,2 % | nej / nej |
| Sågargatan 14 | 11 -> 4 | 1 113 689 | +235 276 | +406 324 | +210 078 | -74 112 | +2 681 | 0 | -6 763 | 1 887 173 | -26,8 % | ja / ja |
| Falugatan 5 | 12 -> 2 | 1 347 156 | +790 364 | +410 124 | -30 835 | -75 095 | -24 643 | 0 | -33 644 | 2 383 426 | -29,2 % | ja / ja |
| Ola Hanssonsgatan 4 | 15 -> 13 | 1 032 905 | +350 521 | -53 667 | -96 148 | -61 796 | +7 263 | 0 | +13 194 | 1 192 273 | -17,7 % | nej / ja |
| Fyrverkarbacken 25 | 16 -> 8 | 1 042 096 | +711 592 | +2 910 | +30 725 | -78 397 | -100 799 | 0 | +2 871 | 1 610 998 | -27,3 % | ja / ja |
| Fyrverkarbacken 23 | 18 -> 12 | 1 056 320 | +759 818 | +5 665 | -240 888 | -77 354 | -101 720 | 0 | +2 927 | 1 404 769 | -22,3 % | ja / ja |
| Pokalvägen 4 | 19 -> 10 | 1 004 126 | +164 486 | +207 941 | +170 001 | -25 484 | +9 595 | 0 | +2 353 | 1 533 018 | -23,9 % | ja / ja |
| Reimersholmsgatan 39 | 20 -> 15 | 1 039 581 | +141 096 | -304 116 | +414 313 | -72 805 | +28 760 | 0 | -3 457 | 1 243 372 | -20,1 % | nej / ja |
| Lindvallsplan 10 | 24 -> 31 | 909 035 | +141 398 | -57 832 | -130 941 | -10 863 | -3 047 | 0 | +1 846 | 849 597 | -12,6 % | nej / ja |
| Fyrverkarbacken 27 | 25 -> 50 | 913 757 | +48 823 | -277 489 | +32 522 | -66 313 | -81 740 | 0 | +7 338 | 576 898 | -7,1 % | nej / nej |
| **Summa** | | 19 103 737 | +6 549 977 | +1 303 594 | +257 251 | -1 141 438 | -560 003 | 0 | +249 437 | 25 762 554 | | 10 / 15 rader |

"Ny anpassning" is what changed between the frozen run and the model refitted on today's data with the old six features: the balcony and build-year effects (stage 2) and the refitted coefficients. "Dagar" is the days-on-market term that now sits in the bid premium, measured in that same refitted model. "Avgift", "BRF-skuld" and "Tomträtt" are what each fact takes off (-) or adds to (+) the credit in the new model, measured by scoring the flat again with that one fact set to unknown. "Övrigt" is what is left of the move from the refitted model to the new one: the other coefficients shifting when avgift and debt entered, and the way the effects combine. Tomträtt is 0 because the model could not estimate it (no leasehold sales in the data).

## Top 15 before and after

Left: the first 15 of the frozen run. Right: the first 15 of the new run. "Plats efter" is the listing's place in the new ranking, "Plats före" its place in the old one; "-" means it is not ranked in that run.

| # | Före: adress | Vinst före (kr) | Plats efter | Efter: adress | Vinst efter (kr) | Plats före |
|---:|---|---:|---:|---|---:|---:|
| 1 | Fatburs Kvarngata 18 | 1 277 085 | 1 | Fatburs Kvarngata 18 | 2 318 010 | 1 |
| 2 | Erstagatan 21 | 1 247 165 | 11 | Falugatan 5 | 2 123 426 | 12 |
| 3 | Fatburstrappan 18 | 1 243 273 | 3 | Fatburstrappan 18 | 1 982 689 | 3 |
| 4 | Tjurbergsgatan 38 | 1 175 043 | 5 | Sågargatan 14 | 1 864 930 | 11 |
| 5 | Sysslomansgatan 26 | 1 148 584 | 6 | Tjurbergsgatan 38 | 1 727 703 | 4 |
| 6 | Idungatan 5 | 1 142 386 | 19 | Sysslomansgatan 26 | 1 638 343 | 5 |
| 7 | Hornsgatan 119 | 1 132 308 | 9 | Klippgatan 14E | 1 636 712 | 8 |
| 8 | Klippgatan 14E | 1 110 148 | 7 | Fyrverkarbacken 25 | 1 586 168 | 16 |
| 9 | Kungsklippan 20 | 1 104 427 | 24 | Hornsgatan 119 | 1 573 814 | 7 |
| 10 | Hagaesplanaden 63 | 1 091 780 | 20 | Pokalvägen 4 | 1 519 265 | 19 |
| 11 | Sågargatan 14 | 1 087 775 | 4 | Erstagatan 21 | 1 467 857 | 2 |
| 12 | Falugatan 5 | 1 087 156 | 2 | Fyrverkarbacken 23 | 1 336 563 | 18 |
| 13 | Kungsbro Strand 19 | 1 049 066 | 14 | Ola Hanssonsgatan 4 | 1 191 212 | 15 |
| 14 | Hagaesplanaden 73 | 1 034 775 | 27 | Kungsbro Strand 19 | 1 178 529 | 13 |
| 15 | Ola Hanssonsgatan 4 | 1 033 329 | 13 | Reimersholmsgatan 39 | 1 160 872 | 20 |

## Folkungagatan 61

Booli 150148, the tracked listing.

| | Före | Efter |
|---|---:|---:|
| Plats | 29 | 18 |
| Vinst (kr) | 778 545 | 1 123 047 |
| Framtida värde, renoverad (kr) | 5 006 594 | 5 503 113 |
| Förväntat slutpris (kr) | 4 274 581 | 4 441 627 |
| Budpremie | +15,7 % | +20,2 % |
| Skillnad (kr) | 732 012 | 1 061 486 |
| Krediterad del (kr) | 732 012 | 1 061 486 |
| Renovering (kr) | 105 000 | 105 000 |
| Smak (kr) | 151 533 | 166 561 |

Where its credit moved (kr, + raises it, - lowers it): old credit 732 012; ceiling 0; refit (balcony, build year, coefficients) +522 906; days term -164 043; avgift -8 698; BRF debt 0; tomträtt 0; rest -20 691; new credit 1 061 486. Residual -12,6 % against the model, flag nej (expected final) / ja (asking). The parts add up to the move from old credit to new credit.

## Residual flag

The flag "ovanligt långt under modellpris" fires when a flat is further below the model's price than -20,5 % (two residual spreads). Counted over the 77 comparable rows of the new run:

| Basis | Rows flagged |
|---|---:|
| Expected final price against the model (in force) | 10 |
| Asking price against the model | 26 |

Switching the basis (`RESIDUAL_FLAG_BASIS` in fit-score.ts) would change only which rows carry the flag: 26 rows instead of 10. No profit figure changes either way.

The credit the ceiling removed: 6 549 977 kr over 17 rows (4 582 762 kr inside the old top 15).

## Bid premium

The expected overbid on the asking price, for the new top 15. "Före" is the same listing in the frozen run (version-1 model, no days term).

| Plats efter | Adress | Budpremie före | Budpremie efter | Hur den räknades |
|---:|---|---:|---:|---|
| 1 | Fatburs Kvarngata 18 | +22,5 % | +19,1 % | distrikt+pris+dagar, skick ej mätt |
| 2 | Falugatan 5 | +15,1 % | +12,7 % | distrikt+pris+dagar, skick ej mätt |
| 3 | Fatburstrappan 18 | +21,8 % | +18,8 % | distrikt+pris+dagar, skick ej mätt |
| 4 | Sågargatan 14 | +18,9 % | +11,0 % | distrikt+pris+dagar, skick ej mätt |
| 5 | Tjurbergsgatan 38 | +18,4 % | +14,2 % | distrikt+pris+dagar, skick ej mätt |
| 6 | Sysslomansgatan 26 | +12,1 % | +14,5 % | distrikt+pris+dagar, skick ej mätt |
| 7 | Klippgatan 14E | +16,8 % | +10,1 % | distrikt+pris+dagar, skick ej mätt |
| 8 | Fyrverkarbacken 25 | +15,4 % | +9,7 % | distrikt+pris+dagar, skick ej mätt |
| 9 | Hornsgatan 119 | +20,8 % | +21,7 % | distrikt+pris+dagar, skick ej mätt |
| 10 | Pokalvägen 4 | +18,5 % | +11,3 % | distrikt+pris+dagar, skick ej mätt |
| 11 | Erstagatan 21 | +18,3 % | +10,9 % | distrikt+pris+dagar, skick ej mätt |
| 12 | Fyrverkarbacken 23 | +15,7 % | +18,9 % | distrikt+pris+dagar, skick ej mätt |
| 13 | Ola Hanssonsgatan 4 | +12,9 % | +12,5 % | distrikt+pris+dagar, skick ej mätt |
| 14 | Kungsbro Strand 19 | +10,2 % | +6,4 % | distrikt+pris+dagar, skick ej mätt |
| 15 | Reimersholmsgatan 39 | +18,3 % | +2,9 % | distrikt+pris+dagar, skick ej mätt |

Mean change over the 77 rows ranked in both runs: -0,6 procentenheter.

Condition in the bid premium: not measured ("skick ej mätt"), the premium adds 0 for every flat. Reason: korsvalidering förkastade termen (0,06359 -> 0,06362, skattning -0,0086). corr(skick, utgångspris/modell) = 0,16; en effekt under ≈ 2 pp kan inte ses med n = 186.

## Model

Coefficients of the committed model (ln price per kvm; standard error = how much the estimate could move):

| Egenskap | Koefficient | SE | t | Källa | Effekt |
|---|---:|---:|---:|---|---|
| områdesnivå | 1,07 | 0,0119 | 89,9 | fit | - |
| våning | 0,0151 | 0,000881 | 17,2 | fit | - |
| bottenvåning | -0,0672 | 0,00798 | -8,4 | fit | - |
| storlek | 0,0447 | 0,00551 | 8,1 | fit | - |
| tidstrend | -0,00775 | 0,000270 | -28,7 | fit | - |
| avstånd till centrum | -0,00711 | 0,00421 | -1,7 | fit | - |
| avgift kr/kvm/mån | -0,000644 | 0,000197 | -3,3 | fit | -0,64 % per 10 kr/kvm/mån |
| föreningsskuld kr/kvm | -0,00000239 | 8,27e-7 | -2,9 | fit | -0,24 % per 1 000 kr/kvm |
| tomträtt | 0 | - | - | zeroed | - |

Stage 2 (balcony and build year, taken as percentages after the fit): balcony +8,0 %; build year to 1930 +3,9 %, 1931–1960 -2,9 %, 1961–1990 -8,0 %, from 1991 -4,5 %.
Days on market in the bid premium: coefficient -0,0351 per ln(1 + days), kept.

| | Före (version 1) | Efter (version 2) |
|---|---:|---:|
| Försäljningar i anpassningen | 7 380 | 7 379 |
| R² | 0,610 | 0,611 |
| Korsvalideringsfel (logskala) | 0,1152 | 0,1151 |

R² is the share of the variation in sold prices per kvm the model explains; the cross-validation error is the typical miss, in log units (0,1 is about 10 %), on sales the fit had not seen.

Fallbacks in the model file:
- tomtratt (absent): tomträtt: inga tomträttsförsäljningar i underlaget (upplåtelseform är Bostadsrätt på alla sålda sidor)

Correlation of avgift per kvm and BRF debt per kvm over the snapshot's listings that have both: r = 0,37 (n = 72).

## Findings

- The old ceiling hid 6 549 977 kr of credit across 17 rows, 4 582 762 kr of it inside the old top 15.
- 11 of the 15 listings in the new top 15 were also in the old top 15. Left: Idungatan 5 (6) -> 19, Kungsklippan 20 (9) -> 24, Hagaesplanaden 63 (10) -> 20, Hagaesplanaden 73 (14) -> 27. Entered: Fyrverkarbacken 25 (8) from 16, Pokalvägen 4 (10) from 19, Fyrverkarbacken 23 (12) from 18, Reimersholmsgatan 39 (15) from 20.
- The profits of the top 15 add up to 16 964 298 kr before and 24 306 093 kr after.
- Across the 17 formerly capped rows the credit moved by +6 658 817 kr in total: ceiling removal +6 549 977, refit +1 303 594, days term +257 251, avgift -1 141 438, BRF debt -560 003, tomträtt 0, rest +249 437. 7 of them rank higher now, 2 keep their place, 8 rank lower or are no longer ranked.
- 10 of the 17 formerly capped rows carry the residual flag on the expected-final basis, 15 on the asking basis.
- Over all 77 comparable rows the residual flag marks 10 on the expected-final basis and 26 on the asking basis (limit -20,5 % against the model; basis in force: expectedFinal).
- Folkungagatan 61 moved from rank 29 to 18; profit 778 545 -> 1 123 047 kr. Its credit moved +329 474 kr: ceiling 0, refit +522 906, days term -164 043, avgift -8 698, BRF debt 0, tomträtt 0, rest -20 691.
- Over the 77 rows ranked in both runs the expected overbid changed by -0,6 procentenheter on average.
- Avgift per kvm and BRF debt per kvm correlate at r = 0,37 over 72 listings that have both.
- These stage-2 coefficients sit exactly on the +-8 % limit the fit allows: balkong +8,0 %, byggår 1961–1990 -8,0 %. The fit clamps stage-2 effects at this limit, so the unclamped estimate may be larger than shown. Open point; nothing was changed.
