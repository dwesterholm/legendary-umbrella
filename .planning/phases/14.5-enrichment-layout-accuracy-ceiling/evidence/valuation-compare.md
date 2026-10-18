# Jämförelse av värderingskörningar

Offline: inget nätverk, ingen API-nyckel, inget betalt anrop.

## Folkungagatan 61 (150148)

plats 17 → 17 → 16

| Körning | Plats | Återförsäljning | Vinst | Kredit |
| --- | --- | --- | --- | --- |
| 14.4 (efter) | 17 | 5 503 113 kr | 1 123 047 kr | 1 061 486 kr |
| 14.5-kod, 14.4-modell | 17 | 5 503 113 kr | 1 123 047 kr | 1 061 486 kr |
| 14.5 ±8 % | 16 | 5 280 587 kr | 931 420 kr | 876 594 kr |

Första mot sista körningen: plats upp 1, återförsäljning -222 526 kr, vinst -191 627 kr, kredit -184 892 kr.

## Körningar

| Körning | Snapshot | Modell | Modelldatum | Rader i modellen | R2 | cvRmseLog | Rankade rader |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 14.4 (efter) | 2026-10-13 | v2 | 2026-10-12 | 7 379 | 0,611 | 0,1151 | 77 |
| 14.5-kod, 14.4-modell | 2026-10-13 | v2 | 2026-10-12 | 7 379 | 0,611 | 0,1151 | 77 |
| 14.5 ±8 % | 2026-10-13 | v2 | 2026-10-12 | 7 381 | 0,616 | 0,1143 | 77 |

## Topp 15 bredvid varandra

| Plats | 14.4 (efter) | 14.5-kod, 14.4-modell | 14.5 ±8 % |
| --- | --- | --- | --- |
| 1 | Fatburs Kvarngata 18, 2 318 010 kr | Fatburs Kvarngata 18, 2 318 010 kr | Fatburs Kvarngata 18, 1 958 873 kr |
| 2 | Falugatan 5, 2 123 426 kr | Falugatan 5, 2 123 426 kr | Falugatan 5, 1 789 226 kr |
| 3 | Fatburstrappan 18, 1 982 689 kr | Fatburstrappan 18, 1 982 689 kr | Fatburstrappan 18, 1 618 440 kr |
| 4 | Sågargatan 14, 1 864 930 kr | Sågargatan 14, 1 864 930 kr | Sågargatan 14, 1 577 634 kr |
| 5 | Tjurbergsgatan 38, 1 727 703 kr | Tjurbergsgatan 38, 1 727 703 kr | Tjurbergsgatan 38, 1 452 833 kr |
| 6 | Sysslomansgatan 26, 1 638 343 kr | Sysslomansgatan 26, 1 638 343 kr | Sysslomansgatan 26, 1 397 407 kr |
| 7 | Klippgatan 14E, 1 636 712 kr | Klippgatan 14E, 1 636 712 kr | Hornsgatan 119, 1 375 596 kr |
| 8 | Fyrverkarbacken 25, 1 586 168 kr | Fyrverkarbacken 25, 1 586 168 kr | Klippgatan 14E, 1 368 031 kr |
| 9 | Hornsgatan 119, 1 573 814 kr | Hornsgatan 119, 1 573 814 kr | Fyrverkarbacken 25, 1 357 242 kr |
| 10 | Pokalvägen 4, 1 519 265 kr | Pokalvägen 4, 1 519 265 kr | Pokalvägen 4, 1 323 174 kr |
| 11 | Erstagatan 21, 1 467 857 kr | Erstagatan 21, 1 467 857 kr | Fyrverkarbacken 23, 1 143 567 kr |
| 12 | Fyrverkarbacken 23, 1 336 563 kr | Fyrverkarbacken 23, 1 336 563 kr | Erstagatan 21, 1 123 758 kr |
| 13 | Ola Hanssonsgatan 4, 1 191 212 kr | Ola Hanssonsgatan 4, 1 191 212 kr | Ola Hanssonsgatan 4, 1 025 612 kr |
| 14 | Kungsbro Strand 19, 1 178 529 kr | Kungsbro Strand 19, 1 178 529 kr | Fridhemsgatan 41, 954 606 kr |
| 15 | Fridhemsgatan 41, 1 126 397 kr | Fridhemsgatan 41, 1 126 397 kr | Ringvägen 162, 933 639 kr |

## Största platsförflyttningar

Mellan första ("14.4 (efter)") och sista ("14.5 ±8 %") körningen. Plus betyder att lägenheten steg.

| Adress | Platser | Förflyttning |
| --- | --- | --- |
| Hagaesplanaden 63 | 19 → 19 → 24 | -5 |
| Frödingsvägen 9 | 57 → 57 → 62 | -5 |
| Kungsbro Strand 19 | 14 → 14 → 18 | -4 |
| Tjurbergsgatan 34 | 34 → 34 → 38 | -4 |
| John Bergs Plan 4 | 63 → 63 → 59 | +4 |
| Lindvallsplan 10 | 31 → 31 → 28 | +3 |
| Lidnersplan 12 | 37 → 37 → 34 | +3 |
| Pipersgatan 9 | 43 → 43 → 40 | +3 |
| Olof Dalins väg 16 | 38 → 38 → 41 | -3 |
| Dalslandsgatan 3 | 48 → 48 → 45 | +3 |

## Koefficienter (steg 1)

Varje egenskap som beta ± SE. Ett streck betyder att kolumnen inte har någon modellfil eller att modellen saknar egenskapen.

| Egenskap | 14.4 (efter) | 14.5-kod, 14.4-modell | 14.5 ±8 % |
| --- | --- | --- | --- |
| nbLevel | 1,066 ± 0,01186 | 1,066 ± 0,01186 | 1,050 ± 0,01193 |
| floor | 0,01513 ± 0,0008806 | 0,01513 ± 0,0008806 | 0,01561 ± 0,0008802 |
| groundOrBelow | -0,06722 ± 0,007977 | -0,06722 ± 0,007977 | -0,06617 ± 0,007934 |
| lnArea | 0,04467 ± 0,005508 | 0,04467 ± 0,005508 | 0,04037 ± 0,005519 |
| monthsAgo | -0,007753 ± 0,0002702 | -0,007753 ± 0,0002702 | -0,007826 ± 0,0002688 |
| centralityKm | -0,007109 ± 0,004214 | -0,007109 ± 0,004214 | -0,004365 ± 0,004201 |
| avgiftPerSqmMonth | -0,0006436 ± 0,0001967 | -0,0006436 ± 0,0001967 | -0,001008 ± 0,0001137 |
| brfDebtPerSqm | -0,000002390 ± 8,272e-7 | -0,000002390 ± 8,272e-7 | -0,000002503 ± 5,283e-7 |
| tomtratt | 0,000 ± - | 0,000 ± - | 0,000 ± - |

## Steg 2

Värdet modellen använder, markerat när det ligger på den egna modellens tak.

| Värde | 14.4 (efter) | 14.5-kod, 14.4-modell | 14.5 ±8 % |
| --- | --- | --- | --- |
| Balkong | +8,0 % (på taket ±8 %) | +8,0 % (på taket ±8 %) | +8,0 % (på taket ±8 %) |
| Byggår till 1930 | +3,9 % | +3,9 % | +3,6 % |
| Byggår 1931–1960 | -2,9 % | -2,9 % | -2,2 % |
| Byggår 1961–1990 | -8,0 % (på taket ±8 %) | -8,0 % (på taket ±8 %) | -8,0 % (på taket ±8 %) |
| Byggår från 1991 | -4,5 % | -4,5 % | -5,3 % |
| Balkong, rått värde | - | - | +8,3 % (SE 0,3) |
| Byggår till 1930, rått värde | - | - | +3,6 % (SE 0,2) |
| Byggår 1931–1960, rått värde | - | - | -2,2 % (SE 0,4) |
| Byggår 1961–1990, rått värde | - | - | -11,2 % (SE 0,7) |
| Byggår från 1991, rått värde | - | - | -5,3 % (SE 0,6) |

Rått värde är värdet före begränsningen till taket. SE ligger på loggskala och läses som ungefärliga procentenheter. 14.4 räknade ingen steg-2-SE, så kolumner utan fit-rapport visar "-".

## Takbeslut (R-01)

Steg-2-korsvalidering: felet på hållna rader för steg 2, samma uppdelning av raderna för alla tre.

| Steg 2 | Fel (log) |
| --- | --- |
| Utan steg 2 | 0,11557 |
| Tak ±8 % | 0,10225 |
| Tak ±12 % | 0,10188 |

Steg 1:s cvRmseLog (0,11433) räknas före steg 2 och kan inte skilja ±8 % från ±12 %, så den avgör ingenting här.

Taket vidgas till ±12 %: steg-2-felet är 0,10188 vid ±12 % mot 0,10225 vid ±8 %, alltså inte sämre.

På taket vid ±8 %: balkong, byggår 1961–1990.

Korrelation avgift/kvm och skuld/kvm: 0,30 (n = 2 320)

Takhöjd: 0 sålda rader med angiven höjd; ej anpassad (sålda sidor har ingen annonstext, R-03; ej anpassad (för få angivna))
