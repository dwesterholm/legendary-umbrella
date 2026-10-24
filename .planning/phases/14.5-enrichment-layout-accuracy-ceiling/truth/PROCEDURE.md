# Bedömningsprocedur för layout-sanningen (Fas 14.5, LAYACC-01)

Skriven innan den första lägenheten bedömdes (2026-10-24). Den som följer stegen nedan ska komma fram till samma rad i `layout-truth.json` som den som gjorde den första bedömningen. Fältnamnen och värdena (`street`, `courtyard`, `undecidable` och så vidare) är de som filformatet kräver.

## 1. Syfte

Sanningsfilen är en måttstock. Den mäter hur ofta modellens läsning av planritning och bilder (balkongens sida, fönstersidor, sovrummets sida) stämmer. Den är inte indata till någon modell och styr inga pengar själv. Varje rad ska därför vara något en annan person kan kontrollera mot samma fyra bilder.

Två regler väger tyngre än alla andra:

- Hellre `undecidable` än en gissning. Ett "vet inte" kostar ett mätunderlag; en gissning förgiftar hela måttstocken, eftersom ett felaktigt facit gör att en modell som har rätt räknas som fel (eller tvärtom).
- Varje avgörande svar bygger på ett föremål som syns på en namngiven bild. Kan du inte peka ut föremålet och bildens nummer är svaret `undecidable`.

## 2. Vem och hur

Bedömaren (en språkmodell, denna fas) tittar på bilderna själv och fyller i raden för hand. Det är en människoliknande bedömning, inte ett maskinellt test, och den har samma svaghet som modellerna den mäter: den kan vara överdrivet säker på ett fotografi. Skyddet är kravet på ett namngivet föremål, tillåtelsen att svara `undecidable` och att Folkungagatan 61 (rad 1) har en sanning som Daniel gav och som inte bedömdes här.

Rad 1 (Booli-id 150148) har `source: "known"`: balkong mot gatan, vardagsrum på balkongsidan, fönster åt ett håll, sovrum mot gatan. Bilderna för den raden hämtas för att provköra hela vägen (planritning, kontaktark, rad), men sanningen ändras inte av vad bilderna visar. Alla andra rader har `source: "judged"`.

## 3. Material

- Endast de första fyra Booli-bilderna per annons, de som varje variant i mätningen får se. Normalt är bild 1 planritningen och bild 2 till 4 foton. Mäklarens egna bilder används inte.
- Bilderna hämtas bara från Booli-bildservern, en i taget, en per sekund, över https, in i en ny tillfällig mapp utanför repot. De sparas aldrig i repot och raderas när raden är skriven.
- Före varje hämtningspass: `node .planning/phases/14.5-enrichment-layout-accuracy-ceiling/booli-gate.mjs --stamp pictures-06`. Svarar den med fel (exit 1) hämtas inget. Svarar servern med 403, 429 eller en webbsida i stället för en bild: stoppa direkt, kör `booli-gate.mjs --refused pictures-06`, försök inte igen på 24 timmar.
- Arbetslistan (id och tillåtna bildadresser) skrivs bara ut i terminalen eller i den tillfälliga mappen, aldrig i repot.

## 4. Blindhet

Under bedömningen öppnas inget som innehåller en modells svar. Alltså inte: `layout-cache.json`, någon `layout-exp-*.json`, fältet `layout` i någon ögonblicksbild, filer under 14.4-fasens `evidence/` vars namn börjar på `layout-`, eller forskningsdokumentet 14.5-RESEARCH.md (dess avsnitt om sanningsmängden innehåller tidigare omdömen). Endast arbetslistan och de fyra bilderna används. Mäklartext och annonsbeskrivning läses inte heller: bedömningen gäller vad bilderna visar.

## 5. Steg per lägenhet

Gör stegen i ordning. Bilderna öppnas som ett kontaktark (2x2) och en enskild bild öppnas i full storlek när en detalj avgör.

**a. planPresent.** Är någon av de fyra bilderna en planritning sedd uppifrån (väggar, dörrar, rumsnamn eller måttsiffror)? Ja: `true`. Nej: `false`. Utan planritning blir `livingOnBalconySide` och `windowSides` `undecidable`, och `balconySide` eller `bedroomSide` avgörs bara om ett foto självt visar det (steg c och e).

**b. windowSides.** Räkna bara fönster i yttervägg. Glasväggar mellan rum och höga innerfönster räknas inte. Ett burspråk eller en utbyggnad på en och samma vägg räknas som en vägg.
- Alla ytterfönster på en vägg: `one`.
- Två väggar som möts i ett hörn: `corner`.
- Två motstående väggar (fram och bak): `twoOpposite`.
- Planritningen ritar inte ut fönster tydligt, eller bara en del av lägenheten syns: `undecidable`.
En lägenhet med fönster åt tre håll bedöms efter de två yttersta: finns två motstående väggar är det `twoOpposite`.

**c. balconySide.**
- `none` när planritning och foton inte visar någon balkong, altan eller uteplats.
- `street` kräver att något av detta syns utanför balkongen eller i fönstret på samma sida: bilar, en körbana, gatlyktor, butiksfasader, spårvagns- eller kontaktledningar, eller en sammanhängande fasadlinje på andra sidan av en väg (`cars`, `roadway`, `streetLamps`, `shopfronts`, `tramWires`, `facadeAcrossRoad`).
- `courtyard` kräver något av: cykelställ, gräsmatta, sandlåda eller lekplats, stenbeläggning med planteringslådor, eller husets egen baksida (`bicycleRacks`, `lawn`, `playground`, `pavedCourtyardPlanters`, `ownRearFacade`).
- Konstgräs eller trädäck på själva balkonggolvet är inte gårdsgrönska och räknas inte som `lawn` eller något annat gårdsbevis. Ett enstaka träd och fasader på långt håll avgör ingenting. Planritningens ingångspil är inget väderstreck och ingen sida. Ett foto av balkongen inifrån vardagsrummet visar inte i sig vilken sida det är.
- Står bevis för båda sidor på samma balkong (hörnbalkong) eller syns inget av listan: `undecidable`.

**d. livingOnBalconySide.** Ligger vardagsrummet (rummet med balkongdörren) på den vägg som balkongen sitter på? Ja: `yes`. Balkongen nås från ett annat rum än vardagsrummet: `no`. Utan planritning, eller utan balkong: `undecidable`. (Vid `balconySide: none` är fältet `undecidable`, eftersom frågan saknar mening.)

**e. bedroomSide.** `street` eller `courtyard` när ett sovrumsfoto visar det med bevis ur listan i steg c. Alternativt när planritningen lägger sovrumsfönstret på samma yttervägg som en redan avgjord balkongsida (samma sida) eller på motstående vägg (motsatt sida); säg i anteckningen att svaret kommer från planen och balkongsidan. Annars `undecidable`. Flera sovrum: bedöms det största, eller det som syns; syns inget tydligt är det `undecidable`.

**f. judgeConfidence.** `high`: bevis i flera bilder eller ett entydigt föremål per avgjort fält. `medium`: ett tydligt föremål men något tvetydigt kring det. `low`: svaret hänger på ett enda svagt föremål. En rad där allt är `undecidable` får `low`.

**g. evidence.** Orden ur den fasta listan (`cars`, `roadway`, `streetLamps`, `shopfronts`, `tramWires`, `facadeAcrossRoad`, `bicycleRacks`, `lawn`, `playground`, `pavedCourtyardPlanters`, `ownRearFacade`) som du faktiskt såg och som avgjorde en sida. Avgjordes ingen sida är det `["none"]`.

**h. note.** En rad, högst 160 tecken, med bildens nummer och det synliga föremålet ("bild 3: bilar och körbana från balkongen"). Ingen adress, inget gatunamn, inga namn och ingen länk (schemat avvisar länkar och gatunamn). Är något `undecidable`, säg varför i få ord ("ingen plan", "bara ett foto av rummet").

**i. Raden skrivs** (`inSet: false`, `split: null`, `order: null` tills filen låses i plan 07), bilderna för lägenheten raderas, och filen valideras med `npx tsx scripts/layout-accuracy.ts --check-truth <fil>` efter var femte rad.

## 6. Annonser som inte går att hämta

Ger alla fyra bildadresserna fel, eller är bilderna borta (såld eller avpublicerad sedan arbetslistan togs fram), läggs Booli-id:t i `unavailable` i stället för en rad. Ingen ersättning och ingen gissning.

## 7. Efter låsningen

Filen låses i plan 07 (`--select-and-lock`): mätmängd, delning i utveckling och kvarhållen mängd, och ordning fastställs, och en kontrollsumma av raderna och av denna procedur sparas innan någon betald körning. Efter det ändras en rad aldrig, utom för att rätta ett skrivfel, och då skrivs rättelsen och skälet ned i planens SUMMARY. Procedurtexten ändras inte efter låsningen; en ändring skulle ändra kontrollsumman.
