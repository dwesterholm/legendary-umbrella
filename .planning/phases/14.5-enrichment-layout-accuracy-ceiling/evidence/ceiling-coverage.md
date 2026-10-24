# Takhöjd: hur ofta mäklaren anger en höjd (första live-körningen med parsern)

Datum: 2026-10-24, körd 12:09 lokal tid (10:09 UTC), lokal webbläsare, ingen bildtolkning, 0 kr Anthropic, 0 USD Apify. Underlag: `ceiling-live-run.log` (länkar ersatta med "<länk>") och den sparade ögonblicksbilden, som spelas upp med samma rad. Bara antal står här: inga adresser, inga textutdrag.

## Körningen avbröts av Booli

Booli svarade HTTP 403 (utmaning) på den lokala webbläsaren från den 36:e detaljsidan. Av 58 jämförbara annonser fick 35 sin detaljsida och 23 fick den inte. Programmet stannar inte av sig självt vid en utmaning: det försökte de 23 sidorna en gång vardera och därefter 31 föreningssidor (BRF), och alla 54 försök fick 403 (loggen: 54 rader med "ChallengeError"). Ingen sida försöktes om efter det, och jag startade ingen ny körning. Vägran är noterad i trafikloggen (`booli-gate.mjs --refused live-run`), så ingen Booli-trafik från den här datorn är tillåten före 2026-10-25 10:17 UTC. Körningen tog 8 minuter och jag följde den inte medan den gick, så jag kunde inte avbryta den vid första 403.

Av de 35 detaljsidorna hade 33 mäklartext som gick att läsa. Hos mäklarna vägrade verktyget 17 sidor som skickade om en andra gång, en mäklarsida svarade 403 och en 429.

Mätningen gäller därför 33 beskrivningar, inte 58. Den är ett riktigt men litet urval: de 35 annonser som stod först i förrank-ordningen fick sin sida.

## Täckning (för försäljningssidan)

| Mått | Antal |
| --- | --- |
| Annonser i snapshoten | 59 (58 jämförbara, 1 ej jämförbar) |
| Detaljsidor hämtade | 35 |
| Beskrivningar lästa för höjd | 33 |
| Med angiven höjd i meter | 1 |
| Med "högt i tak" utan siffra | 1 |
| Utan någon uppgift | 31 |

Raden i körningen och i uppspelningen av snapshoten är densamma: "Takhöjd: angiven i 1 av 33 lästa beskrivningar (högt i tak utan siffra 1)".

## Angivna höjder och smaktillägget

| Grupp | Antal annonser | Smaktillägg | Når 5 %-taket på grund av höjden |
| --- | --- | --- | --- |
| under 3,0 m | 1 (2,75 m) | 0 % | 0 |
| 3,0 till 3,49 m | 0 | +1 % av återförsäljningen | 0 |
| 3,5 m och över | 0 | +2 % av återförsäljningen | 0 |

Smaktillägget från takhöjd rörde alltså ingen annons i den här körningen. Raden "Smak: 5 %-taket nås av 0 av 58 rader" bekräftar att taket inte nåddes. Takhöjden syns i tabellens kolumn Takhöjd för 2 av 58 rader ("2,8 m" och "högt i tak"), för övriga 56 står "okänd".

## Säljarsidan (sålda lägenheter)

0 av de berikade sålda raderna har en angiven takhöjd. Sålda sidor på Booli har ingen mäklartext (R-03), så höjden går inte att läsa där. Det är också skälet till att takhöjd inte lades in i prismodellen (CEIL-02): beslutsgränsen D-06 är 300 sålda rader med angiven höjd, och den går inte att nå när det finns 0. Passningen skriver samma sak ("Takhöjd: 0 sålda rader med angiven höjd, ej anpassad").

## Vad det betyder

Med 1 angiven höjd av 33 lästa beskrivningar (3 %) och en höjd under 3 meter är takhöjd i den här körningen en uppgift som nästan aldrig finns i annonstexten. Stickprovet är litet (33) och avbröts av Booli, så 3 % har ett brett osäkerhetsintervall och ska inte läsas som "brukar vara 3 %". Det som kan sägas är att termen inte påverkade någon rankning i den här körningen.
