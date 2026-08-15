---
title: "Replace the keepalive ping with a service-role write (restore itself is DONE)"
status: partially_done
updated: 2026-08-11
progress: "Part 1 (restore) DONE — operator restored the project; verified live 2026-08-11, area_cache HTTP 200 in 0.14s. Part 2 (keepalive fix) still OUTSTANDING, so it can pause again."
priority: P1
source: "captured 2026-07-27 during Phase 14 planning (Supabase pause email)"
created: 2026-07-27
theme: infrastructure
area: infra
---

## Goal

Two linked jobs:

1. **Restore** the paused Supabase project `nsheegvczxjeeayngqrv` (Bostad AI) — manual action, dashboard only.
2. **Replace** the keepalive Action's ping so this cannot recur: swap the anon-role RLS-empty *read* for a genuine tiny *write*, on a daily cadence.

## Context

Confirmed paused 2026-07-27 (by then possibly fully shut down — free-tier projects are eventually deleted after prolonged pause, so treat #1 as time-sensitive).

**The keepalive GitHub Action is NOT the failure — do not "set it up again".** It is `active` and had succeeded every 3 days without a gap, last green run 2026-07-25 (HTTP 200, 8s, against the correct project ref). Verified via `gh run list --workflow=supabase-keepalive.yml`.

**Why it still paused (root-cause hypothesis):** `.github/workflows/supabase-keepalive.yml` pings
`GET /rest/v1/analyses?select=id&limit=1` with the **anon** key. RLS returns an empty array, so the request 200s and the workflow reports success — but an RLS-empty read may not register as the DB activity Supabase's pause timer keys off. The workflow's own comment already concedes it "does NOT un-pause an already-paused project."

**Two important properties:**
- No ping of any kind can un-pause a paused project — restoring is manual in the dashboard.
- Cron is every 3 days (`0 6 */3 * *`); GitHub cron is best-effort, so a delayed run plus a 7-day window leaves less margin than it appears.

## Acceptance Criteria

- [ ] Supabase project `nsheegvczxjeeayngqrv` is **restored and reachable** — verify with a live ping returning HTTP 200 (`/rest/v1/analyses?select=id&limit=1`)
- [ ] A dedicated keepalive table exists (e.g. `public.keepalive` with `id` + `pinged_at timestamptz`), added via a **new numbered migration** — never by editing an already-pushed one (memory `supabase-migration-already-applied`)
- [ ] `.github/workflows/supabase-keepalive.yml` performs a **write** (upsert/update of `pinged_at`) using a **service-role** key stored as a repo secret (`SUPABASE_SERVICE_ROLE_KEY`), not the anon key
- [ ] Cron changed to **daily** (`0 6 * * *`) so a skipped or delayed run never approaches the 7-day window
- [ ] The workflow **fails loudly** if the write does not land — assert the returned/updated `pinged_at` actually advanced, not merely that the HTTP status was 2xx (this is the exact false-green that hid the current problem)
- [ ] Keep the existing `isValidOrgNr`-style fail-closed posture: a missing secret still `::error::`s and exits non-zero
- [ ] Stale comment corrected — the file's header still describes the anon-read design and claims the ping "resets that inactivity timer"
- [ ] After the fix, one manual `workflow_dispatch` run is green **and** `pinged_at` is observably newer in the DB

## Notes / gotchas

- Service-role key is **secret and RLS-bypassing** — repo secret only, never inlined (the current file inlines the project URL, which is fine; the anon key is already a secret purely to dodge push protection).
- Consider whether Supabase Pro (no auto-pause) is cheaper than the ongoing maintenance of this workaround — the workflow header itself flags it as a temporary dev-phase measure.

## Blocks / relates to

- **Blocks** Phase 14 live verification (ANL-02/ANL-03): `resolveArea` reads the `area_cache` table, so the comps/BRF end-to-end smoke cannot run until the DB is back. Unit/mocked tests are unaffected — Phase 14 can be built and merged without this.
- **Blocks** Phase 13's still-open **DXUX-01** live gate. Both live gates want one combined session **from a non-Booli/Cloudflare-blocked IP** (the operator's local IP 403s on Booli detail pages), so pair this restore with that run.
- Memory: `supabase-project-paused`, `supabase-migration-already-applied`.
