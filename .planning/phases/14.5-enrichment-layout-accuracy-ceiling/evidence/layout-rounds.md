# Omgångar för layoutläsningen

Varianterna körs i fast ordning och omgångarna stoppas vid den första som klarar alla tre fälten.

| Variant | Status | Kostnad (kr) | Balkongsida | Korsdrag | Sovrumssida | Alla tre |
| --- | --- | --- | --- | --- | --- | --- |
| a | körd | 15,45 | nej | nej | nej | nej |
| b | nästa att köra | 0,39 | - | - | - | - |
| c | inte körd ännu | 0,00 | - | - | - | - |
| d-sonnet | inte körd ännu | 0,00 | - | - | - | - |

## Utslag

Vinnare: ingen

Tvåstegsläsningen (d) körs på nivån Sonnet (regel: den nivå vars enstegsvariant hade högst medelprecision på dev över de mätbara fälten; lika eller saknade data ger Sonnet).

- Balkongsida: bästa holdout-precision 3 av 3 (100 %, 95 %: 44–100 %) med 3 trodda svar, variant a; regeln som brast: holdout har 3 spådda svar vid spärren 0,40, minst 5 krävs; poolat har 9 spådda svar vid spärren 0,40, minst 10 krävs.
- Korsdrag: ingen variant gav någon holdout-precision (ingen spärr nåddes eller ingen körd variant).
- Sovrumssida: ingen variant gav någon holdout-precision (ingen spärr nåddes eller ingen körd variant).

Total kostnad för alla varianter: 15,85 kr.
