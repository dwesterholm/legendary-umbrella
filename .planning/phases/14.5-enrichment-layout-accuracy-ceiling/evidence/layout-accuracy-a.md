Sanningsfil: låst 2026-10-24T09:23:11.309Z

# Träffsäkerhet för layoutläsningen (variant:a, läsversion 30e7dea426b8a469)

Rader i urvalet: 60, utan lagrad läsning: 0. Det som avgör är precisionen i svaren som flyttar pengar, alltså andelen rätt bland de svar som tros (säkerhet vid eller över spärren). Spärren väljs ur kurvan på dev-raderna och prövas sedan på holdout-raderna och på dev och holdout tillsammans. Siffrorna gäller lägenheter som en bedömare kunde avgöra, inte ett slumpmässigt urval.

Tillåtna bevisord för sida: cars, courtyardGreenery.

## Balkong: gata eller gård

Precisionen räknar varje trott svar gata eller gård (fel om lägenheten saknar balkong).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 14 (minst 12 krävs) |
| Spärr (vald på dev) | 0,40 |
| Precision på dev | 6 av 6 (100 %, 95 %: 61–100 %) |
| Precision på holdout | 3 av 3 (100 %, 95 %: 44–100 %) |
| Precision dev + holdout | 9 av 9 (100 %, 95 %: 70–100 %) |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 12 av 14 (86 %, 95 %: 60–96 %) |
| Träffsäkerhet för alla svar vid spärren | 22 av 22 (100 %, 95 %: 85–100 %) |
| Utslag | Inte godkänd |
| Skäl | holdout har 3 spådda svar vid spärren 0,40, minst 5 krävs; poolat har 9 spådda svar vid spärren 0,40, minst 10 krävs |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,40 | 6 | 6 | 100 % (61–100 %) |
| 0,50 | 6 | 6 | 100 % (61–100 %) |
| 0,55 | 6 | 6 | 100 % (61–100 %) |
| 0,60 | 6 | 6 | 100 % (61–100 %) |
| 0,70 | 5 | 5 | 100 % (57–100 %) |
| 0,72 | 1 | 1 | 100 % (21–100 %) |
| 0,80 | 1 | 1 | 100 % (21–100 %) |

## Korsdrag: svaret "ja"

Precisionen räknar varje trott "ja" (fönster åt två motsatta sidor).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 59 (minst 12 krävs) |
| Spärr (vald på dev) | ingen |
| Precision på dev | - |
| Precision på holdout | - |
| Precision dev + holdout | - |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 46 av 59 (78 %, 95 %: 66–87 %) |
| Träffsäkerhet för alla svar vid spärren | - |
| Utslag | Inte godkänd |
| Skäl | ingen spärr når 75 % på dev med minst 5 spådda svar |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,40 | 7 | 2 | 29 % (8–64 %) |
| 0,50 | 7 | 2 | 29 % (8–64 %) |
| 0,55 | 7 | 2 | 29 % (8–64 %) |
| 0,60 | 7 | 2 | 29 % (8–64 %) |
| 0,70 | 5 | 2 | 40 % (12–77 %) |
| 0,72 | 2 | 1 | 50 % (9–91 %) |
| 0,80 | 1 | 0 | 0 % (0–79 %) |

## Sovrum: svaret "gård"

Precisionen räknar varje trott "gård" (tyst sovrum).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 9 (minst 12 krävs) |
| Spärr (vald på dev) | ingen |
| Precision på dev | - |
| Precision på holdout | - |
| Precision dev + holdout | - |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 1 av 2 (50 %, 95 %: 9–91 %) |
| Träffsäkerhet för alla svar vid spärren | - |
| Utslag | Inte godkänd |
| Skäl | ej mätbart (n = 9); ingen spärr når 75 % på dev med minst 5 spådda svar |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,40 | 0 | 0 | - |
| 0,50 | 0 | 0 | - |
| 0,55 | 0 | 0 | - |
| 0,60 | 0 | 0 | - |
| 0,70 | 0 | 0 | - |
| 0,72 | 0 | 0 | - |
| 0,80 | 0 | 0 | - |

## Bevis för sidan (alla sidsvar, utan spärr)

| Bevisord | Balkong dev | Sovrum dev | Balkong holdout | Sovrum holdout |
| --- | --- | --- | --- | --- |
| cars | 2 av 2 | 0 av 0 | 1 av 1 | 0 av 0 |
| oppositeFacade | 2 av 2 | 1 av 1 | 1 av 3 | 0 av 1 |
| courtyardGreenery | 4 av 4 | 0 av 0 | 2 av 2 | 0 av 0 |
| none | 0 av 0 | 0 av 0 | 0 av 0 | 0 av 0 |

Vardagsrum på balkongsidan: 24 av 27 lästa rätt av 27 avgjorda.

Helhet: Inte godkänd (alla tre fälten måste godkännas).
