Sanningsfil: låst 2026-10-24T09:23:11.309Z

# Träffsäkerhet för layoutläsningen (variant:e, läsversion 0cf54ed308721db5)

Rader i urvalet: 60, utan lagrad läsning: 0. Det som avgör är precisionen i svaren som flyttar pengar, alltså andelen rätt bland de svar som tros (säkerhet vid eller över spärren). Spärren väljs ur kurvan på dev-raderna och prövas sedan på holdout-raderna och på dev och holdout tillsammans. Siffrorna gäller lägenheter som en bedömare kunde avgöra, inte ett slumpmässigt urval.

Tillåtna bevisord för sida: cars, courtyardGreenery.

## Balkong: gata eller gård

Precisionen räknar varje trott svar gata eller gård (fel om lägenheten saknar balkong).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 14 (minst 12 krävs) |
| Spärr (vald på dev) | 0,35 |
| Precision på dev | 7 av 8 (88 %, 95 %: 53–98 %) |
| Precision på holdout | 4 av 5 (80 %, 95 %: 38–96 %) |
| Precision dev + holdout | 11 av 13 (85 %, 95 %: 58–96 %) |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 12 av 12 (100 %, 95 %: 76–100 %) |
| Träffsäkerhet för alla svar vid spärren | 23 av 25 (92 %, 95 %: 75–98 %) |
| Utslag | Godkänd |
| Skäl | - |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,35 | 8 | 7 | 88 % (53–98 %) |
| 0,38 | 8 | 7 | 88 % (53–98 %) |
| 0,39 | 7 | 7 | 100 % (65–100 %) |
| 0,41 | 7 | 7 | 100 % (65–100 %) |
| 0,46 | 7 | 7 | 100 % (65–100 %) |
| 0,47 | 7 | 7 | 100 % (65–100 %) |
| 0,50 | 7 | 7 | 100 % (65–100 %) |
| 0,52 | 7 | 7 | 100 % (65–100 %) |
| 0,53 | 7 | 7 | 100 % (65–100 %) |
| 0,54 | 7 | 7 | 100 % (65–100 %) |
| 0,56 | 7 | 7 | 100 % (65–100 %) |
| 0,57 | 7 | 7 | 100 % (65–100 %) |
| 0,58 | 7 | 7 | 100 % (65–100 %) |
| 0,62 | 7 | 7 | 100 % (65–100 %) |
| 0,66 | 7 | 7 | 100 % (65–100 %) |
| 0,68 | 6 | 6 | 100 % (61–100 %) |
| 0,72 | 6 | 6 | 100 % (61–100 %) |
| 0,73 | 6 | 6 | 100 % (61–100 %) |
| 0,74 | 5 | 5 | 100 % (57–100 %) |
| 0,76 | 5 | 5 | 100 % (57–100 %) |
| 0,78 | 5 | 5 | 100 % (57–100 %) |
| 0,80 | 3 | 3 | 100 % (44–100 %) |
| 0,81 | 2 | 2 | 100 % (34–100 %) |
| 0,82 | 2 | 2 | 100 % (34–100 %) |
| 0,93 | 1 | 1 | 100 % (21–100 %) |

## Korsdrag: svaret "ja"

Precisionen räknar varje trott "ja" (fönster åt två motsatta sidor).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 59 (minst 12 krävs) |
| Spärr (vald på dev) | ingen |
| Precision på dev | - |
| Precision på holdout | - |
| Precision dev + holdout | - |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 37 av 54 (69 %, 95 %: 55–79 %) |
| Träffsäkerhet för alla svar vid spärren | - |
| Utslag | Inte godkänd |
| Skäl | ingen spärr når 75 % på dev med minst 5 spådda svar |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,30 | 10 | 2 | 20 % (6–51 %) |
| 0,34 | 10 | 2 | 20 % (6–51 %) |
| 0,34 | 9 | 2 | 22 % (6–55 %) |
| 0,36 | 9 | 2 | 22 % (6–55 %) |
| 0,37 | 8 | 2 | 25 % (7–59 %) |
| 0,38 | 8 | 2 | 25 % (7–59 %) |
| 0,39 | 8 | 2 | 25 % (7–59 %) |
| 0,40 | 7 | 2 | 29 % (8–64 %) |
| 0,43 | 7 | 2 | 29 % (8–64 %) |
| 0,45 | 6 | 2 | 33 % (10–70 %) |
| 0,48 | 5 | 2 | 40 % (12–77 %) |
| 0,51 | 4 | 2 | 50 % (15–85 %) |
| 0,53 | 4 | 2 | 50 % (15–85 %) |
| 0,55 | 4 | 2 | 50 % (15–85 %) |
| 0,57 | 3 | 2 | 67 % (21–94 %) |
| 0,58 | 2 | 1 | 50 % (9–91 %) |
| 0,62 | 1 | 1 | 100 % (21–100 %) |
| 0,77 | 1 | 1 | 100 % (21–100 %) |
| 0,86 | 1 | 1 | 100 % (21–100 %) |
| 0,91 | 1 | 1 | 100 % (21–100 %) |
| 0,92 | 0 | 0 | - |

## Sovrum: svaret "gård"

Precisionen räknar varje trott "gård" (tyst sovrum).

| Mått | Värde |
| --- | --- |
| Avgjorda sanningsrader | 9 (minst 12 krävs) |
| Spärr (vald på dev) | ingen |
| Precision på dev | - |
| Precision på holdout | - |
| Precision dev + holdout | - |
| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | 3 av 3 (100 %, 95 %: 44–100 %) |
| Träffsäkerhet för alla svar vid spärren | - |
| Utslag | Inte godkänd |
| Skäl | ej mätbart (n = 9); ingen spärr når 75 % på dev med minst 5 spådda svar |

Kurva på dev (en rad per observerad säkerhet):

| Säkerhet | Svar som tros | Rätt | Precision (95 %) |
| --- | --- | --- | --- |
| 0,42 | 1 | 1 | 100 % (21–100 %) |
| 0,44 | 1 | 1 | 100 % (21–100 %) |
| 0,45 | 1 | 1 | 100 % (21–100 %) |
| 0,50 | 1 | 1 | 100 % (21–100 %) |
| 0,52 | 1 | 1 | 100 % (21–100 %) |
| 0,57 | 1 | 1 | 100 % (21–100 %) |
| 0,59 | 1 | 1 | 100 % (21–100 %) |
| 0,64 | 0 | 0 | - |
| 0,67 | 0 | 0 | - |
| 0,68 | 0 | 0 | - |
| 0,71 | 0 | 0 | - |
| 0,72 | 0 | 0 | - |
| 0,73 | 0 | 0 | - |
| 0,75 | 0 | 0 | - |
| 0,78 | 0 | 0 | - |
| 0,79 | 0 | 0 | - |
| 0,81 | 0 | 0 | - |
| 0,83 | 0 | 0 | - |
| 0,84 | 0 | 0 | - |
| 0,85 | 0 | 0 | - |
| 0,90 | 0 | 0 | - |
| 0,91 | 0 | 0 | - |
| 0,93 | 0 | 0 | - |
| 0,95 | 0 | 0 | - |

## Bevis för sidan (alla sidsvar, utan spärr)

| Bevisord | Balkong dev | Sovrum dev | Balkong holdout | Sovrum holdout |
| --- | --- | --- | --- | --- |
| cars | 2 av 3 | 1 av 1 | 2 av 2 | 0 av 0 |
| oppositeFacade | 0 av 0 | 0 av 0 | 0 av 0 | 0 av 0 |
| courtyardGreenery | 5 av 5 | 1 av 1 | 2 av 3 | 0 av 0 |
| none | 0 av 0 | 0 av 0 | 1 av 1 | 1 av 1 |

Vardagsrum på balkongsidan: 26 av 27 lästa rätt av 27 avgjorda.

Helhet: Inte godkänd (alla tre fälten måste godkännas).
