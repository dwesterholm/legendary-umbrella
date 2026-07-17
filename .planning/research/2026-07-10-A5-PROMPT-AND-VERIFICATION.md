# A.5 prompt + schema (ready to smoke) + full verification flow (2026-07-10)

Companion to `2026-07-10-ANALYSIS-REDESIGN-SPEC.md`. This is what to paste/wire in the live-env session, plus the exact steps to verify it — including server start.

---

## Part 1 — Design decision that de-risks the schema

**The model does NOT compute money.** `flip-economics.ts` + `area-comps.ts` compute value-gap, tax lines, tiered costs and buyer segment **deterministically in code**. The model only does the QUALITATIVE read (what opportunities, why, per-room design, architect feasibility). Code then attaches the economics.

Why: (1) no hallucinated numbers; (2) a **slim** schema — the main cause of Anthropic strict-output 400s is too many nullable→union params + numeric constraints (memory `anthropic-structured-output-limits`). Keeping the model's added fields small and its numbers unconstrained is the safe path.

So `OpportunityBrief` = **model part** (small) + **code part** (computed, no model).

---

## Part 2 — The prompt addition (Swedish, appends to `VISION_DEEPPASS_SYSTEM_PROMPT`)

Inject a one-line buyer-segment context (computed in code) at the top, then ask for a prioritized opportunity list + designer tips + architect note. Draft:

```
KÖPARKONTEXT (ges av systemet): {{buyerSegmentSentence}}
  – etta:      "Detta är en etta. Köparen är sannolikt en singel förstagångsköpare med
                begränsad budget som vill ha inflyttningsklart och ljust. Föreslå ALDRIG
                lyxrenovering – prioritera fräscht, ljust och prisvärt (fix och färg,
                mellanklasskök/badrum)."
  – par-2-3rok:"Detta är en 2–3:a. Köparen är sannolikt ett par med dubbel inkomst och mer
                köpkraft. Ett extra rum, öppen köks-/vardagsrumslösning och ett modernare kök
                belönas här."

Ge en PRIORITERAD lista med värdehöjande åtgärder (opportunities) – de mest lönsamma först.
För VARJE åtgärd:
- action: kort beskrivning av åtgärden (t.ex. "fräscha upp badrummet – måla över daterat kakel").
- room: en av "kok" | "badrum" | "planlosning" | "helhet" | "annat".
- rationale: HEDGAD motivering ("verkar", "ser ut att", "tyder på") kopplad till köparkontexten.
- imageIndex (1-baserat) + confidence (0–1), precis som för skick-bedömningen.
- Håll dig till vad bilderna/planritningen faktiskt visar. Hitta ALDRIG på en åtgärd.

BADRUM – särskild regel: belöna FRÄSCHT, inte dyrt material. Daterat/fult kakel (blå/bruna
70–80-tal, udda färger) är en köparnackdel även om det fungerar → föreslå billig kosmetisk
uppfräschning. Om du föreslår mikrocement OVANPÅ en befintlig våtmatta: skriv ALLTID att det
är ett ytskikt som INTE förnyar tätskiktet eller våtrumsintyget, och att det inte bör göras
över en gammal/okänd våtmatta.

VÄGG/BÄRANDE: som tidigare – peka ALDRIG ut en vägg som bärande/icke-bärande som ett faktum;
formulera som något att utreda (kräver konstruktör / väggutredning).

designerTips: 2–4 KONKRETA inredningsråd (namnge färg/åtgärd, t.ex. "måla i varm off-white för
ljusare intryck", "flytta soffan till fönsterväggen för luftighet"). ALDRIG "inrett i nordisk stil".

architectNote (valfritt, null om ej relevant): om planlösningen antyder en möjlig omdisponering
(t.ex. 1:a → 2:a, öppna kök/vardagsrum), beskriv idén HEDGAT + caveat (dagsljus per rum,
bärande utreds). Annars null.

Svara ENDAST enligt schemat.
```

## Part 3 — Schema additions (`vision-schema.ts`) — keep SLIM

Model-produced fields (add to the deep-pass schema; reuse the `conditionAttribute` single-nullable-leaf discipline):

```ts
// each opportunity — flat, numbers UNCONSTRAINED (no min/max → lower 400 risk)
opportunity = {
  action: string,
  room: enum ["kok","badrum","planlosning","helhet","annat"],
  rationale: string,           // hedged
  imageIndex: number | null,
  confidence: number,
}
opportunities: opportunity[]           // may be empty ONLY if truly nothing seen
designerTips: string[]
architectNote: { idea: string, caveat: string } | null
```

Code-attached fields (NOT from the model — computed in `runVisionForJob` after the deep pass, from `flip-economics.ts` + `area-comps.ts`):

```ts
buyerSegment: "etta" | "par-2-3rok"           // from rooms/size
valueGap: { resaleW, purchaseP, netUplift, flag: "HIGH"|"MED"|"LOW", confidence }
taxLines: { profitWithoutTax, profitWithTax, notes: string[] }   // static uppskov/loss notes
costMatrix: per-opportunity { cheap, mid, high }  // from RENO_COST_MATRIX by room
```

**No-empty-analysis (A.3):** if `opportunities` comes back empty but we HAVE holistic data (comps/BRF/hedonic), synthesize at least one data-driven opportunity in code rather than persisting an empty brief.

## Part 4 — Wiring (`runVisionForJob`, `job.ts`)

1. Re-resolve areaId: `const { areaId } = await resolveArea(filters.areaQuery, supabase)` (cached, near-free).
2. Fetch comps ONCE per job: build a single-crumb `SoldSourceQuery` `{ lat:0, lng:0, booliId:null, breadcrumbs:[{url:`?areaIds=${areaId}`}], tier:"neighborhood", objectType:"Lägenhet" }` → `fetchSoldComps` → `normalizeSoldOutput`. (Real Apify spend — 1–2 renders; fold into the cost gate.)
3. Per top candidate: `computeAreaComps(comps, { rooms, livingArea, asOf: today })` → feed `valueGap`.
4. Per top candidate: fetch + extract a BRF summary (reuse `brf/extract.ts`), stash in the candidate JSON (analyze-only).
5. Inject buyer-segment sentence + a short comps/BRF summary into the deep-pass user message.
6. After the model returns, attach the code-computed economics → persist the full `OpportunityBrief` in the candidate (JSONB `results`, additive-nullable — no migration).

---

## Part 5 — FULL VERIFICATION FLOW (what to run)

### 5.0 Prerequisites — env (`.env.local`)
All server-only unless `NEXT_PUBLIC_`. Set every one:
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
APIFY_API_TOKEN=...          # real Apify spend on every run
ANTHROPIC_API_KEY=...        # real Anthropic spend
DISCOVERY_ENABLED=true       # EXACTLY "true" or discovery fails closed
```

### 5.1 Offline gates first (free — do before spending)
```
npm run test        # full vitest — expect 209+ discovery tests green
npx tsc --noEmit    # types clean
npm run lint        # eslint clean
```

### 5.2 The LIVE strict-output smoke (the make-or-break step)
Model this on the existing cost-gated eval (`evals/extractor.eval.ts`, run via `npm run eval`). Create `evals/opportunity-brief.eval.ts` gated by `RUN_LLM_EVALS=1 && ANTHROPIC_API_KEY`, calling the REAL `runVisionForCandidate` on ~2 frozen fixtures. It must assert:
- the call does **NOT** 400 (the strict-output format is accepted) ← the whole point;
- `opportunities` parse, `room` is a valid enum, hedged language present, no banned verdict words;
- a dated-bathroom fixture yields a cosmetic-refresh opportunity, and any microcement-over-våtmatta rationale includes the tätskikt/intyg caveat.

Run: `RUN_LLM_EVALS=1 npx vitest run evals/opportunity-brief.eval.ts` (bare `vitest` isn't on PATH — it's a local dev dep, so use `npx vitest` or add an npm script like the existing `npm run eval`).
**If this 400s: slim the schema further** (drop a nullable union, remove any numeric constraint, flatten a nested object) and re-run before touching the UI.

### 5.3 End-to-end in the browser (real job, real spend)
1. Start the dev server — launch config **`bostad-ai-dev`** (port 3001): `npm run dev -- -p 3001`.
2. Open `http://localhost:3001/discover`, sign in.
3. Start a search that reproduces the original miss, e.g. **"1:a i Södermalm och Vasastan under 4 miljoner"**.
4. The client **tick** drives the job (primary driver; the `/api/discovery/sweep` cron route is only an orphan-resume safety net and needs `CRON_SECRET` — not needed for manual verify).
5. Watch it reach `done`, then on `/discover/[jobId]` confirm:
   - **the Ringvägen-122-type flat is present and analyzed** (no `claims: []`, has an `OpportunityBrief`);
   - opportunities are prioritized, hedged, buyer-segment-appropriate (no lux recs on an etta);
   - value-gap number shows and results are **ranked** by it;
   - tax shows **both** with/without lines + the uppskov/loss notes;
   - a dated bathroom shows the cheap-refresh path with the microcement caveat.

### 5.4 What to watch in logs/console
- Server logs: `fetchSoldComps served by rung N`, no `VISION_PERSIST_FAILED`, cost under `CAP_VISION_SEK_MAX`.
- Browser console: no schema/parse errors on the results page.
- DB spot-check (Supabase SQL editor): the job row's `results` JSONB has `opportunityBrief` on candidates; `cost_sek_total` within cap.

### 5.5 Cost note
Every E2E run spends real Apify (area search + up to 8 detail renders + 1–2 comps renders) and Anthropic (Haiku triage + Sonnet deep pass × up to 8). Caps: `VISION_ENRICH_LIMIT=8`, `CAP_VISION_SEK_MAX=10`, `CAP_CANDIDATES_MAX=25`. One verification run is cheap; don't loop it.

---

## Part 6 — Order of operations for the session
1. 5.1 offline gates (free).
2. Wire schema+prompt (Parts 2–4) with MOCKED unit tests.
3. 5.2 live smoke — iterate on schema until no 400.
4. 5.3 one E2E run — confirm the Ringvägen flat + brief quality.
5. Then Phase B (rank by value-gap + "från bildtolkning" marker) and Phase C (drawing for HIGH only).
