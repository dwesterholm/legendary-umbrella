Sanningsfil: låst 2026-10-24T09:23:11.309Z

# Träffsäkerhet för layoutläsningen (variant:b, läsversion 4810c64113ec3f71)

Rader i urvalet: 60, utan lagrad läsning: 0. Det som avgör är precisionen i svaren som flyttar pengar, alltså andelen rätt bland de svar som tros (säkerhet vid eller över spärren). Spärren väljs ur kurvan på dev-raderna och prövas sedan på holdout-raderna och på dev och holdout tillsammans. Siffrorna gäller lägenheter som en bedömare kunde avgöra, inte ett slumpmässigt urval.

Tillåtna bevisord för sida: cars, courtyardGreenery.

## Balkong: gata eller gård

Precisionen räknar varje trott svar gata eller gård (fel om lägenheten saknar balkong).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 14 (minst 12 krävs) |
| Spärr (vald på dev) | 0,20 |
| Precision på dev | 7 av 7 (100 %, 95 %: 65–100 %) |
| Precision på holdout | 4 av 6 (67 %, 95 %: 30–90 %) |
| Precision dev + holdout | 11 av 13 (85 %, 95 %: 58–96 %) |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 12 av 13 (92 %, 95 %: 67–99 %) |
| Träffsäkerhet för alla svar vid spärren | 29 av 31 (94 %, 95 %: 79–98 %) |
| Utslag | Inte godkänd |
| Skäl | holdout-precisionen 4 av 6 (67 %) vid spärren 0,20 är under 75 % |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,20 | 7 | 7 | 100 % (65–100 %) |
| 0,40 | 7 | 7 | 100 % (65–100 %) |
| 0,45 | 7 | 7 | 100 % (65–100 %) |
| 0,50 | 7 | 7 | 100 % (65–100 %) |
| 0,60 | 7 | 7 | 100 % (65–100 %) |
| 0,65 | 6 | 6 | 100 % (61–100 %) |
| 0,70 | 6 | 6 | 100 % (61–100 %) |
| 0,75 | 6 | 6 | 100 % (61–100 %) |
| 0,80 | 4 | 4 | 100 % (51–100 %) |
| 0,82 | 3 | 3 | 100 % (44–100 %) |
| 0,85 | 2 | 2 | 100 % (34–100 %) |
| 0,90 | 0 | 0 | - |

## Korsdrag: svaret "ja"

Precisionen räknar varje trott "ja" (fönster åt två motsatta sidor).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 59 (minst 12 krävs) |
| Spärr (vald på dev) | ingen |
| Precision på dev | - |
| Precision på holdout | - |
| Precision dev + holdout | - |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 29 av 59 (49 %, 95 %: 37–62 %) |
| Träffsäkerhet för alla svar vid spärren | - |
| Utslag | Inte godkänd |
| Skäl | ingen spärr når 75 % på dev med minst 5 spådda svar |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,20 | 19 | 3 | 16 % (6–38 %) |
| 0,50 | 19 | 3 | 16 % (6–38 %) |
| 0,55 | 18 | 3 | 17 % (6–39 %) |
| 0,60 | 18 | 3 | 17 % (6–39 %) |
| 0,65 | 10 | 3 | 30 % (11–60 %) |
| 0,70 | 7 | 3 | 43 % (16–75 %) |
| 0,75 | 2 | 2 | 100 % (34–100 %) |
| 0,80 | 0 | 0 | - |

## Sovrum: svaret "gård"

Precisionen räknar varje trott "gård" (tyst sovrum).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 9 (minst 12 krävs) |
| Spärr (vald på dev) | ingen |
| Precision på dev | - |
| Precision på holdout | - |
| Precision dev + holdout | - |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 2 av 3 (67 %, 95 %: 21–94 %) |
| Träffsäkerhet för alla svar vid spärren | - |
| Utslag | Inte godkänd |
| Skäl | ej mätbart (n = 9); ingen spärr når 75 % på dev med minst 5 spådda svar |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,10 | 1 | 1 | 100 % (21–100 %) |
| 0,20 | 1 | 1 | 100 % (21–100 %) |
| 0,30 | 1 | 1 | 100 % (21–100 %) |
| 0,40 | 1 | 1 | 100 % (21–100 %) |
| 0,45 | 1 | 1 | 100 % (21–100 %) |
| 0,50 | 1 | 1 | 100 % (21–100 %) |
| 0,55 | 1 | 1 | 100 % (21–100 %) |
| 0,60 | 1 | 1 | 100 % (21–100 %) |

## Bevis för sidan (alla sidsvar, utan spärr)

| Bevisord | Balkong dev | Sovrum dev | Balkong holdout | Sovrum holdout |
| --- | --- | --- | --- | --- |
| cars | 2 av 2 | 0 av 0 | 1 av 2 | 0 av 1 |
| oppositeFacade | 0 av 0 | 0 av 0 | 0 av 0 | 0 av 0 |
| courtyardGreenery | 5 av 5 | 1 av 1 | 3 av 4 | 1 av 1 |
| none | 0 av 0 | 0 av 0 | 0 av 0 | 0 av 0 |

Vardagsrum på balkongsidan: 24 av 27 lästa rätt av 27 avgjorda.

Helhet: Inte godkänd (alla tre fälten måste godkännas).
