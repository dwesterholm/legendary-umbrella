# Granskning av riktig mäklartext: arealäsaren och stambytesläsaren (14.6:s uppskjutna kontroll)

Datum: 2026-10-24, live-körningen i `ceiling-live-run.log`, flaggan `--area-audit`. De maskerade meningarna skrevs bara till terminalen och granskades där; ingen mening, inget namn och inget utdrag är sparat. Här står bara antal.

## Hur många texter

Målet var minst 40 texter. Det gick inte att nå: Booli utmanade webbläsaren efter 35 av 58 detaljsidor (se `ceiling-coverage.md`), och 33 av dem hade en mäklartext som gick att läsa. Granskningen gäller alla 33. Det är 7 färre än målet, och den som vill ha de sista 7 får vänta på nästa körning som läser mäklartext.

## Arealäsaren (vilken källa mäklaren anger för boarean)

| Mått | Antal |
| --- | --- |
| Texter granskade | 33 |
| Texter där granskningen skrev ut en mening med ett nyckelord (uppmätt, mätning, ekonomisk plan, lägenhetsregister, säljare med flera) | 9 |
| Av dessa: meningar som verkligen anger en källa för arean | 0 |
| Av dessa: allmän text om säljarens ansvar (8) och en kort notering med årtalet 2023 och "utan anmärkning" (1) | 9 |
| Texter utan någon areamening ("ingen areamening") | 24 |
| Läsaren svarade "okänd" | 33 av 33 |
| Träffar (läsaren hittade en källa som fanns) | 0 |
| Missar (en källa som stod i texten men som läsaren inte hittade) | 0 sedda |
| Falska "uppmätt" | 0 |

Så läses det. I de här 33 texterna angav ingen mäklare en källa för boarean med de orden vi letar efter, så det finns inget som läsaren kunde träffa eller missa. De 9 nyckelordsträffarna var lagtext om säljarens ansvar (ordet "säljare" slår till) och lästes rätt som "okänd". Raden i körningen säger samma sak: "Areakälla: angiven i 0 av 33 lästa beskrivningar", och Area-kolumnen är "okänd" för alla 58 rader.

Det betyder att läsarens träffsäkerhet på riktig text fortfarande är ouppmätt. Förhandstalen (ungefär hälften av påhittade fraser) har inte kunnat prövas, eftersom inga riktiga fraser fanns. Begränsning: granskningen skriver bara ut meningar med nyckelord. En areauppgift formulerad utan dem syns inte, så "0 missar" betyder 0 sedda, inte 0 som finns.

## Stambytesläsaren

`--area-audit` skriver inte ut några stambytesmeningar, så det går inte att granska läsaren mot riktig text med den här flaggan. Det som går att räkna ur snapshoten, utan att jämföra mot texten:

| Mått | Antal |
| --- | --- |
| Beskrivningar lästa | 33 |
| Läsaren hittade ett stambytesår | 2 (2024 och 2017, båda med relining nämnt) |
| Läsaren hittade inget | 31 |
| Rader med Stambyte i tabellen (källa text eller stadens ärendelista) | 12 av 58 (pågår 3, år utan "ansökt" 3, år med "ansökt" 6) |

Träffar och missar mot texten är därför inte bedömda. En sådan bedömning kräver att en stambytesmening skrivs ut maskerad på samma sätt som areameningarna, vilket är en liten kodändring och en ny live-körning (tidigast 2026-10-25 10:17 UTC).
