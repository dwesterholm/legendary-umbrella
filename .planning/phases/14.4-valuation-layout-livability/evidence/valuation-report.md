# Valuation report: what replacing the 20 % ceiling with real features did (VAL-05)

Snapshot 2026-10-13. Before = the frozen run with the version-1 model and the ceiling on. After = the committed model (version 2) with no ceiling. Offline replay of stored data: nothing was fetched and no setting was changed.

How to read this: "Kredit" is the part of a flat's gap (renovated resale value minus expected final price) that the profit counts. The old ceiling cut it at 20 % of resale; now it is the whole gap. Every row below shows where its credit moved and which cause moved it, in kronor.

## Rows that hit the 20 % ceiling before

17 rows carried the old ceiling flag in the frozen record. Each row is followed from the old credit to the new one. Every kr column is a change in the credit (+ raises it, - lowers it), and from "Tak borttaget" onwards they add up to "Skillnad efter" minus "Kredit före".

| Adress | Plats före -> efter | Kredit före | Tak borttaget | Ny anpassning | Avgift | BRF-skuld | Tomträtt | Övrigt | Skillnad efter | Residual | Flagga (förv. slutpris / utgångspris) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Fatburs Kvarngata 18 | 1 -> 1 | 1 291 130 | +882 989 | +89 104 | -77 917 | +34 437 | 0 | +111 760 | 2 331 503 | -30,6 % | ja / ja |
| Erstagatan 21 | 2 -> 11 | 1 222 441 | +163 186 | +525 678 | -223 192 | -208 699 | 0 | -33 025 | 1 446 389 | -18,4 % | nej / ja |
| Fatburstrappan 18 | 3 -> 3 | 1 324 414 | +796 309 | +69 172 | -128 533 | -103 392 | 0 | +110 322 | 2 068 292 | -26,4 % | ja / ja |
| Tjurbergsgatan 38 | 4 -> 5 | 1 149 609 | +165 022 | +403 843 | -59 599 | +59 310 | 0 | -21 061 | 1 697 124 | -22,5 % | ja / ja |
| Sysslomansgatan 26 | 5 -> 6 | 1 129 602 | +262 850 | +249 286 | -58 798 | +24 844 | 0 | +4 760 | 1 612 544 | -21,0 % | ja / ja |
| Idungatan 5 | 6 -> 19 | 1 147 417 | +125 806 | -172 556 | +4 108 | 0 | 0 | +3 950 | 1 108 725 | -13,1 % | nej / ja |
| Hornsgatan 119 | 7 -> 9 | 1 198 845 | +572 137 | -167 402 | +16 449 | +31 948 | 0 | -10 980 | 1 640 997 | -21,9 % | ja / ja |
| Hagaesplanaden 63 | 10 -> 20 | 1 181 616 | +238 301 | -134 967 | -71 738 | -134 802 | 0 | +97 046 | 1 175 456 | -15,2 % | nej / nej |
| Sågargatan 14 | 11 -> 4 | 1 113 689 | +235 276 | +616 402 | -74 112 | +2 681 | 0 | -6 763 | 1 887 173 | -26,8 % | ja / ja |
| Falugatan 5 | 12 -> 2 | 1 347 156 | +790 364 | +379 289 | -75 095 | -24 643 | 0 | -33 644 | 2 383 426 | -29,2 % | ja / ja |
| Ola Hanssonsgatan 4 | 15 -> 13 | 1 032 905 | +350 521 | -149 814 | -61 796 | +7 263 | 0 | +13 194 | 1 192 273 | -17,7 % | nej / ja |
| Fyrverkarbacken 25 | 16 -> 8 | 1 042 096 | +711 592 | +33 635 | -78 397 | -100 799 | 0 | +2 871 | 1 610 998 | -27,3 % | ja / ja |
| Fyrverkarbacken 23 | 18 -> 12 | 1 056 320 | +759 818 | -235 223 | -77 354 | -101 720 | 0 | +2 927 | 1 404 769 | -22,3 % | ja / ja |
| Pokalvägen 4 | 19 -> 10 | 1 004 126 | +164 486 | +377 942 | -25 484 | +9 595 | 0 | +2 353 | 1 533 018 | -23,9 % | ja / ja |
| Reimersholmsgatan 39 | 20 -> 15 | 1 039 581 | +141 096 | +110 197 | -72 805 | +28 760 | 0 | -3 457 | 1 243 372 | -20,1 % | nej / ja |
| Lindvallsplan 10 | 24 -> 31 | 909 035 | +141 398 | -188 773 | -10 863 | -3 047 | 0 | +1 846 | 849 597 | -12,6 % | nej / ja |
| Fyrverkarbacken 27 | 25 -> 50 | 913 757 | +48 823 | -244 967 | -66 313 | -81 740 | 0 | +7 338 | 576 898 | -7,1 % | nej / nej |
| **Summa** | | 19 103 737 | +6 549 977 | +1 560 844 | -1 141 438 | -560 003 | 0 | +249 437 | 25 762 554 | | 10 / 15 rader |

"Ny anpassning" is the model refitted on today's data with the old six features and the same bid premium: the balcony and build-year effects, the other coefficients and the days-on-market term. "Övrigt" is what is left of the move from that model to the new one after avgift, debt and tomträtt are taken out: the refitted floor, location and size terms and the way the effects combine. Tomträtt is 0 because the model could not estimate it (no leasehold sales in the data).
