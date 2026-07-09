---
phase: 02-brf-financial-analysis
status: secured
audited: 2026-06-16
asvs_level: 2
block_on: high
register_authored_at_plan_time: true
threats_total: 20
threats_closed: 20
threats_open: 0
accepted_risks: 2
---

# SECURITY.md — Phase 02: BRF Financial Analysis

**Audit date:** 2026-06-16
**ASVS Level:** 2
**Block-on:** high
**Result:** SECURED — 20/20 threats closed (18 mitigations verified in code, 2 accepted risks documented)
**Register provenance:** authored at plan time (register_authored_at_plan_time: true); each declared mitigation verified present in implementation.

---

## Threat Verification

| Threat ID | Category | Disposition | Status | Evidence (file:line) |
|-----------|----------|-------------|--------|----------------------|
| T-02-01 | Info Disclosure | mitigate | CLOSED | `.gitignore:19-20` ignores `evals/fixtures/` + `evals/labels.json`; `git check-ignore` confirms both ignored; `git ls-files` confirms `evals/labels.example.json` tracked, `labels.json`/fixtures NOT tracked |
| T-02-02 | EoP | mitigate | CLOSED | `supabase/migrations/002_brf.sql:32-35` — storage.objects policy `(storage.foldername(name))[1] = auth.uid()::text` for `bucket_id='brf-pdfs'`, both `using` and `with check`; path convention `{userId}/{analysisId}.pdf` enforced in `src/lib/supabase/storage.ts:21-23` |
| T-02-03 | Info Disclosure | mitigate | CLOSED | `002_brf.sql:26-28` bucket inserted with `public=false`; no `getPublicUrl` anywhere in `src/` (grep: none); `storage.ts` exposes only `uploadBrfPdf`/`downloadBrfPdf` (RLS-scoped download) |
| T-02-04 | Tampering/EoP | mitigate | CLOSED | `002_brf.sql:20-23` — `create policy ... for update using (auth.uid()=user_id) with check (auth.uid()=user_id)` |
| T-02-05 | DoS | accept | CLOSED (accepted) | Free-tier Supabase pause is operational; documented as accepted risk below. No code mitigation expected. |
| T-02-06 | Tampering | mitigate | CLOSED | `src/lib/brf/sanity.ts:56-74` `applySanityChecks` forces out-of-band values to confidence `0.2` (`DOWNGRADED_CONFIDENCE`, L13) < `OSAKER_THRESHOLD` `0.5` (L10) WITHOUT dropping value; called in `analyze-brf.ts:120-129` before `computeBrfGrade` (`scoreExtraction`, L143-144) |
| T-02-07 | Tampering | mitigate | CLOSED | `src/lib/schemas/brf.ts:46-60` extraction schema has NO grade/score/rating key (explicit comment L59); `src/lib/brf/score.ts:162-220` `computeBrfGrade` is pure/deterministic (no Claude, async, Date, Math.random, network) |
| T-02-08 | DoS (budget) | mitigate | CLOSED | `src/lib/brf/cost.ts:45-57` `costSek` computes SEK from usage; `analyze-brf.ts:19` `COST_CAP_SEK=5`, enforced at L250-256. NOTE: post-call persistence gate, not pre-call spend cap (CR-02 — accepted residual, see below) |
| T-02-09 | Info Disclosure | mitigate | CLOSED | SDK instantiated only in `src/lib/brf/extract.ts:18` (`new Anthropic()`); grep confirms `@anthropic-ai/sdk` imported only there; no `dangerouslyAllowBrowser` in `src/`; no `NEXT_PUBLIC_*ANTHROPIC`; `.env.local.example:8-11` marks key SERVER-ONLY; `next.config.ts:7` lists `@anthropic-ai/sdk` in `serverExternalPackages` |
| T-02-10 | EoP | mitigate | CLOSED | `analyze-brf.ts:175-181` server-side `auth.getUser()` gate (no guest path); ownership check `row.user_id !== user.id` at L185-193; RLS (T-02-02/T-02-04) is the second layer |
| T-02-11 | DoS/Tampering | mitigate | CLOSED | `analyze-brf.ts:166-172` server-side `file.type !== "application/pdf"` + `file.size > MAX_PDF_BYTES` (20 MB, L22) BEFORE any storage/Claude work |
| T-02-12 | Info Disclosure (PII) | mitigate | CLOSED | `extract.ts:201-206` logs only `{ contentHash, code }`; `analyze-brf.ts:94-98, 272-276` log only `{analysisId, contentHash, code}` — never raw bytes/financials/quotes |
| T-02-13 | DoS (budget) | mitigate | CLOSED | `extract.ts:165` `cache_control: { type: "ephemeral" }` on document; bounded retry exactly once at L182-187; `analyze-brf.ts:204-209` content-hash skip-Claude cache; 5 SEK cap at L250 |
| T-02-14 | Tampering | mitigate | CLOSED | `schemas/brf.ts:46-60` no grade field; `analyze-brf.ts:143-144` grade comes only from `computeBrfGrade`; system prompt `prompt.ts:25` forbids model grading (defense-in-depth) |
| T-02-15 | EoP | mitigate | CLOSED | `brf-section.tsx:56-83` guest teaser (UI defense-in-depth, comment L55); authoritative gate is server action `analyze-brf.ts:175-181`; `(app)/layout.tsx:15-17` `redirect("/login")` for unauthenticated route group |
| T-02-16 | DoS/Tampering | mitigate | CLOSED | `brf-upload.tsx:40-48` client `validate` (type+size); re-validated at submit L70-75 with explicit "server re-checks too" comment; server re-validates identically `analyze-brf.ts:166-172` |
| T-02-17 | Info Disclosure | accept | CLOSED (accepted) | `brf-progress.tsx:48-52` selects ONLY `brf_status` under the user's own RLS session; no financials read. Documented as accepted risk below. |
| T-02-18 | Tampering | mitigate | CLOSED | `analyze-brf.ts:330-444` `correctBrfField`: auth gate L347-354, ownership check L362-364, re-runs deterministic `scoreExtraction` only (NO `extractBrfFinancials`, comment L417); corrected field rendered "Manuellt angiven" (`brf-score-card.tsx:269-275`) |
| T-02-19 | Info Disclosure | mitigate | CLOSED | `src/app/sa-raknar-vi/page.tsx` — grep confirms no supabase/createClient/anthropic/DB-query/auth; renders only imported `BRF_SCORE_THRESHOLDS`/`BRF_SANITY_BANDS` constants; lives outside `(app)` route group by design (comment L18-26) |
| T-02-20 | Tampering | mitigate | CLOSED | `brf-score-card.tsx:143-144, 219` renders code-computed `data.grade.grade` (from `computeBrfGrade`, D-08); links to public methodology `/sa-raknar-vi` (L375), which renders the SAME scorer constants — methodology aligns to displayed grade |

---

## Accepted Risks Log

### T-02-05 — DoS via Supabase free-tier pause (ACCEPTED)
Free-tier Supabase projects pause after inactivity. This is an operational/availability concern, not a code-mitigatable vulnerability. Accepted at plan time; no code change expected. Mitigation if/when material: upgrade tier or add a keep-alive ping.

### T-02-17 — BRF progress poll exposure (ACCEPTED)
`BrfProgress` (`src/components/brf-progress.tsx:48-52`) polls the analyses row but selects ONLY the `brf_status` column, under the browser user's own RLS session. No financials, no `brf_data`, no other user's rows are reachable. The only data exposed to the browser is a coarse status string for a row the user already owns. Accepted as designed.

### CR-02 — Cost cap is a persistence gate, not a pre-call spend cap (ACCEPTED RESIDUAL)
Documented in `02-REVIEW.md` CR-02 and honestly commented in `src/actions/analyze-brf.ts:241-249`. The `COST_CAP_SEK=5` check runs AFTER the Claude call returns (token count is unknown until then), so it gates PERSISTENCE of an over-budget result rather than the spend itself. Per-REQUEST spend is inherently bounded by a single Haiku call at `max_tokens: 2048` plus one truncation retry (observed ~0.71 SEK). Per-USER aggregate spend is NOT bounded — an authenticated script could repeatedly invoke `analyzeBrf` and bill each call. A per-user rate limit / DoS guard is a deferred follow-up, explicitly out of scope for this phase. Consistent with T-02-08/T-02-13 dispositions; accepted residual, not a blocker under block-on: high.

---

## Unregistered Flags

None. No `## Threat Flags` section exists in any Phase 02 SUMMARY; the SUMMARYs carry `## Threat Model Coverage` sections that map only to already-registered threat IDs. No new attack surface appeared during implementation without a threat mapping.

---

## Verification Notes

- Implementation files were treated as READ-ONLY; no implementation file was modified.
- Each `mitigate` threat was confirmed by locating the actual mitigation call/policy in the cited file (not by code shape or documentation intent).
- Key-leakage checks (`getPublicUrl`, `dangerouslyAllowBrowser`, `NEXT_PUBLIC_*ANTHROPIC`, SDK import sites) were run across all of `src/` and returned the expected results (only `extract.ts` imports the SDK; no public-URL or browser-SDK paths exist).
- `git check-ignore` and `git ls-files` confirmed the T-02-01 gitignore claims at the VCS level, not just by reading `.gitignore`.
