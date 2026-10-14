# Budpremie och skick: fit eller prior (BID-01, R-08)

Mätt, inte antaget. Grenen bestäms av två mått och reglerna står här så att de kan läsas.

## Säljfoton

- Sålda lägenheter lästa i v2-formatet: 1 200
- Med minst ett bild-id: 463 (38,6 %)
- Med bild-id och utgångspris (kan användas i budpremien): 324 (27,0 % av v2)
- Urvalet för skickläsningen: 300 rader (stratifierat på distrikt och storleksband, fast frö)

## Smoketest (5 sålda lägenheter, högst 1 kr)

- Körd 2026-10-14: 5 försökta, 5 lästa, 0 misslyckade
- Schemat och bilderna: ok
- Kostnad: 0,44 kr (totalt 0,44 kr av 30,00 kr)
- Skick som modellen svarade: dated 0, ok 2, fresh 3
- Under säkerhetsgränsen 0,6 (utesluts ur anpassningen, kodas aldrig som 0): 2 av 5

## Regeln

Termen för skick anpassas bara när minst 200 sålda lägenheter har bild-id och utgångspris OCH smoketestet läste minst 4 av 5 sålda lägenheter. Tröskeln på 200 följer effektberäkningen i RESEARCH Q9 (cirka 220 användbara rader ger en standardavvikelse kring 0,0083, nog för att se plus minus 2 procentenheter). Annars är grenen prior: termen är 0 och budpremien märks "skick ej mätt". Ingen påhittad siffra används (R-08).

Gren: fit
