---
phase: 04
slug: ai-report-delivery
status: accepted
threats_open: 0
asvs_level: 1
created: 2026-07-06
---

# Phase 04 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> **Closure mode:** operator-accepted (State B, no prior SECURITY.md). All 24
> plan-time threats were closed via acceptance on 2026-07-06. A subset (the
> high-severity auth / IDOR / no-verdict / RLS / render threats) were
> INDEPENDENTLY VERIFIED against the current implementation during this pass and
> are marked ✓; the remainder are accepted on the strength of plan-time design +
> the passing 175-test suite + the 2026-07-06 UAT, WITHOUT a dedicated
> gsd-security-auditor pass. See Accepted Risks Log for the honesty caveat.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| client button → server action | Untrusted `analysisId`; an attacker may target another user's analysis (IDOR) | analysis id (UUID) |
| guest → report section | A logged-out visitor must not see another user's report content | rendered report / actions |
| structured fact sheet → Sonnet | Prompt-injection via årsredovisning/listing text carried into structured data | financial + listing data |
| Sonnet output → persisted report | The model could attempt a verdict or a model-minted flag | report JSON |
| persisted JSONB → render / PDF | A drifted/malformed stored report must degrade, not crash or leak | report_data JSONB |
| token usage → cost guard | Mis-rated cost lets the priciest call slip past the 5 SEK budget | usage/cost |
| migration file → live DB | A mis-scoped migration could broaden RLS | schema/policy |
| npm install → build | A malicious/typo package enters the bundle | dependency tree |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation (evidence) | Status |
|-----------|----------|-----------|-------------|------------------------|--------|
| T-04-01 | Tampering | flags.ts threshold drift | accept | Imports shared BRF/PRICE thresholds; golden tests pin parity | closed |
| T-04-02 | Info disclosure | reportDataSchema drift on render | accept | ✓ `safeParseReportData` → null affordance (report.ts); verified + regression-tested this session | closed |
| T-04-03 | DoS (budget) | Sonnet cost under-reported | accept | `SONNET_USD_PER_MTOK` + `costSekSonnet` feed the 5 SEK guard | closed |
| T-04-04 | Spoofing/Tampering | model-minted flag | accept | ✓ `reportSchema` has no free-form flag field; flags = pure-TS `computeFlags`, id-only (verified) | closed |
| T-04-05 | Tampering | invented stambyte/renovation (FM5/FM7) | accept | System prompt requires verbatim `sourceQuote`+`pageRef`; eval citation gate | closed |
| T-04-06 | Info disclosure | financials in extraction logs | accept | `extract.ts` logs only `{contentHash, code}` | closed |
| T-04-07 | Tampering | extraction regression on four metrics | accept | Cross-phase eval re-run gate (deferred eval infra — see UAT Test 6) | closed |
| T-04-08 | Tampering | prompt-injection into synthesis | accept | Structured input only, schema-constrained output, no tool use, flags pre-computed | closed |
| T-04-09 | Spoofing | Sonnet issues a verdict (FM2/D-04) | accept | ✓ `reportSchema` has no verdict/recommendation/betyg field; strip test asserts it (verified) | closed |
| T-04-10 | Elevation | migration broadens RLS | accept | ✓ `004_report.sql` creates 0 policies (grep-verified); existing SELECT/UPDATE cover new cols | closed |
| T-04-11 | Info disclosure | financials in synthesis logs | accept | `synthesize.ts` logs only `{analysisId, code}`; factSheet never logged | closed |
| T-04-12 | Spoofing/Elevation | generateReport without auth | accept | ✓ `getUser()` → `if(!user)` Swedish login error, no guest path (generate-report.ts:170) — verified | closed |
| T-04-13 | Info disclosure | cross-user report (IDOR) | accept | ✓ `row.user_id !== user.id` → "hittades inte" (generate-report.ts:184) behind RLS — verified | closed |
| T-04-14 | DoS (budget) | double-spend via repeated regenerate | accept | ✓ atomic CAS in-flight lock + 5 SEK cap. NOTE: lock predicate FIXED this session (null-status `.neq` trap → `.or(is.null,neq)`); verified + regression-tested | closed |
| T-04-15 | Info disclosure | report prose in logs | accept | Logs only `{analysisId, code}` (GDPR posture) | closed |
| T-04-16 | DoS (budget) | Sonnet cost under-reported (Pitfall 3) | accept | `costSekSonnet` feeds the 5 SEK guard, not Haiku cost | closed |
| T-04-17 | Info disclosure | cross-user PDF download (IDOR) | accept | ✓ `getUser()` + `if(!user)` + `row.user_id !== user.id` (download-report-pdf.ts:51,64) — verified | closed |
| T-04-18 | Info disclosure | public exposure of a paid analysis | accept | PDF is download-only, rendered on demand, never hosted, no public link (D-10) | closed |
| T-04-19 | DoS | TTF dropped from server bundle | accept | `outputFileTracingIncludes` ships the .ttf; `render.test.ts` smoke-tests å/ä/ö | closed |
| T-04-20 | Tampering | re-synthesis breaks single source of truth | accept | render/download consume persisted `report_data` only; test asserts no `synthesizeReport` call | closed |
| T-04-21 | Info disclosure | guest sees report content | accept | ✓ `isGuest` teaser branch + owner-only page. NOTE: RLS `auth.uid()=user_id` (no anon read) means a guest actually 404s before report_data is fetched — verified this session (UAT Test 4) | closed |
| T-04-22 | Info disclosure | drifted report_data crashes/leaks on render | accept | ✓ `safeParseReportData` → null affordance (CR-01), never a white screen — verified this session | closed |
| T-04-23 | DoS (budget) | staleness check auto-fires synthesis | accept | D-08 shows marker + manual regenerate only; in-flight lock guards concurrent regenerate (UAT Test 3 pass) | closed |
| T-04-24 | Tampering | partial-hash fingerprint desyncs staleness | accept | Page recomputes fingerprint over the FULL `assembleFactSheet` bytes; grep gate asserts parity | closed |
| T-04-SC (×6) | Tampering | npm installs | accept | Only new dep `@react-pdf/renderer` (RESEARCH audit: ~8yr, ~4M/wk, official repo, no postinstall); all other plans install nothing | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*
*✓ = mitigation independently verified against current code during the 2026-07-06 pass.*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-04-01 | T-04-01,03,05,06,07,08,11,15,16,18,19,20,24 + T-04-SC | Closed by operator acceptance without a dedicated gsd-security-auditor pass. Accepted on the strength of the plan-time threat model (all `mitigate` dispositions with concrete controls), the passing 175-test suite, and the 2026-07-06 UAT that exercised the report generation, PDF, guest, and stale-data paths. Residual risk: the specific controls for these threats were NOT re-read line-by-line this pass. | daniel.westerholm (operator) | 2026-07-06 |
| AR-04-02 | T-04-07 | The live extraction/citation eval gate depends on a labeled reference dataset that does not yet exist (tracked in UAT Test 6 as an explicit, non-gating deferral). Fabrication-defense (T-04-05) rests on the system-prompt citation contract until the eval dataset is built. | daniel.westerholm (operator) | 2026-07-06 |

*Note: T-04-02, 04, 09, 10, 12, 13, 14, 17, 21, 22, 23 were independently verified this pass (see ✓) and are not merely accepted — they carry current-code evidence.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-06 | 24 (+6 T-04-SC) | 30 | 0 | operator acceptance (11 independently verified inline; no gsd-security-auditor pass) |

---

## Sign-Off

- [x] All threats have a disposition (accept)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: accepted` set in frontmatter (NOT `verified` — no dedicated auditor pass was run this cycle)

**Approval:** accepted 2026-07-06 (operator). Re-run `/gsd-secure-phase 4` with "Verify all" for a full independent audit before production deploy.
