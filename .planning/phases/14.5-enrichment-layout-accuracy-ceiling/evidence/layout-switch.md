Brytaren: AV

# Layoutläsningen får inte påverka poängen ännu

Datum: 2026-10-24. Underlag: `layout-decision.json` (plan 09, vinnare: ingen) och rapporterna `layout-accuracy-<variant>.json`. Kravet (D-11, R-05): en och samma variant ska klara alla tre fälten (balkongsida, korsdrag, sovrumssida) med minst 75 % rätt på de svar som tros, på holdout och poolat, med minst 12 avgjorda sanningsrader per fält. Kravet har inte ändrats.

Så läser du siffrorna. Precision är hur ofta ett svar som läsningen står bakom visade sig stämma. Ett svar "tros" när läsningens säkerhet ligger på eller över en spärr som vi valde på dev-lägenheterna (32 av de 60 låsta). Holdout är de 28 lägenheter som aldrig användes för att välja spärr. Intervallet inom parentes är 95 % Wilson: med få svar är det brett, och det är det intervallets nedre kant som säger hur mycket vi faktiskt vet.

## Vad som gäller nu

`LAYOUT_INFLUENCE_ENABLED` är kvar på `false`. Balkongsida, korsdrag, sovrumsfaktorn och Sol-cellen från planlösningen påverkar varken poäng eller mejl. Veckojobbet fortsätter läsa och spara planlösningar med dagens läsning (variant a), så att mätningen kan fortsätta. Ingen kod ändras utom förklaringen vid brytaren.

## En rad per fält

| Fält | Avgjorda sanningsrader (minst 12) | Bästa variant | Spärr | Holdout | Poolat | Klarar kraven | Varför inte |
| --- | --- | --- | --- | --- | --- | --- | --- |
| balkongsida (gata eller gård) | 14 | c (Opus) | 0,40 | 6 av 6 (100 %, 61–100 %) | 13 av 13 (100 %, 77–100 %) | ja, i c, d och e | - |
| korsdrag ("ja" = fönster åt två motsatta sidor) | 59 | ingen | ingen | - | - | nej, i ingen variant | ingen spärr ger 5 trodda "ja" på dev med minst 75 % rätt |
| sovrumssida | 9 | ingen | ingen | - | - | nej, i ingen variant | ej mätbart: 9 avgjorda rader, 12 krävs |

Brytaren kräver alla tre fälten i samma variant. Ett av tre räcker inte.

## Balkongsida: klarad av tre varianter

| Variant | Spärr | Holdout | Poolat | Klarar |
| --- | --- | --- | --- | --- |
| a (Sonnet, dagens) | 0,40 | 3 av 3 (44–100 %) | 9 av 9 (70–100 %) | nej: bara 3 trodda svar på holdout, 5 krävs |
| b (Sonnet, bevisregler) | 0,20 | 4 av 6 (67 %, 30–90 %) | 11 av 13 (85 %, 58–96 %) | nej: 8 procentenheter under 75 % på holdout |
| c (Opus) | 0,40 | 6 av 6 (61–100 %) | 13 av 13 (77–100 %) | ja |
| d (två steg, Sonnet) | 0,50 | 5 av 5 (57–100 %) | 11 av 11 (74–100 %) | ja |
| e (Jev) | 0,35 | 4 av 5 (80 %, 38–96 %) | 11 av 13 (85 %, 58–96 %) | ja |

Stickprovet är litet: 14 lägenheter har en balkong vars sida en bedömare kunde avgöra, och 5 eller 6 av dem hamnar på holdout. Fem varianter har prövats mot samma holdout, så chansen att någon ser bra ut av ren tur är större än för en enda variant. De poolade talen (11 till 13 svar) är det stadigare underlaget och pekar åt samma håll för c, d och e.

## Korsdrag: ingen variant når kravet

Sanningsuppsättningen har bara 4 lägenheter med fönster åt två motsatta sidor, 3 på dev och 1 på holdout. Kravet är minst 5 trodda "ja" på dev för att få välja en spärr. En läsning som säger "ja" enbart där det stämmer kan ge högst 3. För att nå 5 måste den också säga "ja" på lägenheter som inte har två motsatta sidor, och då sjunker precisionen under 75 %.

| Variant | Rått, rätt av lästa (utan spärr) | Närmast kravet på dev |
| --- | --- | --- |
| a | 46 av 59 | 1 av 2 trodda "ja" vid 0,72 |
| b | 29 av 59 | 2 av 2 vid 0,75 |
| c (Opus) | 57 av 58 | 3 av 4 vid 0,20 (75 %, ett svar från de 5 som krävs) |
| d (två steg, Sonnet) | 45 av 58 | 2 av 2 vid 0,90 |
| e (Jev) | 37 av 54 | 1 av 1 vid 0,62 |

Opus ligger närmast: 57 av 58 lägenheter rätt, och på de 4 dev-lägenheter där den sa "ja" hade den rätt 3 gånger. Den rå träffsäkerheten är hög mest för att nästan alla lägenheter saknar korsdrag och "nej" då nästan alltid stämmer. Det säger lite om hur bra den är på de få lägenheter där ett "ja" skulle flytta pengar.

### Två vägar, ett beslut för Daniel

Ingen av dem är tagen här, och kravet är orört.

1. Samla in fler lägenheter med fönster åt två motsatta sidor i sanningsuppsättningen. Ungefär hälften av dem hamnar på dev, så för att ens en träffsäker läsning ska kunna ge 5 trodda "ja" där behövs troligen 8 till 10 sådana lägenheter totalt (min uppskattning, inte uppmätt). Det kostar manuellt bedömningsarbete och ett nytt lås av uppsättningen, och de nya lägenheterna måste läsas med varje variant som ska jämföras.
2. Räkna minimikravet på 12 rader över de lägenheter som verkligen har korsdrag, inte över alla 59 avgjorda lägenheter. Dagens regel säger "59 rader" och är därför uppfylld på pappret, men det är de 4 riktiga "ja" som avgör om en spärr går att välja. Det är en ändring av själva måttet, så den ska beslutas av dig i förväg, inte efter att vi sett vilken variant som råkar passera.

## Sovrumssida: går inte att mäta

Bara 9 lägenheter har ett sovrum vars sida en bedömare kunde avgöra. Det krävs 12. Rått läste Opus rätt 8 av 8 och tvåstegsläsningen 6 av 6, men det går inte att bevisa på 9 rader och ingen spärr kunde väljas. Fältet blir mätbart först när fler lägenheter med bedömbart sovrum finns i uppsättningen.

## Folkungagatan 61

Daniels kända sanning: balkong mot gatan, fönster åt en sida, sovrum mot gatan. Lägenheten ligger i holdout.

| Variant | Balkongsida | Fönstersidor | Sovrumssida | Säkerhet |
| --- | --- | --- | --- | --- |
| a | gård (fel) | två motsatta (fel) | gård (fel) | 0,55 |
| b | okänd | två motsatta (fel) | okänd | 0,40 |
| c (Opus) | gata (rätt) | en sida (rätt) | gata (rätt) | 0,60 |
| d (två steg) | gata (rätt) | hörn (fel) | gata (rätt) | 0,55 |
| e (Jev) | okänd | två motsatta (fel) | okänd | 0,48 |

Bara Opus har rätt på alla tre. Jev och b avstår på balkongsidan i stället för att gissa fel.

## Kostnad

| Variant | kr per lägenhet | kr för omgången | Sekunder per lägenhet |
| --- | --- | --- | --- |
| a | 0,258 | 15,45 | ej mätt |
| b | 0,285 | 16,79 | ej mätt |
| c (Opus) | 0,511 | 30,15 | 3,9 |
| d (två steg, Sonnet) | 0,308 | 17,85 | 6,4 |
| e (Jev) | 0,008 | 0,47 | 2,0 |

Jev kostar 0,008 kr per lägenhet, ungefär 64 gånger mindre än Opus. Hela fasens kostnad för layoutmätningen är 82,04 kr av 160 kr. Ingen veckokostnad för en ny läsning uppstår nu, eftersom ingen läsning byts ut.

## Vad produktionen gör nu

- Veckojobbet läser och cachar planlösningar som förut (variant a, `layout-cache.json`).
- Korsdrag-, Sovrum- och Sol-cellerna från planlösningen visas som okända. Smaktillägget och solfasaden ändras inte av läsningen.
- Täckningsraden räknar fortsatt vad läsningen hittade och slutar på "(påverkar ej poängen)".
- Gamla 14.4-läsningar i sparade ögonblicksbilder påverkar ingenting.
