Sanningsfil: låst 2026-10-24T09:23:11.309Z

# Träffsäkerhet för layoutläsningen (variant:c, läsversion 864927e4ac41ea06)

Rader i urvalet: 60, utan lagrad läsning: 0. Det som avgör är precisionen i svaren som flyttar pengar, alltså andelen rätt bland de svar som tros (säkerhet vid eller över spärren). Spärren väljs ur kurvan på dev-raderna och prövas sedan på holdout-raderna och på dev och holdout tillsammans. Siffrorna gäller lägenheter som en bedömare kunde avgöra, inte ett slumpmässigt urval.

Tillåtna bevisord för sida: cars, courtyardGreenery.

## Balkong: gata eller gård

Precisionen räknar varje trott svar gata eller gård (fel om lägenheten saknar balkong).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 14 (minst 12 krävs) |
| Spärr (vald på dev) | 0,40 |
| Precision på dev | 7 av 7 (100 %, 95 %: 65–100 %) |
| Precision på holdout | 6 av 6 (100 %, 95 %: 61–100 %) |
| Precision dev + holdout | 13 av 13 (100 %, 95 %: 77–100 %) |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 14 av 14 (100 %, 95 %: 78–100 %) |
| Träffsäkerhet för alla svar vid spärren | 44 av 44 (100 %, 95 %: 92–100 %) |
| Utslag | Godkänd |
| Skäl | - |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,40 | 7 | 7 | 100 % (65–100 %) |
| 0,45 | 7 | 7 | 100 % (65–100 %) |
| 0,50 | 7 | 7 | 100 % (65–100 %) |
| 0,55 | 7 | 7 | 100 % (65–100 %) |
| 0,60 | 5 | 5 | 100 % (57–100 %) |
| 0,70 | 4 | 4 | 100 % (51–100 %) |
| 0,75 | 4 | 4 | 100 % (51–100 %) |
| 0,80 | 2 | 2 | 100 % (34–100 %) |
| 0,85 | 1 | 1 | 100 % (21–100 %) |
| 0,90 | 1 | 1 | 100 % (21–100 %) |

## Korsdrag: svaret "ja"

Precisionen räknar varje trott "ja" (fönster åt två motsatta sidor).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 59 (minst 12 krävs) |
| Spärr (vald på dev) | ingen |
| Precision på dev | - |
| Precision på holdout | - |
| Precision dev + holdout | - |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 57 av 58 (98 %, 95 %: 91–100 %) |
| Träffsäkerhet för alla svar vid spärren | - |
| Utslag | Inte godkänd |
| Skäl | ingen spärr når 75 % på dev med minst 5 spådda svar |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,20 | 4 | 3 | 75 % (30–95 %) |
| 0,40 | 4 | 3 | 75 % (30–95 %) |
| 0,50 | 4 | 3 | 75 % (30–95 %) |
| 0,60 | 3 | 3 | 100 % (44–100 %) |
| 0,65 | 3 | 3 | 100 % (44–100 %) |
| 0,75 | 3 | 3 | 100 % (44–100 %) |
| 0,80 | 3 | 3 | 100 % (44–100 %) |
| 0,85 | 2 | 2 | 100 % (34–100 %) |
| 0,90 | 0 | 0 | - |

## Sovrum: svaret "gård"

Precisionen räknar varje trott "gård" (tyst sovrum).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 9 (minst 12 krävs) |
| Spärr (vald på dev) | ingen |
| Precision på dev | - |
| Precision på holdout | - |
| Precision dev + holdout | - |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 8 av 8 (100 %, 95 %: 68–100 %) |
| Träffsäkerhet för alla svar vid spärren | - |
| Utslag | Inte godkänd |
| Skäl | ej mätbart (n = 9); ingen spärr når 75 % på dev med minst 5 spådda svar |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,10 | 3 | 3 | 100 % (44–100 %) |
| 0,30 | 3 | 3 | 100 % (44–100 %) |
| 0,40 | 3 | 3 | 100 % (44–100 %) |
| 0,45 | 3 | 3 | 100 % (44–100 %) |
| 0,50 | 3 | 3 | 100 % (44–100 %) |
| 0,55 | 2 | 2 | 100 % (34–100 %) |
| 0,60 | 2 | 2 | 100 % (34–100 %) |
| 0,65 | 2 | 2 | 100 % (34–100 %) |
| 0,70 | 2 | 2 | 100 % (34–100 %) |
| 0,85 | 1 | 1 | 100 % (21–100 %) |

## Bevis för sidan (alla sidsvar, utan spärr)

| Bevisord | Balkong dev | Sovrum dev | Balkong holdout | Sovrum holdout |
| --- | --- | --- | --- | --- |
| cars | 2 av 2 | 1 av 1 | 3 av 3 | 2 av 2 |
| oppositeFacade | 0 av 0 | 0 av 0 | 0 av 0 | 0 av 0 |
| courtyardGreenery | 5 av 5 | 3 av 3 | 3 av 3 | 2 av 2 |
| none | 0 av 0 | 0 av 0 | 0 av 0 | 0 av 0 |

Vardagsrum på balkongsidan: 22 av 27 lästa rätt av 27 avgjorda.

Helhet: Inte godkänd (alla tre fälten måste godkännas).
