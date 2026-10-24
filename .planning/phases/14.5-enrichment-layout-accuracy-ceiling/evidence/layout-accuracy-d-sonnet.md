Sanningsfil: låst 2026-10-24T09:23:11.309Z

# Träffsäkerhet för layoutläsningen (variant:d-sonnet, läsversion 3b9c223e97f3d524)

Rader i urvalet: 60, utan lagrad läsning: 1. Det som avgör är precisionen i svaren som flyttar pengar, alltså andelen rätt bland de svar som tros (säkerhet vid eller över spärren). Spärren väljs ur kurvan på dev-raderna och prövas sedan på holdout-raderna och på dev och holdout tillsammans. Siffrorna gäller lägenheter som en bedömare kunde avgöra, inte ett slumpmässigt urval.

Tillåtna bevisord för sida: cars, courtyardGreenery.

## Balkong: gata eller gård

Precisionen räknar varje trott svar gata eller gård (fel om lägenheten saknar balkong).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 14 (minst 12 krävs) |
| Spärr (vald på dev) | 0,50 |
| Precision på dev | 6 av 6 (100 %, 95 %: 61–100 %) |
| Precision på holdout | 5 av 5 (100 %, 95 %: 57–100 %) |
| Precision dev + holdout | 11 av 11 (100 %, 95 %: 74–100 %) |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 13 av 13 (100 %, 95 %: 77–100 %) |
| Träffsäkerhet för alla svar vid spärren | 42 av 43 (98 %, 95 %: 88–100 %) |
| Utslag | Godkänd |
| Skäl | - |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,50 | 6 | 6 | 100 % (61–100 %) |
| 0,55 | 6 | 6 | 100 % (61–100 %) |
| 0,60 | 5 | 5 | 100 % (57–100 %) |
| 0,70 | 5 | 5 | 100 % (57–100 %) |
| 0,75 | 3 | 3 | 100 % (44–100 %) |
| 0,80 | 2 | 2 | 100 % (34–100 %) |
| 0,82 | 1 | 1 | 100 % (21–100 %) |
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
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 45 av 58 (78 %, 95 %: 65–86 %) |
| Träffsäkerhet för alla svar vid spärren | - |
| Utslag | Inte godkänd |
| Skäl | ingen spärr når 75 % på dev med minst 5 spådda svar |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,60 | 10 | 3 | 30 % (11–60 %) |
| 0,70 | 10 | 3 | 30 % (11–60 %) |
| 0,75 | 10 | 3 | 30 % (11–60 %) |
| 0,80 | 8 | 3 | 38 % (14–69 %) |
| 0,82 | 6 | 3 | 50 % (19–81 %) |
| 0,85 | 5 | 3 | 60 % (23–88 %) |
| 0,90 | 2 | 2 | 100 % (34–100 %) |
| 0,99 | 0 | 0 | - |

## Sovrum: svaret "gård"

Precisionen räknar varje trott "gård" (tyst sovrum).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 9 (minst 12 krävs) |
| Spärr (vald på dev) | ingen |
| Precision på dev | - |
| Precision på holdout | - |
| Precision dev + holdout | - |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 6 av 6 (100 %, 95 %: 61–100 %) |
| Träffsäkerhet för alla svar vid spärren | - |
| Utslag | Inte godkänd |
| Skäl | ej mätbart (n = 9); ingen spärr når 75 % på dev med minst 5 spådda svar |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,40 | 2 | 2 | 100 % (34–100 %) |
| 0,45 | 2 | 2 | 100 % (34–100 %) |
| 0,50 | 2 | 2 | 100 % (34–100 %) |
| 0,55 | 2 | 2 | 100 % (34–100 %) |
| 0,60 | 2 | 2 | 100 % (34–100 %) |
| 0,70 | 2 | 2 | 100 % (34–100 %) |
| 0,75 | 0 | 0 | - |
| 0,80 | 0 | 0 | - |
| 0,82 | 0 | 0 | - |
| 0,85 | 0 | 0 | - |

## Bevis för sidan (alla sidsvar, utan spärr)

| Bevisord | Balkong dev | Sovrum dev | Balkong holdout | Sovrum holdout |
| --- | --- | --- | --- | --- |
| cars | 1 av 1 | 0 av 0 | 2 av 2 | 1 av 1 |
| oppositeFacade | 0 av 0 | 0 av 0 | 1 av 1 | 1 av 1 |
| courtyardGreenery | 5 av 5 | 3 av 3 | 3 av 3 | 1 av 1 |
| none | 0 av 0 | 0 av 0 | 0 av 0 | 0 av 0 |

Vardagsrum på balkongsidan: 17 av 27 lästa rätt av 27 avgjorda.

Helhet: Inte godkänd (alla tre fälten måste godkännas).
