# Areagranskningen: väntar på nästa live-körning som läser mäklartext

Status: väntar på nästa live-körning som läser mäklartext. Ingen granskning av riktig mäklartext är gjord i fas 14.6.

Varför: Daniels plan är att de 40 riktiga texterna kollas i nästa live-körning, och den här fasen gör inga Booli-anrop (D-11). Texterna sparas aldrig (D-09), så de går inte att läsa i efterhand. Utan en körning som hämtar mäklartext finns därför ingen mätning att redovisa.

## Hur granskningen görs

1. Lägg till `--area-audit` på det live-kommando som läser mäklartext (den veckovisa körningen eller 14.5:s plan 13). Flaggan är bara för live-körningar och skriver ingenting till disk.
2. Terminalen skriver ut de första 60 beskrivningarnas areameningar, med namn, e-postadresser och långa siffror maskerade, bredvid det som läsaren tolkade ("Areagranskning 7: uppmätt 2019 | Boarean är uppmätt av ▒ ▒ 2019."). En text utan areamening skrivs ut som "(ingen areamening)", så en miss syns.
3. Läs minst 40 texter och räkna per källa (uppmätt, föreningen, ekonomisk plan, lägenhetsregistret, säljaren, ej kontrollmätt): läst rätt, läst fel och missad.
4. Skriv bara siffrorna här under rubriken "Live-mätning". Aldrig en mening, ett namn eller ett utdrag.
5. Täckningen kommer också som en egen rad i körningens utskrift: "Areakälla: angiven i <a> av <n> lästa beskrivningar (...)". Den raden kopieras hit som första täckningstal.

## De undanhållna poängen (plan 08), det ärliga förhandsbeloppet

Dessa är poäng på påhittade fraser, inte på riktig text. De säger hur läsaren klarar de formuleringar vi kunde tänka oss, inte hur mäklare faktiskt skriver.

| Läsare | Uppsättning | Resultat |
|---|---|---|
| Stambyte | första undanhållna (38 fraser, skriven före mönstren) | 35 av 38 vid första mötet, 38 av 38 efter en allmän rättning. Optimistiskt: läsaren skrevs med listan i sikte. |
| Stambyte | andra undanhållna (24 fraser, skriven efter att läsaren var klar, poängsatt en gång) | 16 av 24 (67 %) vid första mötet, 18 av 24 efter två allmänna rättningar. Det bättre förhandsbeloppet: räkna med ungefär två av tre. |
| Area | undanhållna från forskningen (14 fraser) | 13 av 14 (samma tal som forskningen nådde; mönstren är de tunade forskningsmönstren) |
| Area | andra uppsättningen (17 fraser, poängsatt en gång) | 9 av 17 (53 %) vid första mötet, 10 av 17 efter en allmän rättning. Räkna med ungefär hälften. |

Alla missar i arealäsaren blir "ingenting" eller en svagare källa, aldrig en falsk uppmätning. Det är den viktiga egenskapen: ett fel gör kolumnen tom, inte vilseledande.

## Live-mätning

Första live-körningen med mäklartext och `--area-audit` gjordes 2026-10-24 (fas 14.5, plan 13). Booli utmanade webbläsaren efter 35 av 58 detaljsidor, så 33 texter kunde granskas i stället för 40. Resultat, bara antal: arealäsaren fick 0 träffar och 0 sedda missar, eftersom ingen av de 33 texterna angav en källa för boarean (9 skrev ut en mening med ett nyckelord, alla 9 var lagtext eller en kort notering och lästes rätt som "okänd"; 24 hade ingen areamening). Raden i körningen: "Areakälla: angiven i 0 av 33 lästa beskrivningar". Stambytesläsaren kan inte granskas med `--area-audit`, som inte skriver ut stambytesmeningar. Detaljer: `.planning/phases/14.5-enrichment-layout-accuracy-ceiling/evidence/area-audit-live.md`.

Area-kolumnen är fortfarande "okänd" för varje kandidat. Förhandstalen ovan är ännu inte prövade mot en enda riktig areamening.
