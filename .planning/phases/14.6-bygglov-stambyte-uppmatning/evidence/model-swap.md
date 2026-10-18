Modellfilen: stambyte inte behållen (prövad, ej signifikant (t 0,9) — modellen oförändrad)

Den committade modellen `data/hedonic-model.json` har inte ändrats av fas 14.6. Stambytestermen är mätt och redovisad, men den flyttades inte in. Beslutet är R-08 i 14.6-CONTEXT.md, fattat efter plan 07: ett inflytt kräver både att korsvalideringen går igenom och att effekten är statistiskt skild från noll (t minst 2). Här klarades det första kravet med en hårsmån och det andra inte alls.

## Vad som mättes (från plan 07)

- Korsvalidering, fem delar: felet utan termen 0,1078, med termen 0,1077 (exakt 0,107796 mot 0,107724). Felet sjunker med 0,07 %. Planens strikta regel säger "behåll".
- Rad för rad: t = 0,9. Omkring 2 eller mer krävs för att skilja effekten från slumpen. Det gör den alltså inte.
- Effekt per åldersgrupp mot hus utan registrerat stambyte: 0-10 år +2,4 % (SE 1,3), 11-15 år -1,8 % (SE 1,0), 16-25 år +1,2 % (SE 0,4), 26-40 år +1,0 % (SE 0,3). Tecknen pekar åt olika håll och ingen grupp är i närheten av de omtalade -8 till -15 % före och +5 till +12 % efter.
- Underlag: 7 321 sålda lägenheter i hus vi kunde knyta till stadens lista, 2 399 av dem med ett registrerat stambyte före försäljningen.

## Vad som ändrades i filen

Ingenting. Kontrollsumman (SHA-256) före och efter planen är densamma:

`b92f144bb8ded009dd1fa9c3abb721ff9a24e0b7e55481bec8b5c0e4c5e0d911`

Filen är också byte för byte lik versionen från före fasen (`git diff 5e82334 -- data/hedonic-model.json` är tom).

## Bevis att inget pris rör sig

- Uppspelning av 2026-10-13-ögonblicksbilden med den committade modellen och stadens cache avstängd (`--city-cache none`): `ranked` och `notComparable` är lika med plan 7:s `replay-14.6-before-1013.json`, rad för rad.
- Samma uppspelning med stadens cache på: alla 78 rader har samma värde i varje fält som i plan 7:s uppspelning (0 skillnader, inga nya fält i rapportposterna). Stadens uppgifter visas i tabellen men flyttar inget tal.

## Vad termen skulle ha gjort med dagens kandidater

Jämförelsen utan/med ligger i `valuation-compare-stambyte/`. Den använder provmodellerna `hedonic-model-14.6-utan.json` (lika med den committade) och `hedonic-model-14.6-med.json` (utan plus termen), båda med stadens cache på:

- 60 av 77 rankade lägenheter hade fått ett annat pris per kvm, mellan -0,3 % och +2,1 %. De övriga 17 ligger i hus vars historik är okänd och får ingen justering (men "stambyte" hade stått bland de antagna egenskaperna).
- 32 lägenheter hade bytt plats i rankingen, och 6 av de 15 översta platserna hade hamnat annorlunda.
- Folkungagatan 61 (stambyte 2006, alltså 16-25 år före) hade gått från plats 16 till 14: återförsäljning +46 537 kr, vinst +43 638 kr (938 661 kr mot 982 299 kr).

Det är skillnader i storleksordningen någon procent som mätningen inte kan skilja från slumpen. Därför valdes att inte låta dem påverka rankingen.

## Kommandot för ett senare beslut

Om Daniel senare vill ha termen i modellen (till exempel när fler stambyten ligger inom tio år före försäljning och t har vuxit):

```
npx tsx scripts/fit-hedonic.ts --graft-stambyte .planning/calibration/data/hedonic-model-14.6-med.json --base data/hedonic-model.json --out data/hedonic-model.json
```

Kommandot flyttar bara nyckeln `stambyteTerm` och vägrar om något annat tal skiljer sig mellan de två filerna. Det är provkört till en skrapfil (`hedonic-model-14.6-graftcheck.json`, inte committad): enda skillnaden mot den committade modellen var `stambyteTerm`. Gör det sist i en fas och först när 14.5:s planer 12 och 13 har körts, eftersom deras uppspelningar jämför mot just den här filen. Provmodellerna är bara lokala (`.planning/calibration/data/`) och måste i så fall räknas om först om slutpriscachen har ändrats (`scripts/fit-hedonic.ts --stambyte-join ...`, se plan 07).


Note 2026-10-19 (after review fix WR-13): the graft command above now refuses unless BOTH the CV rule and t ≥ 2 hold (R-08). On the existing scratch fit (t 0,9) it is expected to refuse; a new fit with a stored t is needed before any graft.
