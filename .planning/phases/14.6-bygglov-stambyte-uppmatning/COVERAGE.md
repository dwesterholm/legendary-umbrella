# API Coverage — Stockholm Bygg- och plantjänsten, Lantmäteriet Min Karta, Booli, Anthropic (Phase 14.6)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> The city e-service is read with plain GETs through one gated client (`src/lib/stockholm/bygglov-client.ts`): honest User-Agent, at least 3 s between requests per host, one attempt, no cookie, redirect refused, 5 MiB cap, a 24 h stop on any refusal, login wall, terms page or page change (D-01, R-01). Min Karta is rung (c) of the address-to-beteckning ladder only (D-02, R-06). No Booli request and no Anthropic call is made by this phase (D-11). 0 USD Apify, 0 kr Anthropic.

| capability | decision | reason |
|---|---|---|
| Stockholm: case list by fastighetsbeteckning (`/byggochplantjansten/arendeochhandlingar?ExtendedAddress=false&RealEstateName=<b>`) | INTEGRATE | One GET per building, all rows embedded as `CaseSearchResultsViewModel` JSON (R-01); exact-match filtered; cached 30 days per beteckning (plans 01, 02); used by the spike, the candidate stage and the weekly job |
| Stockholm: address to beteckning (`/Byggochplantjansten/CaseSearch/AddressSearch?addressSearchField=<a>`) | INTEGRATE | Rung (b), the cheapest network rung (about 700 bytes); equal-address rule, prefix matches refused (plan 03); also stage B/C of the sold join (plan 06) |
| Stockholm: extended search (District, Description, CaseStartDateFrom, CaseStartDateTo; no `SearchParameters.` prefix) | INTEGRATE | The one-off stambyte sweep, 11 stadsdelar x 4-5 keywords x 2 windows, about 88-110 GETs, heading-count check against a hidden cap (plan 05); one narrow window in the spike tests whether Description is a substring search (R-07) |
| Stockholm: case detail page (`/Byggochplantjansten/arende/arende/<RecNo>?dataSource=Active|Archived`) | INTEGRATE | Only for interesting kinds started within 5 years, at most 3 per building (D-03), and for matched stambyte cases started 2019 or later in the sold join (at most 80); the embedded `caseViewModel.Decisions` array gives every decision |
| Stockholm: `robots.txt` | INTEGRATE | Read once by the spike (R-07); a disallow for the case pages is a phase stop |
| Stockholm: extended-search fields DecisionType, DecisionDateFrom/To, CaseTypeRecNo, DiaryNumberPlanNumber, RealEstateName2 | OPT-OUT | Not needed: the keyword, stadsdel and start-date filters plus local classification give every field this phase uses |
| Stockholm: `CaseAdvanced/GetPaginationComponent`, `CaseAdvanced/GetDecisionsList` | OPT-OUT | Not needed: they render client-side paging widgets; every row and every decision is already embedded in the first response |
| Stockholm: `OtherCases` (Funktionskontroll, Tillstånd) and `RealEstateCases` (Lantmäteri) lists | OPT-OUT | Not needed for the flags: OVK inspections and land-survey cases carry no balcony or stambyte signal; parsed for the counts only, never used for a flag |
| Stockholm: case documents and drawings | OPT-OUT | Explicitly out of scope: behind e-legitimation (CONTEXT deferred list); document titles can carry names and are never read or stored |
| Stockholm: login, BankID, e-legitimation | OPT-OUT | Explicitly out of scope: a login wall is a stop condition (D-01), never attempted |
| Stockholm: officer (Handläggare), applicant and document fields | OPT-OUT | Explicitly out of scope: personal data, dropped in the parser before anything is cached (D-03, V8) |
| Lantmäteriet Min Karta: `searchservice/searchinput` | INTEGRATE | Rung (c) only, after the city's own address search misses; Stockholm-only equal hit, no fuzzy fallback; honest User-Agent plus Referer, tested once in the spike (R-06) |
| Lantmäteriet Min Karta: `positionsinformation/registerenhetermedbuffer/v1` | INTEGRATE | Rung (c): buffer ladder 0, 5, 10 m, at most 5 calls per address |
| Lantmäteriet Min Karta: `searchservice/fastighetsinfo/v1` | INTEGRATE | Rung (c): parcel geometry for point-in-polygon with holes (street land refused) |
| Lantmäteriet Min Karta: use in the sold join | OPT-OUT | Not needed: 2-5 calls per address at 3 s is too slow for thousands of sold addresses; the city's address search covers the join (RESEARCH 5.4) |
| Lantmäteriet Min Karta: owner, valuation or register data | OPT-OUT | Explicitly out of scope: only public geometry and the beteckning text are read |
| Booli: any page, any host | OPT-OUT | Explicitly out of scope (D-11): the Booli gate is closed until 2026-10-19 14:57 UTC and the enrichment is paused by Daniel (14.5 R-09); the broker-text readers run on the next live run that already reads broker pages (the Monday job or 14.5 plan 13), and the 40-text audit is deferred to that run |
| Anthropic: any model call | OPT-OUT | Explicitly out of scope (D-11): all parsing in this phase is deterministic (regex over text, JSON over pages) |
| Apify: any actor | OPT-OUT | Explicitly out of scope (D-11): 0 USD |
