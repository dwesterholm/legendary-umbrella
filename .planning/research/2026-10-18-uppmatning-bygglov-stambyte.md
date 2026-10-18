# Uppmätning, bygglov and stambyte: three new value signals

Research note, 2026-10-18. Scope: Stockholm innerstan bostadsrätter, at most 4 M kr, at least 35 kvm. Read-only in the repo, no Booli or Hemnet requests, no paid model calls. Four searches were made by hand in Stockholm's public Bygg- och plantjänsten (city building-permit e-service) to see what it returns; those results are quoted below.

The one-page summary and the recommended order are at the end.

Terms used throughout:

- **Boarea (BOA)**: the living area of a flat, the number in every listing. Measured under Svensk Standard SS 21054.
- **Biarea (BIA)**: secondary space inside the dwelling that is not living space (storage, cold rooms). Not in the listed kvm.
- **Öppenarea (OPA)**: open space attached to the building, such as balconies and roof terraces. Neither BOA nor BIA.
- **Uppmätning**: a fresh measurement of the flat, usually with a laser, by a measuring firm.
- **Fastighetsbeteckning**: the official name of the land parcel and building, for example "Oljan 29". One BRF can own one or several.
- **Bygglov / anmälan**: a building permit, and the lighter "notification" that some works need instead (a stambyte is one of them).
- **Stambyte**: replacing the building's vertical water and drain pipes. It usually means new bathrooms and often new kitchen plumbing, and it takes 3 to 6 months per stair.
- **Relining**: lining the old pipes from inside instead of replacing them. Cheaper, and does not give new bathrooms.

---

## 1. Uppmätning: do old flats hide free kvm?

### 1a. What the standard says and what changed

Swedish area rules go back to SS 21050 (1978), replaced by SS 21051 (1987), SS 21052 (1989), SS 21053 (1999), SS 21054:2009 and the current SS 21054:2020 ([Wikipedia, Area och volym för husbyggnader](https://sv.wikipedia.org/wiki/Area_och_volym_f%C3%B6r_husbyggnader)). The core rules for a flat have barely moved since the late 1980s:

- Measure from the inside face of the exterior walls, just above the skirting board. Everything inside counts, including inner walls, built-in wardrobes, ventilation ducts and fireplaces ([Wikipedia](https://sv.wikipedia.org/wiki/Area_och_volym_f%C3%B6r_husbyggnader); [Skatteverket mätregler](https://www.skatteverket.se/privat/fastigheterochbostad/fastighetstaxering/deklarerasmahus/matreglerforsmahus.4.5cbdbba811c9a768f0c80002011.html)).
- An inner wall, chimney or pillar thicker than 30 cm counts only 15 cm in from each side. A 42 cm wall contributes 30 cm and the remaining 12 cm is lost (Skatteverket's worked example).
- Under a sloping ceiling, floor counts where the height is at least 1,90 m, plus up to 0,60 m further out. A floor with no strip at least 0,60 m wide at 1,90 m does not count at all ([Fastighetstidningen 2012](https://fastighetstidningen.se/?p=6258)).
- Balconies count in neither BOA nor BIA; they are OPA.

SS 21054:2020 was a rewrite for clarity with new illustrations. SIS says the measuring rules themselves did not change, apart from smaller items: the opening width that makes a space beyond it measurable dropped from 60 to 50 cm, "underbyggd altan" was removed, and souterrain floors were clarified ([summary of the SIS foreword via Byggtjänst/Byggkoll](https://byggkoll.byggtjanst.se/artiklar/2020/april/ny-version-av-matstandard/); [Mäklarsamfundet](https://www.maklarsamfundet.se/nyheter/ny-standard-matning-av-boyta)). So a 2009 measurement and a 2020 measurement of the same flat should agree within the tolerance; the 2020 version adds no kvm.

The real step change is older. Magnus Gramstrup of Svensk Areamätning told Fastighetstidningen that before 1987 measurers did not measure 15 cm into the wall, which they do today, that his firm measures about 400 flats a year, and that 70 to 80 % come out different from the owner's figure, mostly older flats that are bigger than stated ([Fastighetstidningen, 20 Jan 2012](https://fastighetstidningen.se/?p=6258)). Measuring firms quote a tolerance of about 1,5 to 2 % ([Enspecta report citing SS 21054:2020](https://cdn-realestate.kowboy.se/v310/vitec/files/M26608/OBJ26608_2103001689/DOK5NFQZGB37XB96S9J3M.pdf)).

### Why old figures under-count

The mechanisms below are what the sources support. The relative size of each is my reasoning, not measured.

1. **Room-by-room sums.** An older figure is often the sum of each room's floor, which leaves out inner walls and built-in wardrobes. Under today's rule those count. This is the biggest source of "free" kvm.
2. **Where the figure came from.** Most innerstan BRFs are converted rental buildings (ombildningar). The flat's area in the BRF's books was usually inherited from the landlord's rent records or old drawings, not measured for the sale. Ekonomifokus warns that BRF figures, old measurements and drawings cannot be relied on ([Ekonomifokus](https://www.ekonomifokus.se/bostad/juridik/fel-boyta-lagenhet-hus)).
3. **Sloping ceilings.** Attic flats are measured differently. Most innerstan attic flats were built in the 1980s to 2000s and measured under modern rules, so less upside there.
4. **Bay windows (burspråk) and deep window niches.** I found no source that states how SS 21054 treats them. A burspråk with a floor at room level is inside the exterior wall and should count; whether old figures drew a straight line across it is a guess. Treat as unverified.

The error can go the other way. A figure measured to the outside of walls, or one that included biarea, comes out smaller on re-measurement. "70 to 80 % differ" does not say "70 to 80 % are bigger".

### 1b. Thick walls on the floor plan: partly true

The friend's intuition has a real basis, with a cap:

- Inner walls count toward BOA under today's rule. If the stated area is an old room-by-room sum, every metre of inner wall is missing area. A 40 kvm flat with 12 m of 15 to 30 cm inner walls hides roughly 1,8 to 3,6 kvm (12 m × 0,15 to 0,30 m). That is my arithmetic, not a source.
- The cap is 30 cm per wall. A 60 cm bearing wall adds no more than a 30 cm wall does.
- Thick exterior walls add nothing: BOA starts at their inside face. The 60 to 90 cm brick facades of a sekelskifte building are not hidden area.

So "many thick walls" only means room to gain if the stated area also excludes walls. The walls are the lever; the old measurement method decides whether the lever is there. A modern uppmätning of a flat with many walls gains nothing.

### 1c. Where the measurement date and source appear

| Source | What it holds | Public? | Repo reads it today? |
|---|---|---|---|
| Broker description (objektsbeskrivning) | Often a line such as "Areauppgift enligt föreningen", "Boarean är uppmätt av X 2019", "Mäklaren har ej kontrollmätt". The Högsta domstolen case NJA 2016 s. 237 quotes a listing with "Areauppgift enligt bostadsrättsföreningen" ([lagen.nu](https://lagen.nu/dom/nja/2016s237)) | Yes, on the broker page | The text is read in `watch-enrich.ts` (broker `description`, Booli description as fallback) and dropped after parsing. No area-source parser exists. |
| Broker page facts box and PDF attachments | Many broker CMSs (Vitec "kowboy" CDN) put the area-source line in a facts section rather than the description, and attach an uppmätning PDF ([Bjurfors example](https://www.bjurfors.se/contentassets/caeaa9c25c764dd39fd38fcf0ce74430/areamatning.pdf)) | Yes | No. `parse-broker-page.ts` keeps only `description`, `renovationStatus` and image URLs. |
| Floor plan image | Sometimes prints "BOA 42,5 kvm" or the drawing firm's name | Yes | Photos are fetched as bytes for vision; the layout read is OFF until it reaches 75 % accuracy (memory, Phase 14.5). |
| BRF ekonomisk plan / lägenhetsförteckning | The lägenhetsförteckning (BRF's register of flats) must list room count and other spaces; the law text (Bostadsrättslagen 9 kap. 10 §) names no area ([lawline summary](https://lawline.se/answers/14134)). The ekonomisk plan usually carries an area per flat. | Ask the BRF | No |
| Lägenhetsregistret (Lantmäteriet's national flat register) | A "bostadsarea" per flat, reported by owners around 2010-2011. Kronofogden valuations cite it as "Boarea 76 m², Källa: Lägenhetsregistret" ([example](https://auktionstorget.kronofogden.se/download/18.5f5d161219cb4c616811b050/1774011075401/Beskrivning%20och%20v%C3%A4rdering.pdf)) | Through paid property-information resellers, not a free per-flat lookup (I did not verify resellers' prices) | No |
| Bostadsrättsregistret (new public register) | Will hold rooms, kitchen type and bostadsarea per flat taken from the lägenhetsregister. Law SFS 2026:484; build-up starts 2027-01-01; every BRF must report by 2027-12-31; go-live date set later by the government ([SFS 2026:485](https://data.riksdagen.se/dokument/sfs-2026-485.html), [förordning 2026:898](https://lagen.nu/2026:898)) | Will be public | Not yet |
| Booli / Hemnet listing | Only the number ("Boarea 37 m²", `livingArea`). The Booli detail payload has `additionalArea` (biarea), usually null. | Yes | `livingArea` yes; no source field exists. |

The only source the repo can parse now, at no extra request cost, is the broker description it already reads.

### 1d. Floor-plan signals for "likely under-measured"

Signals that raise the odds, each cheap to compute:

1. Building year before 1987 (almost all of innerstan) and no "uppmätt" phrase in the text.
2. Text says the figure comes from the BRF, the ekonomisk plan or the lägenhetsförteckning, or that the broker has not measured.
3. The stated area is a round integer. Measured figures are rounded to whole kvm too, so this is weak on its own.
4. Floor plan: many rooms for the size, long runs of inner walls, chimney stacks, built-in wardrobes.
5. Floor plan prints its own area and it differs from the listing (strongest single signal when present).

What a vision read can judge: room count, a rough count of inner-wall segments, whether wardrobes and chimney stacks are drawn, a printed area or room areas if legible.

What it cannot judge: true wall thickness (plans are rarely to scale and broker plans are often redrawn), what method produced the stated number, ceiling heights under slopes, or whether the plan matches the built flat. Printed room areas exclude walls by definition, so their sum is always below BOA; that gap is normal and must not be read as under-measurement.

### 1e. Proposal (phase part, about 1 plan)

Fields on `CandidateFacts` (derived values only, the description is still dropped):

- `areaSource: "uppmatt" | "forening" | "ekonomisk_plan" | "lagenhetsregister" | "saljare" | "ej_kontrollmatt" | null`
- `areaMeasuredYear: number | null` (1980 to the run year)
- `areaMeasuredFirm: boolean | null` (a measuring-firm name or "laser" was mentioned; the name is not stored)

Phrase patterns, written in the same style as `ceiling-height.ts` (bounded quantifiers, letter look-arounds, text capped before matching):

```
uppmätt     /(?<!\p{L})(?:upp|om|kontroll)mätt?(?:es|s)?\b.{0,40}?\b(19[89]\d|20[0-4]\d)?/iu
            also "areamätning", "mätintyg", "uppmätning utförd", "mätt enligt SS 21054"
förening    /areauppgift(?:en|er)?\s{0,3}(?:är\s{1,3})?(?:hämtad\s{1,3}från|enligt)\s{1,3}(?:bostadsrätts)?förening/iu
ek. plan    /enligt\s{1,3}(?:föreningens\s{1,3})?ekonomisk(?:a)?\s{1,3}plan/iu
lgh-reg     /lägenhetsregist(?:er|ret)|lägenhetsförteckning/iu
säljare     /(?:uppgift|uppgiven)\s{1,3}(?:från|av)\s{1,3}säljare/iu
ej mätt     /(?:ej|inte)\s{1,3}(?:kontroll|upp)?mätt|har\s{1,3}inte\s{1,3}mätts/iu
```

A negation guard ("ej uppmätt" must not count as "uppmätt") is needed, the same way `landLeaseFromText` handles "ej tomträtt". These need a truth set of 40 to 60 real broker texts before shipping; I could not test them without reading listings.

Treatment:

- **Flag, not price.** Show "Arean bygger på föreningens uppgift, inte en uppmätning" and, when the building is pre-1987 and the plan shows many walls, "Kan vara större vid uppmätning (ofta 1 till 3 kvm, ej säkert)".
- **Upside in kronor, shown separately.** Expected gain = P(larger) × expected extra kvm × marginal kr per kvm. The hedonic model (`data/hedonic-model.json`, n = 7 379) prices kr per kvm with an area coefficient that is near zero between 35 and 50 kvm, so one extra stated kvm is worth about the flat's own kr per kvm: roughly 100 000 to 115 000 kr at this price level. Two kvm is then about 200 000 to 230 000 kr of resale. P(larger) and the kvm figure are unmeasured, so keep this out of the fit score until a truth set exists. A remeasure costs a few thousand kronor (no firm published a price I could find).
- **Do not move the hedonic model.** Sold pages carry no broker text (`ceiling-height.ts` header), and the market prices the stated number anyway.

One consequence for the current ranking: a flat whose stated area is too small sells for more per stated kvm, because buyers see the real room. The tool will read it as expensive and rank it down. A source flag is the only way to surface it.

What is not knowable without a site visit: the true area, whether walls are 15 or 35 cm, how the old figure was made, and whether the BRF will accept a new figure. Re-measuring does not change the avgift; that follows the andelstal, which is fixed in the ekonomisk plan.

### Open questions

- Ask one measuring firm (Svensk Areamätning, Enspecta) for its own split of larger vs smaller results on pre-1930 innerstan flats. That is the number the upside estimate needs.
- Does a buyer who re-measures and re-lists at a bigger kvm face any pushback from the BRF or the next buyer? Legal reading needed, not code.
- Once the bostadsrättsregister is live (2028 at the earliest), a per-flat public area becomes available to compare against the listing.

---

## 2. Bygglov by fastighetsbeteckning

### 2a. Address to fastighetsbeteckning

The sibling repo does this in `~/dev/rental-apartments/scripts/resolve_beteckning.py`. It calls the unauthenticated endpoints behind Lantmäteriet's public Min Karta map (`minkarta.lantmateriet.se/api/searchservice/searchinput` for the address, `.../positionsinformation/.../registerenhetermedbuffer/v1` for parcels within N metres, and `.../fastighetsinfo/v1` for the parcel outline). It has two rules worth copying: (1) a 0/5/10 m buffer ladder followed by a point-in-polygon test, because a 10 m buffer around Bondegatan 59 returned four parcels including the street; (2) a 3 s delay, one attempt, no retries, honest headers, everything cached. These are internal endpoints of a public web map, not a published API.

A simpler route for this project: the Stockholm e-service itself has "Sök fastighetsbeteckning med hjälp av adress" on the same search page, so address to beteckning and the case search can run against one host.

### 2b. Stockholm's building-permit records

Checked by hand on 2026-10-18 in [Bygg- och plantjänsten, Ärenden - ritningar och handlingar](https://etjanster.stockholm.se/byggochplantjansten/arendeochhandlingar):

- **No login for the case list.** A search for "Oljan 29" returned 19 building cases on one page, back to 1929 ("Nyb bostadshus butikslokaler"). The search is a plain GET: `...?ExtendedAddress=false&RealEstateName=Oljan%2029`.
- **Fields in the list:** ärendegrupp (case group), ärendemening (a one-line description), ärendestart (start date), fastighetsbeteckning, address, diarienummer.
- **The detail page** (`/Byggochplantjansten/arende/arende/<id>?dataSource=Active|Archived`) adds stadsdel, the case officer's name, and every decision with date and outcome, for example "2020-03-19 Lov med startbesked Bifall" and "2020-09-24 Slutbesked Bifall". The slutbesked (final sign-off) date is the best "work finished" date.
- **Drawings need an e-legitimation login.** The site says documents with personal data or under secrecy are not shown at all.
- **The search is fuzzy.** "Oljan 29" also returned "Koljan 29" (a villa in another district). Filter to an exact beteckning match.
- **Extended search** takes words in the ärendemening, stadsdel (for cases started 1985 or later), start-date and decision-date ranges, and decision type. "balkong" on Södermalm for cases started since 2025-06-01 gave 97 hits, 50 per page, with wording such as "Uppförande av balkonger med fönsterdörrar (A1-A3)", "Inglasning av balkong på flerbostadshus", "Fasadändring ... skifta 3 st balkongdörrar".
- **Terms:** `etjanster.stockholm.se/robots.txt` returns 404 and the page states no terms of use. That is not permission for bulk access. No open-data set or API for permits exists that I could find ([dataportalen](https://dataportalen.stockholm.se/dataportalen/) lists none).

Other routes:

- Granted permits used to be announced in Post- och Inrikes Tidningar, searchable for two years after publication ([Bolagsverket PoIT](https://bolagsverket.se/sjalvservice/etjanster/postochinrikestidningar.1697.html)). For cases filed from 2025-12-01 the announcement moved to each municipality's digital notice board ([Nyköping](https://www.nykoping.se/bo-bygga--miljo/bygga-nytt-andra-eller-riva/bygglovsprocessen/kungorelse-om-bygglov/)).
- [Geoplan](https://geoplan.se/bygglov) aggregates granted permits from those announcements for the last three years, nationwide, daily. Commercial; no API terms published.
- Stadsarkivet holds the original permit drawings 1713 to 1978.

### 2c. Balconies and boarea: the friend's claim needs a correction

A balcony is OPA, outside both BOA and BIA. A consumer guide states that a balcony, glazed or not, is neither BOA nor BIA ([Ekonomifokus](https://www.ekonomifokus.se/bostad/bostadsrelaterat/boarea-och-biarea)). An inglasad (glazed) balcony stays a balcony. A room usable only part of the year (an unheated uterum) is biarea at most. Only a fully built-in, heated, insulated space that is part of the flat becomes BOA, and that is a facade change needing its own permit. Some municipalities count a glazed balcony toward the building's gross area for planning purposes, which is a different number ([Riksdagen fråga 2023/24:434](https://data.riksdagen.se/dokument/HB11434.html)).

So a balcony permit adds value through the balcony itself, not through kvm:

- Booli's analysis of 21 000 Stockholm sales (2023-01 to 2024-06): listings mentioning a balcony sold for 1,9 % more (about 105 000 kr); south-facing 2,2 % (about 125 000 kr). Raw averages, with no control for floor, size or location ([Booli via TT](https://via.tt.se/pressmeddelande/3598429/analys-sa-mycket-okar-en-balkong-vardet-pa-en-lagenhet?lang=sv)).
- A 2005 Stockholm University thesis on 64 Vasastan sales found a balcony worth about 289 000 kr on a 1:a and 400 000 kr on a 3:a, against roughly 100 000 kr to build. A tiny sample; treat as an upper bound ([Roll 2005, DiVA](https://www.diva-portal.org/smash/get/diva2:196032/FULLTEXT01.pdf)).

Permit rules for balconies did not loosen on 2025-12-01 for flerbostadshus (multi-family buildings): the facade-change exemption applies to one- and two-family houses only ([Regeringen](https://www.regeringen.se/pressmeddelanden/2025/05/reglerna-for-bygglov-ska-bli-enklare-och-tydligare/)), and glazing still needs a permit per balcony according to a 2025/26 motion.

### 2d. Proposal (phase part, about 1 plan plus a spike)

Per candidate, after the existing broker step:

1. Resolve the fastighetsbeteckning: broker text first (many objektsbeskrivningar print it, so a regex such as `/fastighetsbeteckning\s{0,3}:?\s{0,3}(?:stockholm\s{1,3})?([A-ZÅÄÖ][\p{L} ]{1,30}\s\d{1,4}(?::\d{1,4})?)/iu` costs nothing), then the city's address lookup, then Min Karta as last resort.
2. Fetch the case list once per building (one GET), cache it by beteckning for 30 days. Keep only exact beteckning matches.
3. Classify each ärendemening with keyword rules into: `balkong_ny`, `balkong_inglasning`, `balkongdorr`, `stambyte` (see section 3), `hiss`, `vind_inredning`, `fasad`, `tak`, other. Store kind, start year, latest decision and date, diarienummer. No case officer names.
4. Fetch the detail page only for cases in the interesting kinds that started within the last 5 years (to get Bifall/Avslag and slutbesked). Usually 0 to 3 per building.

Show it as a short "Byggärenden" row on the candidate: "Balkonger beviljade 2026-03 (bifall, ej slutbesked)", "Inglasning ansökt 2026-09", "Stambyte slutbesked 2019". A granted balcony permit with no slutbesked is the interesting case: the building is getting balconies and the asking price may not include them yet. Whether this flat's position gets one needs the drawings, which need a login and a human.

Cost and politeness: a weekly run has about 75 to 100 candidates, so about 100 to 250 GETs at 3 s spacing, 5 to 12 minutes, on a city host that is not Booli. Use the same rules as `resolve_beteckning.py`. Email the contact centre (contactcenter.stadsbyggnad@stockholm.se) before running it weekly, and stop on any refusal or challenge.

Not achievable: drawings without a login, a guarantee that a granted balcony is on this flat's stair, cases the city withholds for secrecy, and anything about the BRF's own decision to build (stämmobeslut, cost per member). The BRF's annual report or stämmoprotokoll answers that.

### Open questions

- Is there a JSON endpoint behind the result page? Would need a look at the network calls; I did not dig. HTML parsing works either way.
- How far back is the ärendemening wording useful? 1980s cases say "Ombyggnad i 6 våningar", which hides what was done.

---

## 3. Stambyte: when, and what it does to the price

### 3a. Where the years are stated, and what the repo reads

**In the repo today:**

- `src/lib/brf/prompt.ts` and `extract.ts` read an uploaded annual report and return `stambytePlanerat` as an enum: `planerat`, `nyligen_genomfort` or `ej_nämnt`, with a source quote and page. No year, and "nyligen" (recently) is undefined.
- `src/lib/report/flags.ts` raises `STAMBYTE_PLANERAT` (red) and `STAMBYTE_NYLIGEN` (green) from that enum, only when citation-backed.
- `confounder-guard.ts` turns the enum into one sentence of prose (`STAMBYTE_PROSE`); it does not adjust any number.
- `brf-lookup.ts` passes the enum through, but its document source is Allabrf, which never worked (memory: allabrf auto-fetch). On the discovery path the enum is therefore always empty.
- `niches.ts` / `niche-score.ts`: the `imminent-stambyte` niche rewards buildings from 1970 or earlier, as a hedged build-year proxy.
- `vision-prompt.ts` mentions "ett tydligt förestående stambyte" as a remodel idea.
- `src/lib/booli/brf-page.ts` reads the public Booli BRF page and keeps four numbers (loans, area, report year, debt per kvm). The three fixtures show the labels Byggår, Antal bostadsrätter, Boarea, Lån, Belåning per kvm (behind login), Årsavgift per kvm (behind login). No stambyte line appears in them. The fixtures are trimmed to about 250 characters, so whether the full rendered page ever states a stambyte year is unverified. A Booli page says it shows "a small selection" of the annual report.
- The hedonic model has no stambyte feature.
- Listing text: a broker fixture contains "Stambyte genomfört 2018. Nytt kök och badrum 2021." No parser reads it.

**Outside the repo:**

| Source | States | Reachable |
|---|---|---|
| Stockholm Bygg- och plantjänsten | Stambyte is notifiable work (anmälningspliktig), confirmed in court ([MÖD 2020:19](https://lagen.nu/dom/mod/2020:19)), so it shows up as a case. A manual search "stambyte", Södermalm, started since 2025-01-01, gave 10 cases, for example "Stambyte, Underhåll av kulturhistorisk byggnad, Ändring av ventilation" at Ormen Mindre 1, Hornsgatan 40 (2025-04-17) | Public list, no login (section 2b) |
| BRF annual report (förvaltningsberättelse, underhållsplan) | "Stambyte genomfört 2008", "planerat 2029" | Manual PDF upload works. From fiscal year 2025 every BRF must file its annual report with Bolagsverket ([RSM](https://www.rsm.global/sweden/sv/news/fyra-viktiga-regelforandringar-bostadsrattsforeningar)); whether BRF reports enter Bolagsverket's free bulk files is unconfirmed (the sibling repo's `fetch_arsredovisning.py` reads those files for aktiebolag only and notes BRFs "file under a different regime"). Brokers often attach the PDF. |
| Broker description | "Stambyte genomfört 2018", "stambytt 2005", "planerat stambyte 2027" | Already read, then dropped |
| Booli BRF page | Unverified, see above | Read in the weekly run |
| Allabrf | Login-gated | No |

The city record and the annual report answer different questions. The city list shows work that was notified, with dates: done, ongoing, or starting within months. A stambyte planned three years out exists only in the underhållsplan.

### 3b. Price effect: thin evidence

- **No Swedish study with a credible stambyte coefficient turned up.** The best I found is the 2005 Stockholm University kandidatuppsats (64 Vasastan sales, 1859 to 1944 buildings). In the 3:a regression "stambytt" was significant at nearly 700 000 kr, which the author calls surprising; in the pooled model it was not significant because 88 % of buildings were already done ([Roll 2005](https://www.diva-portal.org/smash/get/diva2:196032/FULLTEXT01.pdf)). Too small to use.
- **The "+5 to 12 % after, −8 to 15 % before" figures** in this repo's 2026-07-10 research note match an unsourced blog post ([Boio](https://boio.se/blogg/stambyte-pavirkan-pris)). Treat them as folklore.
- **Finland:** an OP-Pohjola claim reported more than 12 years ago of 4 500 vs 3 000 €/kvm was disputed by the Finnish property managers' association, which said the uplift is at most a few percent over the cost ([Yle](https://yle.fi/a/7-717986)).
- **Cost, which bounds the effect:** 200 000 to 500 000 kr per flat for a full stambyte, 150 000 to 250 000 kr for 1 to 2 rooms ([Boio guide](https://boio.se/guide/stambyte), [Offerta](https://offerta.se/guider/bygg-och-renovering/vad-kostar-ett-stambyte)); relining 30 000 to 150 000 kr per flat ([SVT](https://www.svt.se/nyheter/inrikes/varnar-for-relining-kan-bli-ekonomisk-kalldusch)).
- **Avgift:** no source gives a typical post-stambyte increase. For context, Stockholm-region avgifter rose about 10 % from 2023 to 2024 (SBAB, via [Fastighetstidningen](https://fastighetstidningen.se/nyhet/sbab-avgiftshojningar-i-bostadsrattsforeningar/)), and Bostadsrätterna has seen some BRFs raise avgift 30 to 40 %.

Reasoning from cost (mine, not measured): a rational buyer discounts an unfunded upcoming stambyte by roughly the share not covered by the BRF's savings, plus 3 to 6 months without a bathroom. At 300 000 kr per flat on a 3,8 M kr flat that is about 8 %, less whatever the BRF has saved. A recently done stambyte is worth less than its cost if the old bathroom was fine, and more if it was worn out. Much of the effect already reaches the model through `brfDebtPerSqm` and `avgiftPerSqmMonth` after a loan-financed stambyte, so a stambyte term risks double counting.

### 3c. Proposal (phase part, 1 to 2 plans)

Fields (BRF/building level, beside `brf` in `CandidateFacts`):

- `lastStambyteYear: number | null`
- `plannedStambyteYear: number | null`
- `stambyteOngoing: boolean | null` (city case with start-besked and no slutbesked)
- `stambyteSource: "bygglov_stockholm" | "arsredovisning" | "maklartext" | null`

Text patterns for broker and annual-report text (bounded, year limited to 1950 to 2045):

```
done      /(?<!\p{L})stam(?:byte|bytt|arna\s{1,3}(?:byttes|bytta))(?:t|s)?\s{0,3}(?:genomfört|genomfördes|gjordes|gjort|klart|utfört|färdigställt)?\s{0,3}(?:år\s{1,3}|i\s{1,3})?((?:19[5-9]|20[0-4])\d)/iu
year-first /((?:19[5-9]|20[0-4])\d)\s{0,3}(?:genomfördes|gjordes|byttes)\s{1,3}(?:ett\s{1,3})?stam(?:byte|marna)/iu
planned   /(?:planera[ds]?|beslutat|kommande|förestående|projektera[ds]?)\s{1,3}stambyte.{0,40}?((?:20[2-4])\d)?/iu
relining  /relin(?:ing|ade|ats)/iu      (a separate tag; relining is not a stambyte)
```

Year assignment needs a clause rule like `clausesOf` in `ceiling-height.ts`, so "badrum 2021" in the same sentence does not become the stambyte year.

Two ways into the valuation:

1. **Hedonic feature (testable, sold side reachable).** Stambyte is a building fact. Sold flats have addresses, so the city case list can be joined to them by address or beteckning. A sweep by stadsdel and keyword ("stambyte", "avlopp", "VA", "ombyggnad") over date windows from 1985 should take a few hundred GETs for the four innerstan districts, cached once. Feature: `yearsSinceStambyte` in buckets (0 to 5, 5 to 15, 15 to 40, unknown or older), unknown marginalised at the mean (the model's honesty rule). Keep it only if cross-validation improves, as was done for days on market. Expect many buildings to have only a 1980s "Ombyggnad" case, which will blur the oldest bucket.
2. **Flag and confounder (works now).** Raise `stambyte_planned_unfunded` when the annual report says planned and the BRF's savings per kvm are low, and `stambyte_ongoing` from the city list. In `confounder-guard.ts`, add an ongoing or planned stambyte to the residual drivers that can explain a low kr per kvm, next to floor and debt, so the tool stops calling those flats renovation bargains.

What the current code does with "stambyte": a citation-backed annual-report enum that turns into a red or green report flag and one sentence of prose, plus a build-year proxy niche. On the discovery path the enum is always empty because its fetch path is Allabrf.

Not achievable from public data: a planned stambyte more than a few months out without the annual report, stambyten done without notification (MÖD 2020:19 is a sanction case for exactly that), relining (I could not confirm whether relining is notifiable), and the cost per member.

### Open questions

- Does the full rendered Booli BRF page ever state a stambyte? One check from the stored render, after the current Booli run finishes, settles it.
- Do BRF annual reports appear in Bolagsverket's free bulk files from 2026? If yes, `ixbrl-to-text.ts` plus the existing extraction can read them; if no, broker PDF attachments are the next source.

---

## One-page summary for Daniel

**Uppmätning.** The claim holds partly. Measuring rules have barely changed since 1987, and the 2020 version added no kvm. The gain comes from flats whose stated area predates modern measurement or was never measured: the old habit of adding up room floors leaves out inner walls and wardrobes, which count today. A measuring firm told Fastighetstidningen that 70 to 80 % of the flats it measures differ from the stated figure, mostly older flats that turn out bigger. Thick walls help only up to 30 cm each, and only if the old figure left walls out; thick exterior walls add nothing. One extra kvm is worth roughly 100 000 to 115 000 kr at your price level, so 2 kvm is about 200 000 kr. Nobody publishes how often or by how much the area grows, so this belongs in a flag ("arean bygger på föreningens uppgift") with an upside shown on the side, not in the score. The broker text the weekly run already reads is enough to start. One point matters for the ranking: an under-measured flat looks expensive per kvm in the tool today.

**Bygglov.** Better than expected. Stockholm's Bygg- och plantjänsten lists every building case per fastighet without a login, back to 1929, with a one-line description, dates and decisions (Bifall, slutbesked). It can also search by keyword and stadsdel: "balkong" on Södermalm returned 97 cases since mid-2025. Drawings need a login. The friend is wrong on one point: a balcony, glazed or not, never counts as boarea. Its value is the balcony itself, about +2 % in Booli's raw numbers. The useful signal is "balconies granted for this building, not built yet". Cost is about 100 to 250 polite requests per weekly run, on a city host, not Booli.

**Stambyte.** Because stambyte needs a notification to the city, the same city search gives a dated stambyte history per building (10 cases on Södermalm since January 2025). That history can be joined to sold flats, so the hedonic model could test a stambyte feature, which no current source allows. The price-effect numbers that circulate (+5 to 12 % after, −8 to 15 % before, also quoted in this repo's July research) trace to an unsourced blog post. The only Swedish regression I found used 64 flats. From cost, an unfunded upcoming stambyte is worth about 5 to 10 % of a flat at this price level, minus BRF savings. Today the code reads stambyte only from manually uploaded annual reports, as planned/recent/not mentioned without a year, and the discovery path never gets it.

**Recommended order**

1. **City case list per building (bygglov + stambyte together).** One fetcher, one cache, two outputs: balcony/glazing flags for candidates, and stambyte years. Start with a spike of 10 known buildings and an email to the city's contact centre. About 1 plan.
2. **Stambyte as a hedonic feature.** A one-off district sweep, join to the 7 379 sold flats, test with cross-validation, keep only if it helps; add the ongoing/planned stambyte confounder either way. About 1 plan.
3. **Area-source and stambyte phrases from broker text.** Pure regex on text already read, needs a 40 to 60 text truth set. About 1 plan, can run in parallel with 1.
4. **Floor-plan under-measurement signals.** Wait until the layout read passes its 75 % gate; then add printed-area and wall-count reads.
