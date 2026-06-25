---
phase: 04-ai-report-delivery
plan: 03
subsystem: ai-report
status: paused-at-checkpoint
tags: [ai, synthesis, sonnet, migration, evals, gdpr]
requires:
  - "src/lib/schemas/report.ts (reportSchema, AiReport) — Plan 04-01"
  - "src/lib/report/fact-sheet.ts (assembleFactSheet) — Plan 04-01"
  - "src/lib/report/flags.ts (FlagSet, computeFlags) — Plan 04-01"
  - "src/lib/brf/cost.ts (costSekSonnet, SONNET_USD_PER_MTOK) — Plan 04-01"
provides:
  - "synthesizeReport — the one Sonnet 4.6 synthesis call (RPRT-01)"
  - "REPORT_SYNTHESIS_SYSTEM_PROMPT + REPORT_SYNTHESIS_PROMPT_VERSION"
  - "supabase/migrations/004_report.sql — five additive report_* columns (FILE only; NOT yet applied)"
  - "evals/report-promptfooconfig.yaml + evals/report-judge.ts — synthesis eval scaffolds"
affects:
  - "src/actions/generate-report.ts (Plan 04 — consumes synthesizeReport + persists to report_* columns)"
  - "public.analyses (live DB — five report_* columns, pending the human-gated push)"
tech-stack:
  added: []
  patterns:
    - "messages.parse + zodOutputFormat(reportSchema) — structured output (mirrors extract.ts)"
    - "stop_reason branched BEFORE parsed_output; coded rethrow with cause"
    - "GDPR-safe logging: only { analysisId, code }"
    - "additive idempotent migration, no new RLS (mirrors 003_market_context.sql)"
key-files:
  created:
    - src/lib/report/prompt.ts
    - src/lib/report/synthesize.ts
    - supabase/migrations/004_report.sql
    - evals/report-promptfooconfig.yaml
    - evals/report-judge.ts
  modified:
    - evals/report.test.ts
decisions:
  - "synthesize.ts uses plain client.messages.parse (no Files API / beta needed) — bare claude-sonnet-4-6 id"
  - "Tests mock @anthropic-ai/sdk via a globalThis-hung vi.fn() to dodge the vi.mock hoist TDZ — runs with no ANTHROPIC_API_KEY, no spend"
  - "Migration FILE committed but NOT pushed — live DB push is the operator's human-gated action (Task 3)"
metrics:
  duration: ~6min
  completed: 2026-06-25
  tasks_completed: 2
  tasks_total: 3
---

# Phase 4 Plan 03: Cross-Source Synthesis Call + Report Migration Summary

The one Sonnet 4.6 synthesis call (`synthesizeReport`) plus its versioned no-verdict/no-originated-flag system prompt, the additive `004_report.sql` migration FILE (five `report_*` columns, no RLS), and the synthesis eval scaffolds (promptfoo config + LLM judges). **Paused at Task 3** — the live DB push is a blocking `checkpoint:human-action` the operator must run.

## What Was Built

### Task 1 — synthesis prompt + the one Sonnet call (commit `2533564`)

- **`src/lib/report/prompt.ts`** — `REPORT_SYNTHESIS_PROMPT_VERSION = "report-synth/v1 (2026-06-23)"` and `REPORT_SYNTHESIS_SYSTEM_PROMPT`. Hard-rule framing mirroring `brf/prompt.ts` ("ABSOLUT REGEL"): no köp/sälj-verdict / no värdering (D-04/FM2), never originate a flag — `prioritizedFlagIds` may only carry ids already in the fact sheet (D-03/FM3), every claim cites a real `sourceRef` (D-06), honest `ej_tillgänglig` on missing sources (D-07/FM4), open with a cross-source lead synthesis (D-05). Includes a GOOD (cross-source, cited, no verdict) and a BAD (buy recommendation + generic filler) inline few-shot.
- **`src/lib/report/synthesize.ts`** — module-scope `const client = new Anthropic()`, `const MODEL = "claude-sonnet-4-6"` (bare id). `synthesizeReport(input): Promise<SynthesizeResult>` makes one `client.messages.parse` call with `max_tokens: 4096`, `temperature: 0.4`, `system: REPORT_SYNTHESIS_SYSTEM_PROMPT`, the fact block carrying `cache_control: ephemeral`, the terse instruction last, and `output_config: { format: zodOutputFormat(reportSchema) }`. `stop_reason` branched BEFORE `parsed_output`: refusal → `CLAUDE_REFUSAL` (no retry), max_tokens → retry once then `CLAUDE_MAX_TOKENS`, empty → `CLAUDE_PARSE_EMPTY`. Catch logs ONLY `{ analysisId, code }`, rethrows `new Error(code, { cause })`. usage → `ClaudeUsage` via `toClaudeUsage`.
- **`evals/report.test.ts`** (extended) — six stop-reason fixtures (clean end_turn, refusal-no-retry, max_tokens×2 → coded after exactly one retry, max_tokens-then-clean, empty parse, unknown→CLAUDE_CALL_FAILED with cause) and two log-redaction assertions proving a sensitive fact sheet (financials + secret marker) never reaches a `console.error` line while `{ analysisId, code }` does. SDK mocked via a `globalThis`-hung `vi.fn()` — runs with no key, no spend.

### Task 2 — migration file + eval scaffolds (commit `b537d27`)

- **`supabase/migrations/004_report.sql`** — five idempotent `alter table public.analyses add column if not exists`: `report_data jsonb`, `report_status text`, `report_cost_sek numeric`, `report_data_fingerprint text`, `report_prompt_version text`. Leading comment mirrors 003: existing SELECT (001) + UPDATE (002) RLS cover the new columns; NO new policy declared (re-declaring errors). **FILE only — not pushed.**
- **`evals/report-promptfooconfig.yaml`** — prompt-regression scaffold pointing at `src/lib/report/prompt.ts:REPORT_SYNTHESIS_SYSTEM_PROMPT` over a Sonnet 4.6 provider; no-verdict / generic-filler / synthesis-quality test rows (cost-gated, not in CI).
- **`evals/report-judge.ts`** — three LLM-judge prompt templates (`JUDGE_NO_VERDICT_PROMPT`, `JUDGE_GENERIC_FILLER_PROMPT`, `JUDGE_SYNTHESIS_QUALITY_PROMPT`) + `REPORT_JUDGES` map and a `JudgeVerdict` JSON contract, on the Haiku judge tier (AI-SPEC §5).

## Verification

- `npx vitest run evals/report.test.ts` → **17 passed** (cost/fact-sheet from 04-01 + the new stop-reason/log-redaction blocks).
- `npx vitest run` (full suite) → **148 passed, 1 skipped, 6 todo** — no regression.
- `npx tsc --noEmit` → **exit 0**.
- `004_report.sql`: five `add column if not exists report_*` (grep == 5), zero `create policy`/`enable row level security` (grep == 0).
- synthesize.ts: `claude-sonnet-4-6` bare id (grep == 1), zero date-suffixed ids; uses `output_config.format` (no top-level `output_format` key — both `output_format` hits are in comments); factSheet never in a `console.*` line (redaction test asserts it).

## Deviations from Plan

None — Tasks 1–2 executed as written. One implementation note: the stop-reason/log-redaction tests mock `@anthropic-ai/sdk`; because `vi.mock` is hoisted above the module body, the mock `vi.fn()` is created inside the factory and hung off `globalThis` (a top-level `const` would be in its temporal dead zone when the mocked `new Anthropic()` runs at synthesize.ts load). This is a test-harness mechanism only — no production code affected.

## Checkpoint — Task 3 (BLOCKING, human-action)

Task 3 is the human-gated live DB push of `004_report.sql`. It was NOT auto-run: a `checkpoint:human-action` cannot be automated, and the live migration follows the Phase 2/3 operator-review precedent. The plan pauses here; the operator applies the migration and resumes. The exact push steps and resume signal are returned to the orchestrator.

## Known Stubs

- `evals/report-promptfooconfig.yaml` and `evals/report-judge.ts` are intentional eval **scaffolds** (per the plan): the promptfoo test rows return `true` placeholders and the judge prompts are templates. They are wired against `evals/report-fixtures/labels.json` by the nightly flywheel (AI-SPEC §6), not in per-PR CI. This is by-design and explicitly in the plan's `<done>` for Task 2 — not blocking the plan goal.

## Self-Check: PASSED

- FOUND: src/lib/report/prompt.ts
- FOUND: src/lib/report/synthesize.ts
- FOUND: supabase/migrations/004_report.sql
- FOUND: evals/report-promptfooconfig.yaml
- FOUND: evals/report-judge.ts
- FOUND commit: 2533564 (Task 1)
- FOUND commit: b537d27 (Task 2)
