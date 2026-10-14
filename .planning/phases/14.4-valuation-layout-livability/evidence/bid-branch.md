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

## Utfall (plan 10, 2026-10-14)

Utfall: prior: korsvalidering förkastade termen (0,06359 -> 0,06362, skattning -0,0086)

- Läsning: 300 sålda lägenheter lästa (295 nya anrop, 5 från smoketestets cache), 0 fel. Betalt denna körning 26,12 kr, totalt för skicksläsningen 26,56 kr av 30,00 kr.
- Vad modellen svarade: föråldrat 8, vanligt 152, fräscht 140. Av de 300 hade 113 (37,7 %) säkerhet under 0,6 och utesluts ur anpassningen (kodas aldrig som 0). Användbara avläsningar: 187, varav 186 med uppgift om slutpris mot utgångspris. Av de användbara är 4,3 % föråldrade, 20,9 % vanliga och 74,9 % fräscha.
- Märkta rader i anpassningen: n = 186 (kravet CONDITION_MIN_LABELLED är 100, så termen prövades; effektberäkningen i RESEARCH Q9 ville ha ungefär 200 till 220).
- Koefficient per steg i skick (föråldrat -1, vanligt 0, fräscht +1): -0,0086. Tecknet är motsatt det som hypotesen väntade (ett fräscht objekt skulle få högre, inte lägre, överbud än ett föråldrat).
- Korsvalideringsfel på de märkta raderna (logskala): utan skick 0,06359, med skick 0,06362. Med skick är inte lägre, så termen förkastas. Skillnaden ligger på femte decimalen.
- corr(skick, utgångspris/modell) = 0,16: fräscha objekt sätts något högre i utgångspris mot modellen, så en del av en eventuell skickeffekt ligger redan i utgångspriset.
- Effektgränsen: med n = 186 syns inte en effekt under ungefär 2 procentenheter. Skattningen är -0,9 procentenheter med en standardavvikelse på ungefär 0,9, alltså ingen påvisbar effekt åt något håll.
- Mellanmodellen (de tre nya egenskaperna utelämnade) ser inga skicketiketter, så att termen inte kan läcka in i före/efter-rapportens uppdelning. Tidigare i körningen, med etiketterna kvar, behöll den ett skick-steg på -0,0094 med 0,06367 -> 0,06366: en skillnad på sjätte decimalen, som också visar att beslutet hänger på ingenting mätbart.

För Daniel: skick är inte mätt. Budpremien ignorerar skick och säger det ("skick ej mätt"). Orsaken är att fotona på sålda lägenheter nästan alltid läses som vanliga eller fräscha (8 av 187 föråldrade), så jämförelsen "föråldrat mot fräscht" saknar föråldrade lägenheter att jämföra med, och mellan vanligt och fräscht syns ingen skillnad i hur mycket över utgångspris de gick.
