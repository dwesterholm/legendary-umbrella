---
title: "Search scoping — allow multiple areas, and compose free text WITH the filters instead of letting Haiku own the scope"
status: pending
priority: P1
source: "captured 2026-08-11 — operator: 'I couldn't choose multiple areas in Stockholm, only one at a time in the filters'"
created: 2026-08-11
theme: ux
area: fullstack
---

## Goal

Make area scope something the user can state precisely and verify before spending, instead of something inferred from prose by a model.

## Two concrete gaps

**1. One area at a time.** `areaQuery` in `src/lib/discovery/filter-schema.ts:14` is a single string, and the filter UI exposes a single area control. But `runSlice` already scrapes a plural `areaIds` concurrently via `Promise.allSettled` (`job.ts:217`) — the execution layer has supported multi-area since Phase 13's D-01 parallelization. **The constraint is purely at input.** Widening the schema to a list and the UI to multi-select is mostly plumbing, not new capability.

**2. Free text REPLACES the filters rather than composing with them.** `start-discovery.ts:89-95` lets an explicit `areaQuery` override the Haiku-inferred one, but that is a single override, not composition. There is no way to say "these three areas, and *also* interpret this prose for the rest" — which is exactly what the operator wanted and what would have prevented the todo-005 incident.

## What the operator asked for

> "the search filters need to be much stricter, probably by providing more filters so that the free text search is incorporated WITH the filtered areas"

That is the right shape. Free text should fill in intent that filters cannot express (condition, renovation potential, character), while **structured filters own the hard constraints** — area, size, price. Hard constraints should never be inferred when the user has stated them.

## Scope sketch

- `areaQuery: string` → a list of resolved areas, with the UI as multi-select over known/resolvable areas rather than free typing.
- Show the resolved areas back to the user **before** the job spends, so a mis-scope is caught by eye rather than by invoice. This alone would have caught the todo-005 incident.
- Define precedence explicitly: structured filters win over anything Haiku infers, for every field where both exist — not just `areaQuery`.
- Consider preset groupings for the umbrella terms people actually type ("innerstan", "innanför tullarna") that expand to their constituent stadsdelar as a multi-select — turning the todo-005 failure case into a first-class, checkable selection.

## Sequencing

Todo 005's fail-fast guard should land **first** — it bounds the cost of every miss. This one then removes most of the reasons to miss in the first place, and gives users a reliable manual path when free text still can't parse their intent.
