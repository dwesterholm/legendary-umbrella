# Discovery Analysis Redesign — SPEC (2026-07-10)

**Status:** roadmap step 2 (encode research → spec). Feeds the 3-phase build (A/B/C).
**Inputs:** synthesis `2026-07-10-what-makes-apartments-increase-in-price.md` (§1–§8) + brief `2026-07-10-ANALYSIS-REDESIGN-FOLLOWUPS.md`.
**Grounding:** code map of the live pipeline (file:line below are current on `main` @ `e8d1ebb`).

---

## 0. Problem statement (what's wrong today)

The data-fetch pipeline is solid; **analysis quality is the gap**. Four concrete defects, each traced to code:

| # | Defect | Root cause (file:line) |
|---|---|---|
| D1 | **Best renovation targets get dropped.** Dated/original/elderly-owned flats (Ringvägen 122) never reach analysis. | `enrichCandidateImages` (`job.ts:354`) walks candidates in **Booli relevance order** and enriches only the first 8 lacking images. No reno-potential ranking before the cut → dated flats lower in Booli's list enter vision as `no_images` and are dropped. |
| D2 | **`claims: []` = no actionable analysis.** | Two paths: (a) Haiku pre-filter `worthDeepPass:false` (`vision.ts:285`); (b) all deep-pass attributes filtered out by confidence/imageIndex gates (`vision.ts:332`). The Haiku triage currently treats "nothing interesting to see" as skip — backwards for a reno search. |
| D3 | **Analysis is image-only, not holistic.** No BRF (avgift/debt/stambyte) and no renovated-vs-unrenovated comps reach the prompt. | `vision.ts` payload = images only. BRF/comps live in a **separate single-listing pipeline** (`brf/score.ts`, `market/compare.ts`, `booli/client.ts:741 fetchSoldComps`) never wired to discovery. Blocker: persisted job stores no lat/lng/breadcrumbs → `fetchSoldComps` can't be called (`discovery-results.tsx:38-49`). |
| D4 | **Recommendations are generic, not ROI-aware / architect-grade / buyer-tailored.** | `VISION_DEEPPASS_SYSTEM_PROMPT` (`vision-prompt.ts:50`) asks for hedged condition claims + a vague `remodelPotential`. No cost/profit tiers, no ±tax, no buyer-segment tailoring, no per-room designer specifics, no drawing. |

**Locked constraint (must survive the redesign):** `niche-score.ts` and `report/flags.ts` must **never** import vision types — enforced by static-grep test `niche-score.test.ts:281-322` (also forbids `sun-path`). All vision/analysis reads go through the separate `condition-score.ts` path + a **"från bildtolkning"** display marker. Value-gap scoring (Phase B) obeys the same rule.

---

## 1. Target behaviour (what "good" looks like)

For **every** surfaced candidate (no `claims: []`), the analysis produces a holistic, ROI-aware, buyer-tailored opportunity brief:

1. **Condition read** (as today, hedged, image-cited) — but dated/original is a POSITIVE signal, never a skip reason.
2. **Holistic context** — BRF health (avgift, debt/m², stambyte funding state, tomträtt) + renovated-vs-unrenovated comps folded into the value case.
3. **Prioritized opportunity list** — each with: what, cheap/mid/high **cost band**, expected **uplift**, **confidence**, and *why*. Structural items keep the "kräver konstruktör/väggutredning" caveat.
4. **Buyer-segment tailoring** — recommendations + value-gap tuned to the likely buyer of THAT apartment size (§8.2).
5. **Cost-vs-profit matrix** — per opportunity, cheap/mid/high tiers, with **profit shown WITH and WITHOUT tax** (§8.4), uppskov + same-year loss-offset notes, näringsverksamhet caveat on repeat flips.
6. **Value-gap number** — headline opportunity metric (§5 + §8), on the separate read path.
7. **Architect layer** — floorplan assessed R1–R7; for a viable conversion, a **proposed planritning** (image gen) with daylight/bearing caveats.
8. **Interior-designer layer** — per-room specifics (name colors, name furniture moves), never "inrett i nordisk stil."

---

## 2. Encodable ruleset (the brain)

### 2.1 Pre-filter flip (fixes D1 + D2)

- **Enrichment order (D1):** `enrichCandidateImages` must select the top-8 by a **reno-potential + below-market pre-rank**, NOT Booli relevance order. Cheap pre-rank signals available pre-vision: `pricePerSqm` vs candidate-set median (below-market ↑), `constructionYear` (older ↑), absence of "nyrenoverad"-type language in the scraped description (↑). Dated/original must sort UP, not get truncated away.
- **Haiku triage flip (D2a):** for a renovation-intent search, `worthDeepPass` should be TRUE for dated/original/low-signal flats — those are the targets. Reframe the pre-filter prompt: skip only genuinely un-analyzable inputs (no usable interior images at all), never "looks unremarkable." Prefer: **every enriched candidate gets a deep pass.** (Cost: still bounded by `VISION_ENRICH_LIMIT=8` × `CAP_VISION_SEK_MAX`.)
- **No empty analysis (D2b):** when deep-pass attributes are all filtered out, fall back to a **holistic-data-only** opportunity brief (BRF + comps + hedonic) rather than `claims: []`. Every candidate leaves analysis with ≥1 actionable item.
- **Dated = HIGH value:** `condition-score.ts` already gives `remodelPotential +2 / DATED +1 / RENOVATED −1` — keep, and ensure the pre-rank agrees (dated ranks up for a reno search).

### 2.2 Holistic inputs (fixes D3)

Fold into the analysis (see §4 Phase A for the lat/lng blocker fix):
- **BRF:** avgift (capitalization −0.5…−0.7), debt/m² (>15k red flag), tomträtt (−10…−30%), stambyte funding state (sign-flips: done recently +5–12%; imminent+unfunded strong −), soliditet.
- **Comps:** renovated-comp median kr/m² (`R_med`) vs unrenovated (`U_med`) for {stadsdel, ±15% m², floor bucket, ≤12mo}, from `fetchSoldComps` (`booli/client.ts:741`) → `computePriceComparison` (`market/compare.ts:223`).
- **Hedonic directions** (§4 of synthesis): floor (+~1000 kr/m² to floor 5, bottenvåning −10%), balcony (+105k, söder +125k), orientation (söder>väster>öster>norr), energy class ~0 for apartments.

### 2.3 ROI-aware tiered cost/profit (§8.3)

Per opportunity, present cheap/mid/high tiers. Anchors (Stockholm 2025–26, pre-ROT):

| Opportunity | CHEAP | MID | HIGH | Uplift anchor |
|---|---|---|---|---|
| Full kitchen | 50–100k | 150–250k | 350–800k | +200–267k |
| **Kitchen cosmetic** | 20–40k | 30–60k | 50–90k | +80–150k (best ROI/kr) |
| Full bathroom/våtrum | 60–110k* | 130–190k | 200–320k+ | +108k |
| Bathroom cosmetic | 5–20k | 15–40k | 30–60k | +20–50k |
| Paint whole apt (~70m²) | 5–15k | 25–40k† | 45–85k | indirect |
| Floors | slipa 10–20k / DIY laminat 15–30k | 25–45k | 70–130k+ | condition |
| Non-bearing wall | 3–8k | 3.5–14k† | 15–25k | indirect (openness) |
| **Bearing wall (avväxling)** | ~20–30k floor** | 30–45k | 50–80k+ | indirect, no clean hedonic |

\* pure-DIY wet room **invalid** (tätskikt needs GVK-cert labor). \*\* bearing wall anmälningspliktigt → konstruktör + kontrollplan. † post-ROT.

**Rules:** MID ≈ 2.5–3× CHEAP; HIGH ≈ 2–2.5× MID. **Aim 2→4 mid path, not luxury** (5 costs disproportionately). Use ~40–70% of a full-reno uplift for a 1–2-step refresh. Treat published uplift as **ceilings** (WTP softened since 2022). **ROT 2026 = 30% of labor only**, cap 50k/person/yr (100k for two owners); DIY gets none. Full våtrum reno = **cost/margin RISK**, not value-add.

### 2.4 Buyer-segment tailoring (§8.2)

- **1-rok (etta):** single, 25–29, first-time, **financing-capped, turnkey-seeker.** Weight turnkey + light + low-avgift. **Cap ambition at MID; penalize luxury-kitchen recs.** Cosmetic fix-och-färg (≈+15%) + mid kitchen/bath (scale 2→4). Turn-offs: high avgift, dark, unfinished/project feel.
- **2-rok/3-rok:** dual-income couple, early–mid 30s, equity-carrying, **premium-tolerant** (5–15 bidders). Weight **extra room / open kök-vardagsrum / kitchen toward scale 4.** Renovation converts to premium reliably. Turn-offs: bad plan, no real bedroom, dated kitchen, "another project."
- Renovation premium ~fixed SEK → larger % on cheap etta, but discount realizability by the etta buyer's financing cap.

### 2.5 Bathroom rules (§8.1)

- **Reward freshness, not material tier.** Fresh plastmatta scores well; dated/ugly tile (blue/brown 70s–80s) = buyer turnoff even if functional → cheap cosmetic-refresh opportunity (paint 0.5–8k / microcement-over-tile from ~35k), distinct from a full våtrum reno.
- **Microcement-over-våtmatta = HIGH-RISK flag.** State verbatim-style: *cosmetic ytskikt only; does NOT renew tätskikt or reset the våtrumsintyg; do NOT apply over old/unknown-age våtmatta.* Never treat cosmetic overlay as a fix for a failing tätskikt.
- Bathroom uplift ceiling +108k; full reno = margin risk.

### 2.6 Value-gap formula (§5) — headline metric, separate read path

```
Resale_W   = R_med × m²                      # cap at area renovated 75th pct
Purchase_P = asking × (1 + expected_overbid) # hot +0.10 / neutral 0 / cautious −0.03; bias low for reno objects
reno_cost  = chosen tier (default MID)
Net_uplift = Resale_W − Purchase_P − reno_cost − sales_costs − tax_line
ROI floor  : reno "pays" only if (Resale_W − U_med×m²) ≥ 0.65 × reno_cost
```
- **Flags:** HIGH = ≥15% below R_med & dated & Net_uplift ≥150k & ≥8% of purchase. MED = 8–15% below. LOW/skip = within ±5% of R_med.
- **Discount-attribution guard:** >25% below R_med → do NOT assume condition; cap condition-explained at 20%, route residual to hidden-defect penalty (BRF debt, bottenvåning, odd BOA, tomträtt).
- Require ≥5 comps in 12mo or widen band + downgrade confidence. Normalize kr/m² **inclusive of förening debt/m²**.

- **⚠️ LOW kr/m² ≠ RENO OBJECT (operator, 2026-07-17).** A low kr/m² is a *surfacing signal only*, never a conclusion. It can be a renovation opportunity OR a legitimate discount for confounders the price alone can't distinguish. Before the analysis attributes a low kr/m² to condition/reno-upside, it MUST normalise against — and, where the data shows one of these, DISCOUNT the reno conclusion accordingly:
  - **floor** — ground/bottom floor (bottenvåning ≈ −10%);
  - **elevator** — no hiss, esp. floor ≥4 (accessibility penalty);
  - **balcony** — no balcony (söder-balcony is a notable premium);
  - **micro-location** — traffic-/noise-exposed street, poor light/orientation, courtyard vs street;
  - **sub-area** — a genuinely cheaper pocket within the search area (kr/m² is low because the *location* is, not the flat's condition);
  - already-covered: tomträtt, high BRF debt/m², odd BOA.
  The current pipeline **sorts** by kr/m² (surfacing) but makes **no** reno/below-market claim — correct. The reno/below-market *conclusion* is deferred to the analysis iteration (Phase A.4/A.5 value-gap), which must fold these confounders in (several are already fetched: floor, balcony, orientation, tenureForm; elevator + micro-location noise are the gaps). Never render UI text implying "low kr/m² ⇒ renovation object."

### 2.7 Tax lines (§8.4)

```
vinst              = salePrice − sellingCosts − purchasePrice − purchaseCosts − improvementCosts
profit_without_tax = vinst
profit_with_tax    = vinst − max(vinst,0) × 0.22
```
- Optional **uppskov** scenario: interest-free since 2021, takbelopp 3M/home; model deferred `× 0.22` as a liability, not a profit cut.
- **Prior-loss offset:** loss kvoterad 50% (0.70 oäkta brf), deducts 100% vs any capital income **same year only — no carry-forward.** So it shelters only same-calendar-year flips.
- **Näringsverksamhet warning** (non-blocking) on repeat-flip patterns: reclassification → marginal rates + egenavgifter, loses 22% + uppskov.

### 2.8 Architect layer (R1–R7) + drawing

- Room premium huge (inner-city 3→4 >4M); **daylight gate** (window per created part — BBR); **bärande cost-cliff** (30–150k non-bearing vs 220–450k bearing). Loft by takhöjd (2.40/2.70/3.30–3.60m). Never state a wall's bärande status as fact — "kräver konstruktör" (already enforced `vision.ts:78-115`).
- **Proposed planritning** (Phase C): image-gen redraw of a viable conversion, with daylight/bearing caveats stamped on it.

### 2.9 Interior-designer layer (§2 synthesis)

Per-room specifics: name colors ("måla i varm off-white / greige"), name furniture moves ("flytta soffan till X-väggen för luftighet"), evidence-based (small flats sell faster when light/airy; photos>10 = 48% faster). Never "inrett i nordisk stil."

---

## 3. Output schema shape (extends `vision-schema.ts`)

Keep the slim-schema discipline (single-nullable-leaf) to avoid Anthropic strict-output 400s (see memory `anthropic-structured-output-limits`; always run one live smoke). New persisted analysis object (name TBD, e.g. `OpportunityBrief`) — additive, read-guarded by Zod:

- `buyerSegment: "etta" | "par-2-3rok"` (derived from rooms/size)
- `opportunities: Opportunity[]` — each `{ what, room, costTier: {cheap,mid,high} SEK bands, upliftEstimate, confidence, rationale, risk?: string }`
- `bathroomRefresh?: { path: "paint"|"microcement-tile"|"retile"|"full-reno", risk?: microcementWarning }`
- `valueGap: { resaleW, purchaseP, netUplift, profitWithoutTax, profitWithTax, uppskovNote?, lossOffsetNote?, flag: HIGH|MED|LOW, confidence }`
- `architect?: { conversionFeasible: boolean, caveats: string[], proposedDrawingUrl?: string }`
- `designer: { perRoomTips: string[] }`

All of this is **analysis/vision-side** — read only via the `condition-score.ts`-style path + "från bildtolkning" marker. **Never** imported by `niche-score.ts` / `flags.ts`.

---

## 4. Implementation — 3 phases

### Phase A — Analysis brain
1. ✅ **DONE 2026-07-10.** **Flip the pre-filter** (`job.ts` `enrichCandidateImages`): now visits image-less candidates in **reno-potential order** via new pure helpers `candidateMedianPricePerSqm` / `enrichmentPriority` / `enrichmentVisitOrder` (below-market primary + aged-stock secondary, weight 0.25; missing data → 0, never a penalty). `out` stays in input order so broker-map indices stay aligned. +5 tests incl. the Ringvägen 122 scenario (budget of 1 lands on the below-market/1962 flat, not Booli's at-market/2015 first). tsc/eslint/separation-test/full-discovery-suite (182) green.
2. ✅ **DONE 2026-07-10.** **Flip Haiku triage** (`vision-prompt.ts` `VISION_PREFILTER_SYSTEM_PROMPT`): inverted to high-recall — dated/original/unremarkable/already-renovated all pass; skip ONLY when nothing analyzable (no interior photos / too dark-blurry); "when in doubt, pass through." +1 test. Green.
3. **No empty analysis** (`vision.ts:285,332`): holistic-data-only fallback instead of `claims: []`.
4. **Holistic inputs** — comps + BRF.
   - ✅ **CORE DONE 2026-07-10** (`area-comps.ts`): `computeAreaComps()` turns area sold-comps into renovated/unrenovated median kr/m² (tercile proxy) + 75th-pct cap + confidence. Pure, 9 tests, separation-grep extended.
   - **NO MIGRATION NEEDED (finding, 2026-07-10).** The stale `discovery-results.tsx:38-49` comment is wrong post-Phase-12: `toCandidate` already persists lat/lng (candidate.ts:209-210). More importantly `fetchSoldComps` resolves area from **breadcrumbs/areaId, not lat/lng** — and the job already resolves an `areaId` (job.ts:139) that can be **re-resolved cheaply via the cached `resolveArea`** at analysis time (area_cache table). The `OpportunityBrief` + BRF summary ride in the existing JSONB `results` column as additive-nullable candidate fields (the established `vision` pattern). Schema backup taken regardless (scratchpad).
   - **REMAINING (live env):** in `runVisionForJob`, re-resolve areaId → `fetchSoldComps` (synthesize a single-crumb `SoldSourceQuery` from the areaId) → `normalizeSoldOutput` → `computeAreaComps(filter from candidate)`; fetch + extract a BRF summary per top candidate. Inject both into the deep-pass payload. Real Apify spend — respect caps.
5. **ROI-aware + buyer-segment + tiered cost/profit ±tax** encoded into the prompt + `vision-schema.ts` `OpportunityBrief` output. **Needs a LIVE Anthropic strict-output smoke** (mocked tests hide 400s — memory `anthropic-structured-output-limits`). `flip-economics.ts` supplies all the math; A.5 is the prompt text + slim schema + wiring `valueGap`/`taxLines`/`buyerSegment`/`RENO_COST_MATRIX` into the persisted brief.

### Phase B — Value-gap scoring
- ✅ **CORE DONE 2026-07-10** (as `flip-economics.ts`): `valueGap()` §2.6 metric + `buyerSegment()` + `RENO_COST_MATRIX`/`applyRot()` + `taxLines()`/`TAX_NOTES`. Pure, 16 tests, separation-grep extended to forbid it in niche-score/flags. **REMAINING B:** wire `valueGap` into the ranking tiebreaker (`discovery-results.tsx:112-115`) as a ranking input (decision #1) once comps (R_med/U_med) are available from Phase A.4, + the "från bildtolkning" marker in the UI.
- §2.6 formula as the headline opportunity metric + a **ranking input** — but computed on the **separate vision/analysis read path** (extend `condition-score.ts` or a sibling), NOT `computeNicheScore`. Keep the "från bildtolkning" marker.
- **Extend the static-grep separation test** (`niche-score.test.ts:281-322`) to cover any new value-gap module: assert `niche-score.ts`/`flags.ts` still don't import it.
- Wire into ranking tiebreaker in `discovery-results.tsx:112-115` alongside `conditionScore`.

### Phase C — Proposed-drawing generation
- For architect-viable conversions, generate a proposed planritning (image gen), daylight/bearing caveats stamped. Bounded by cost caps; only for HIGH value-gap candidates to limit spend. Broker/source images remain analyze-only, never persisted (GDPR).

---

## 5. Constraints & guards (carry into every phase)

- **Structural separation is LOCKED + tested** — niche-score/flags never import vision/value-gap/sun-path. Extend `niche-score.test.ts` grep list per Phase B.
- **`DISCOVERY_ENABLED`** fail-closed; **cost caps** (`CAP_VISION_SEK_MAX=10`, `VISION_ENRICH_LIMIT=8`, `CAP_CANDIDATES_MAX=25`) — real Apify + Anthropic spend every run.
- **Migrations additive only** (new numbered file). **A.4/A.5 need NO migration** (finding above) — analysis output + BRF ride in the JSONB `results` column; comps use the re-resolved areaId. Next free slot is 013 if one ever becomes necessary.
- **Anthropic strict-output:** slim single-nullable-leaf schemas; run one **live API smoke** before trusting mocked tests.
- **GDPR:** broker/gallery images analyze-only, never rendered/persisted.
- **tsc/eslint clean + full test suite** (681 tests baseline) green before each phase merges.

---

## 6. Operator decisions (LOCKED 2026-07-10)

1. **Value-gap = ranking input + display.** Value-gap re-orders results (a ranking signal alongside niche-score + condition tiebreaker), on the separate vision read path (locked separation preserved). → Phase B wires into `discovery-results.tsx:112-115` ordering, not just card annotation.
2. **Phase A = full holistic incl. BRF docs.** Phase A fetches + extracts BRF årsredovisning per top candidate (avgift, debt/m², stambyte funding, soliditet) in addition to comps + hedonic. Bigger A; more scraping cost — respect cost caps.
3. **Tax = show both lines + static notes, no operator input.** Always display `profit_without_tax` + `profit_with_tax` (flat 22%) + static uppskov (interest-free) & same-year loss-offset notes. No per-session input UI. (Personalized loss/uppskov input is a possible later enhancement.)
4. **Phase C = HIGH value-gap candidates only** (in scope). Generate proposed planritning only for HIGH value-gap flags to bound image-gen spend. Model/provider TBD at Phase C start (options: `nano-banana` skill / `higgsfield` / other).
