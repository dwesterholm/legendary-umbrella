# Omgångar för layoutläsningen

Varianterna körs i fast ordning och omgångarna stoppas vid den första som klarar alla tre fälten.

| Variant | Status | Kostnad (kr) | Balkongsida | Korsdrag | Sovrumssida | Alla tre |
| --- | --- | --- | --- | --- | --- | --- |
| a | körd | 15,45 | nej | nej | nej | nej |
| b | körd | 17,17 | nej | nej | nej | nej |
| c | körd | 30,79 | ja | nej | nej | nej |
| d-sonnet | körd | 18,15 | ja | nej | nej | nej |

## Utslag

Vinnare: ingen

Tvåstegsläsningen (d) körs på nivån Sonnet (regel: den nivå vars enstegsvariant hade högst medelprecision på dev över de mätbara fälten; lika eller saknade data ger Sonnet).

- Balkongsida: bästa holdout-precision 6 av 6 (100 %, 95 %: 61–100 %) med 6 trodda svar, variant c; fältet klarar kraven i den varianten.
- Korsdrag: ingen variant gav någon holdout-precision (ingen spärr nåddes eller ingen körd variant).
- Sovrumssida: ingen variant gav någon holdout-precision (ingen spärr nåddes eller ingen körd variant).

Total kostnad för alla varianter: 82,04 kr.

Tabellen ovan är beslutsregeln i fast ordning a, b, c, d (alla tre fält). Nedan står alla körda varianter, även Jev (e), bredvid varandra.

## Jämförelse a till e

Trodda svar är de vars säkerhet ligger på eller över spärren som valdes på dev-lägenheterna. Precision är andelen av dem som var rätt, med 95 % Wilson-intervall. Kravet är 75 % på holdout med minst 5 trodda svar och minst 10 poolat.

| Mått | a | b | c | d-sonnet | e |
| --- | --- | --- | --- | --- | --- |
| Körd | ja | ja | ja | ja | ja |
| Balkongsida: avgjorda sanningsrader | 14 | 14 | 14 | 14 | 14 |
| Balkongsida: rå, rätt av lästa | 12 av 14 | 12 av 13 | 14 av 14 | 13 av 13 | 12 av 12 |
| Balkongsida: spärr | 0,40 | 0,20 | 0,40 | 0,50 | 0,35 |
| Balkongsida: holdout, trodda svar rätt | 3 av 3 (100 %, 95 %: 44–100 %) | 4 av 6 (67 %, 95 %: 30–90 %) | 6 av 6 (100 %, 95 %: 61–100 %) | 5 av 5 (100 %, 95 %: 57–100 %) | 4 av 5 (80 %, 95 %: 38–96 %) |
| Balkongsida: poolat (dev + holdout) | 9 av 9 (100 %, 95 %: 70–100 %) | 11 av 13 (85 %, 95 %: 58–96 %) | 13 av 13 (100 %, 95 %: 77–100 %) | 11 av 11 (100 %, 95 %: 74–100 %) | 11 av 13 (85 %, 95 %: 58–96 %) |
| Balkongsida: klarar kraven | nej | nej | ja | ja | ja |
| Korsdrag: avgjorda sanningsrader | 59 | 59 | 59 | 59 | 59 |
| Korsdrag: rå, rätt av lästa | 46 av 59 | 29 av 59 | 57 av 58 | 45 av 58 | 37 av 54 |
| Korsdrag: spärr | ingen | ingen | ingen | ingen | ingen |
| Korsdrag: holdout, trodda svar rätt | ingen spärr | ingen spärr | ingen spärr | ingen spärr | ingen spärr |
| Korsdrag: poolat (dev + holdout) | ingen spärr | ingen spärr | ingen spärr | ingen spärr | ingen spärr |
| Korsdrag: klarar kraven | nej | nej | nej | nej | nej |
| Sovrumssida: avgjorda sanningsrader | 9 (ej mätbart) | 9 (ej mätbart) | 9 (ej mätbart) | 9 (ej mätbart) | 9 (ej mätbart) |
| Sovrumssida: rå, rätt av lästa | 1 av 2 | 2 av 3 | 8 av 8 | 6 av 6 | 3 av 3 |
| Sovrumssida: spärr | ingen | ingen | ingen | ingen | ingen |
| Sovrumssida: holdout, trodda svar rätt | ingen spärr | ingen spärr | ingen spärr | ingen spärr | ingen spärr |
| Sovrumssida: poolat (dev + holdout) | ingen spärr | ingen spärr | ingen spärr | ingen spärr | ingen spärr |
| Sovrumssida: klarar kraven | nej | nej | nej | nej | nej |
| kr per lägenhet | 0,258 | 0,285 | 0,511 | 0,308 | 0,008 |
| kr för omgången | 15,45 | 16,79 | 30,15 | 17,85 | 0,47 |
| kr för varianten inklusive rökprov | 15,45 | 17,17 | 30,79 | 18,15 | 0,48 |
| sekunder per lägenhet | ej mätt | ej mätt | 3,9 | 6,4 | 2,0 |
| Klarar alla mätbara fält | nej | nej | nej | nej | nej |
| Klarar alla tre fälten | nej | nej | nej | nej | nej |

## Beslut

Mätbara fält: balkongsida, korsdrag. Ej mätbara fält: sovrumssida.

Klarar alla tre fälten (kravet för brytaren, D-11): ingen.
Klarar alla mätbara fält: ingen.

- a: Balkongsida: holdout har 3 spådda svar vid spärren 0,40, minst 5 krävs; poolat har 9 spådda svar vid spärren 0,40, minst 10 krävs | Korsdrag: ingen spärr når 75 % på dev med minst 5 spådda svar; närmast kravet på dev var 1 av 2 trodda svar vid spärren 0,72.
- b: Balkongsida: holdout-precisionen 4 av 6 (67 %) vid spärren 0,20 är under 75 % (8 procentenheter under kravet) | Korsdrag: ingen spärr når 75 % på dev med minst 5 spådda svar; närmast kravet på dev var 2 av 2 trodda svar vid spärren 0,75.
- c: Korsdrag: ingen spärr når 75 % på dev med minst 5 spådda svar; närmast kravet på dev var 3 av 4 trodda svar vid spärren 0,20.
- d-sonnet: Korsdrag: ingen spärr når 75 % på dev med minst 5 spådda svar; närmast kravet på dev var 2 av 2 trodda svar vid spärren 0,90.
- e: Korsdrag: ingen spärr når 75 % på dev med minst 5 spådda svar; närmast kravet på dev var 1 av 1 trodda svar vid spärren 0,62.

Total Anthropic- och Jev-kostnad för alla varianter: 82,04 kr (Apify 0 USD).

## Korsdrag: varför kravet är svårt att nå med den här sanningsuppsättningen

Lägenheter med fönster åt två motsatta sidor i sanningsuppsättningen: 3 på dev och 1 på holdout. Kravet är minst 5 trodda "ja" på dev för att välja en spärr, så en läsning som bara säger "ja" där det stämmer kan inte nå det; den måste också säga "ja" på lägenheter som inte har två motsatta sidor, och då sjunker precisionen. Kravet har inte sänkts (R-05, R-11 d).

## Folkungagatan 61 (Daniels kända sanning: balkong mot gatan, fönster åt en sida, sovrum mot gatan)

| Variant | Balkongsida | Fönstersidor | Sovrumssida | Säkerhet |
| --- | --- | --- | --- | --- |
| a | courtyard | twoOpposite | courtyard | 0,55 |
| b | unknown | twoOpposite | unknown | 0,40 |
| c | street | one | street | 0,60 |
| d-sonnet | street | corner | street | 0,55 |
| e | unknown | twoOpposite | unknown | 0,48 |
