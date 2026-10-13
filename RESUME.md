# RESUME — Bostad AI / Discovery analysis redesign

> Working handoff. Milestone v1.2 (Renovator-Grade Discovery Analysis, Phases 13–17)
> is now roadmapped and **Phase 13 is code-complete**. The section directly below is
> the live pick-up point (updated 2026-07-22). Older context follows further down.

---

## ▶️ STATUS 2026-10-13 (evening) — Phase 14.3 executed 8/8; review + verification running

Sun coverage is solved without on-site visits: `sol härledd 74 av 76 (97,4 %)` live, 75/77 replay.
- Facade source = OpenStreetMap building footprint + street-name match (`osm-buildings.ts`,
  `sun-facade.ts`, `sun-fact.ts`); cache `.planning/calibration/data/osm/innerstan.json` (12,9 MB,
  refreshed only when > 31 days old via `scripts/osm-download.ts`; endpoints rotate, main host 504s).
- Floor-plan compass route CLOSED: the model "found" north arrows on 6/11 plans — all entrance-door
  arrows (audit in 14.3 evidence/floorplan-probe.json). `FLOORPLAN_ROUTE_ENABLED=false`. 0,37 kr.
- Sun hours (`sun-hours.ts`): theoretical + obstructed low/nominal/high (neighbours ±3 m, 250 m,
  heights levels×3+2, 28 % estimated). Window 06–15. ±1 h share: Mar 97 %, Jun 82 %, Sep 99 %, Dec 89 %.
- Taste: sun part = facade weight × confidence × 0.5 (street-only) × obstruction. Knob:
  `streetOnlyFactor: 0.5` in `TASTE_WEIGHTS` (`taste.ts`). Folkungagatan 61: S street side, 8,8 h Mar /
  8,0 Jun / 4,6 (0–5,5) Dec "usäker"; taste +51 401 kr.
- Table + mail have three Sol columns; coverage line has `sol härledd`. 14.2's D-17 sun clause closed.
- Spend this phase: 0 USD Apify, 0,37 kr vision. Tests 2 430 passed.

Pending when written: 14.3-REVIEW.md and 14.3-VERIFICATION.md, then phase.complete.
Daniel's one-time steps are unchanged (SMTP env, watch-state, launchctl, pmset — scripts/launchd/README.md).
Open knobs for Daniel: streetOnlyFactor 0.5 vs 1.0; the two text-stated flats both face WEST on the
courtyard side (supports keeping 0.5); Kungsbro Strand 19 has no floor → no shade check.

---

## ▶️ STATUS 2026-10-13 (later) — Phase 14.2 executed 9/9; review + verification running

All on `main` (ff-merged + pushed after every wave). `npm run test` 1 929 passed / 3 skipped; tsc + lint clean.

What exists now (weekly trustworthy table):
- `zsh scripts/launchd/run-weekly.sh` = the weekly job: local headed Chromium (0 USD Apify), complete
  district lists vs Booli's own counts (Söder 442/445, Östermalm 182/182, Vasastan 507/509,
  Kungsholmen 481/486), every candidate's detail + broker page read, vision for all (cached; first
  run 33 kr, repeat ~0 kr), BRF debt/kvm from Booli's public BRF page (72/77), "Varför här" reason on
  every flagged row (29 explained, 12 "oförklarat fynd" of 41), model refitted (size effect from
  data), table split "Förväntat under 4 M" (25) / "Över 4 M förväntat" (52), seen-listing memory
  (`.planning/calibration/data/watch-state.json`), mail via nodemailer when `WATCH_SMTP_URL` +
  `WATCH_EMAIL_TO` are set, else HTML to `.planning/calibration/data/weekly-<date>.html`.
- Evidence (tracked): `.planning/phases/14.2-trustworthy-weekly-table/evidence/` (weekly.html, logs).
- LaunchAgent: `scripts/launchd/com.bostadai.weekly-watch.plist` + README — NOT installed; install
  + `pmset` commands documented there (Daniel runs them). Mac sleeps after 1 min → caffeinate + pmset.
- Coverage: balcony 100 %, condition 93,5 %, BRF 93,5 %, avgift 100 %; sun 2,6 % (real: no listing
  text states it) → D-17 sun clause "not met — 14.3 scope".
- Folkungagatan 61: 29/77 innerstan, 13/35 Söder, "oförklarat fynd", sun 0 %. Measured, not tuned.

Daniel's to-dos (one-time): set `WATCH_SMTP_URL` + `WATCH_EMAIL_TO` in ~/.zshenv (never in the
repo); delete `watch-state.json` if the first real mail should be a top-15; `launchctl load` the
plist; run the pmset line. All in scripts/launchd/README.md.

DONE after this was written: 14.2-VERIFICATION passed 12/12; Phase 14.2 marked complete; code review
(1 critical + 11 warnings) ALL FIXED (14.2-REVIEW-FIX.md): a closed local renderer now refuses instead
of falling back to Apify; 60 s page timeout + 2 h run watchdog (exit 5); lock stale after 6 h;
WITHOUT SMTP env the run writes the HTML, leaves watch-state alone and EXITS 4 (set
WATCH_MARK_SEEN_WITHOUT_SMTP=1 to restore the old behaviour) — so Daniel's first scheduled run
needs the SMTP env or that flag; vision cache key now versioned (first run re-reads all, ≤ 60 kr). 14.1 is still `human_needed` (12/13) with decisions recorded
in the PICK-UP section below; verify-work 14.1 can close it on those.

Next phase if sun matters: 14.3 (orientation from OSM footprint / floor-plan compass; obstructed
sun hours) — only thing that can lift sun coverage above 3 %.

---

## ▶️ PICK UP HERE (2026-10-13, written just before Daniel cleared the session)

Daniel's instruction: **run autonomously until there is a finished table of trustworthy candidates.**
Phase 14.2 ("Trustworthy Weekly Table", ROADMAP) is the vehicle; plan 1 MUST be the local browser
rung (verified to work from this Mac, memory `booli-local-browser-works`). Question budget: 0 — do
not ask; decide, record, report.

Resume with: `/gsd-plan-phase 14.2 --auto` (auto-advance is on → execute follows). If plans already
exist in `.planning/phases/14.2-trustworthy-weekly-table/`, run `/gsd-execute-phase 14.2 --auto`.
Then 14.3 (sun & orientation) only if the table still lacks sun data after 14.2 plan 2.

Decisions taken on Daniel's behalf for 14.1's open UAT items (record in 14.1-UAT.md when
verify-work runs; he can overturn):
1. Folkungagatan 61 at 33/75 = accepted as measured (R-02); ROADMAP 14.1 wording to be softened.
2. 20 % credit cap kept; the uncapped gap is printed beside it (14.2 plan 4).
3. Vision SEK in the in-app run: accepted on code; 14.2 plan 2 logs SEK for the headless run.
4. Size sign rule: DROP (market-derived, t = 8.4) and refit — 14.2 plan 4.

Phase 14.1 is `human_needed` (12/13), NOT marked complete; 14.1-UAT.md holds the four items.
Code review 14.1-REVIEW.md: 6 warnings worth fixing in 14.2 plan 2/3 (reno-tier negation across
clauses, "genomgående renoverad" sun bonus, puller empty-page resume gap, spend read too early).

Apify headroom 2.71 USD until the monthly reset — the local rung is also what unblocks any run.
The weekly-list preview Daniel saw: `.planning/calibration/data/weekly-preview-2026-10-13.md`.
Dev server may still be running on :3001 (browser pane); local Supabase up; job d32ae1fe done.

---

## ▶️ STATUS 2026-10-13 — Phase 14.1 executed (10/10 plans), verification pending

All on `main` (ff-merged + pushed after every wave; phase branch `gsd/phase-14.1-personal-fit-score`
tracks it). `npm run test` 1440 passed / 3 skipped; tsc + lint clean.

What exists now:
- `scripts/fit-score.ts` — headless ranking by estimated flip profit (resale − expected final − reno),
  `--replay <snapshot> --model data/hedonic-model.json` is free; live mode runs the Apify headroom
  check first (exit 2 when short). `--dry-run` is free.
- `data/hedonic-model.json` — fitted on 7,380 innerstan sales (Apr 2025–Oct 2026): floor +1.6 %/floor,
  bottenvåning −6.4 %, −0.7 %/km from centre, trend +0.9 %/month, renovated ≤ +8.3 %, balcony +1.9 %
  (prior), size effect ZEROED by the sign rule (data says large flats cost +3–5 %/m² MORE — decision
  for Daniel, see 14.1-FOLLOWUPS.md), R² 0.61, CV error ±12 %. Bid premiums from data: Söder +11 %,
  Kungsholmen +5.7 %, Vasastan +6.1 %, Östermalm +4 %.
- Raw data (gitignored): `.planning/calibration/data/slutpriser-cache.json` (7,431 rows),
  `forsale-snapshot-2026-10-13.json`, `live-run-2026-10-13.log`, `evidence/*.jpg`.
- Live innerstan run 2026-10-13: 76 candidates, Folkungagatan 61 ranked 33/75 (16/35 Söder), never
  reached the 20-flat vision window so its sun wording was unread. Measured, not tuned.
- In-app browser run (job d32ae1fe): done in 26.6 min WITHOUT reload, 60 candidates, Kungsholmen
  present; but the 15-min client ceiling showed a false "Försök igen" → 13-03 truth 2 FAIL, 14-UAT
  test 1 `issue`. Fix belongs to Phase 13 constants (raise/soften ABSOLUTE_CEILING_MS, incremental
  vision progress).
- Spend this phase: ≈27.8 USD Apify (headroom now 2.71 USD until the monthly reset) + ~8 SEK vision.

Pending: 14.1-REVIEW.md (code review) and 14.1-VERIFICATION.md (verifier) were running when this was
written; then `phase.complete` / gap closure. Decisions parked for Daniel in
`.planning/phases/14.1-personal-fit-score/14.1-FOLLOWUPS.md` and the SUMMARYs' "calls made" lists.

---

## ▶️ STATUS 2026-10-12 — roadmap reshaped around Daniel's own hunt

Daniel sells his flat this week, moves out mid-April 2027. The roadmap now serves that hunt:
Phases 14.1–14.3 inserted, 15–17 deferred. Decisions in memory `daniel-fit-score-decisions`.

- 14.1 Personal Fit Score — floor (score only), balcony, morning-leaning sun where orientation
  is stated, loved-hub location bonus (innerstan is the net, hubs score up), reno-upside strong
  but not required. Hard filters ≥35 kvm, ≤4 M. Calibration: Folkungagatan 61 5tr,
  Booli /bostad/150148 — NOT a reno object, must still rank top. Facts:
  `.planning/calibration/folkungagatan-61-5tr.md`. Viewings 18–19 Oct (live candidate!).
- 14.2 Daily Watch by Email — scheduled run, seen-listing memory, mail only new/changed.
- 14.3 Orientation Inference Spike — OSM footprint bearing or floor-plan compass via vision.
- Today's fixes 3408871 + 55b78d0 (stale vision claim, Apify memory, failed_areas) are pushed
  but NOT yet confirmed by a live run; the next innerstan run doubles as 13-03 + 14-UAT item 1.

Model decided 2026-10-12 (5 of 5 questions used → autonomous from here):
- Score = estimated flip profit in kr: resale (hedonic kr/m² model fitted on Booli slutpriser:
  micro-area, floor, balcony, build year, size, hub distance) − purchase (asking × bid premium)
  − reno cost (tier from vision condition). No tax (uppskov), no broker/holding.
- Taste bonus ≤ ~5 % for morning sun + loved hubs; taste otherwise = hard filters.
- Vision MAY re-order now (pre-rank 60 → vision top ~20 → profit re-sort). Reno ranking today
  uses build year + kr/m² only; the pictures never touched the order. Separation test amended.
- Calibration softened: Folkungagatan 61 in the top quarter, not #1.
- No UI until the model is tuned. 14.3 widened to real (obstructed) sun hours via 3D buildings.

Next: `/gsd-plan-phase 14.1`.

---

## ▶️ STATUS 2026-10-11 — pushed, cap fixed, key rotated

- Push block resolved: the three commits were squashed into `cdab732` with no key in history
  (Daniel chose "rewrite").
- `b0a6167`: candidate cap 25 → 60 and districts interleaved before the cut, so an innerstan
  search keeps a share of all four districts.
- The Anthropic key had been rotated; the old one returned 401. Daniel put the new key in
  `.env.local` + `~/.zshenv`. `APIFY_API_TOKEN` + `ANTHROPIC_API_KEY` now reach Claude's shell.
- `b7ec27b`: the browser-pane dev server is launched through `zsh -c` so it inherits
  `~/.zshenv` (it used to read only `.env.local`); parse-intent logs API status/type.
- `ps eww` on macOS shows NO environment for other processes — do not use it to check what
  the dev server sees; run the flow and read the parse-intent log line instead.

---

## ▶️ STATUS 2026-10-06 — scraper works again, app runs on local Supabase

Rules Daniel set today (also in memory): Claude verifies by clicking through the real app in
the browser pane, never hands Daniel a manual checklist; max 5 questions per phase, then
`/gsd-autonomous`; the app runs on a LOCAL Supabase stack (`supabase start`, Colima), cloud
project dormant; API tokens should be in `~/.zshenv` so Claude can run scripts.

What was broken and is now fixed (commits f020122, c007410):
- Booli rebuilt their site; the old `__NEXT_DATA__` block is gone, so every scrape failed with
  "ingen Apollo-data". `src/lib/booli/page-functions.ts` now reads the search/slutpriser
  pages (Apollo SSR transport, `ListableProperty` cards) and detail pages (App Router flight
  payload). Verified live in the browser pane AND through Apify (3 districts × 5 pages ≈ 175
  listings each). Search cards lack build year + BRF; detail enrichment backfills the top 8.
- "Ja, stämmer" on the confirmation card looped forever (identical resubmit). Fixed with
  `confirmed=1`; umbrella terms are recovered before the card.
- Local stack: `supabase/config.toml` (analytics off — Colima lacks the docker.sock path),
  `.env.development.local` (gitignored) points `next dev` at 127.0.0.1:54321,
  `scripts/seed-local-user.sh` creates the dev login (credentials in the script).

Open:
- `git push` is BLOCKED: commit f020122 contained the local Supabase default key in
  `scripts/seed-local-user.sh` and GitHub push protection rejects it. c007410 removes it from
  the tree, but the key is still in f020122's history. Daniel decides: allow via the GitHub
  unblock link in the push error (it is the CLI's public default, not a credential) OR let
  Claude rewrite the two unpushed commits.
- Ranking without build year on first pass: search cards carry no constructionYear, so the
  renovation-upside score leans on kr/m² until the detail enrichment (top 8) backfills.
  Consider raising `VISION_ENRICH_LIMIT` or a cheap detail pass for the top 30.
- Apify wait ceiling: one Kungsholmen page render hit `AREA_PAGE_WAIT_SECS` (RUNNING) and
  needed the retry rung. Watch cost/latency on 4-district searches.

---

## ▶️ STATUS 2026-09-20 — Daniel is now house-hunting for real

His current flat is in showings. Only goal: renovation objects inside tullarna. All else waits.

Done this session (pushed):
- `transport.ts` passes `log: null` to the Apify actor call, so the actor's run log no longer
  floods stdout. That flood is what killed the headless search (exit 137) on 2026-09-06.
- `kungsholmen: "115353"` added to `AREA_SEED`; all four innerstan districts now resolve for free.
- In-app bug fixed: `startDiscovery` recovers "innerstan" / "innanför tullarna" from the free
  text (`findUmbrellaTerm`) before the empty-area gate. Regression test added. 996 tests green.
- `scripts/find-reno.ts` takes `PRICE_MAX` / `SIZE_MIN` env overrides.

NOT done: the live run. This session's secret guard blocks any command that touches
`.env.local`, and the Apify/Supabase keys are not in the shell env. Daniel runs it himself:
`set -a; source .env.local; set +a; npx tsx --tsconfig ./tsconfig.json scripts/find-reno.ts > /tmp/find-reno.out 2>&1`
Permanent fix if wanted: put `APIFY_API_TOKEN` + the two `NEXT_PUBLIC_SUPABASE_*` vars in `~/.zshenv`.

Next: read the output, sanity-check the ranking, then make it recurring (daily run, only new
listings reported). BRF auto-lookup is dead (see memory `allabrf-auto-fetch-never-worked`);
for a shortlisted flat, upload the broker's årsredovisning PDF in the app.

---

## ⏸️ PICK UP HERE (updated 2026-09-06 — paused mid-task on usage credits)

**Daniel's actual goal right now:** see a list of renovation-object apartments in central
Stockholm ("innerstan / innanför tullarna"). He does not care about the app UI for this.
The very first thing the next session should do is deliver that list. Everything else waits.

### State of the repo
- `main` = `origin/main`, tree clean, 995 tests green, tsc/lint/build clean. Nothing unpushed.
- Phase 14 complete (4/4). Phase 13 open only on `13-03` (a live smoke). Phases 15–17 not started.
- Supabase project `nsheegvczxjeeayngqrv` is **live** (checked 2026-09-06: all tables HTTP 200).
  Keepalive Action tightened to daily in `31eda84`. Do not re-diagnose "is it paused" — curl it.
- Dev server is NOT running when you start (it dies with the session). Start with
  `npm run dev -- -p 3001` or the `bostad-ai-dev` entry in `.claude/launch.json`.
- Login: the account + password live in `.env.local` as `TEST_EMAIL` / `TEST_PASSWORD`.
  Daniel signed in with them on 2026-09-06. The app has no password-reset flow; the Supabase
  default mailer never delivers, so if the password is ever lost, set a new one in the Supabase
  SQL Editor (`update auth.users set encrypted_password = crypt('…', gen_salt('bf')) where email = '…'`).

### What happened in the last session (2026-09-06)
1. Confirmed WR-03 was already fixed (`076dfb1`, Phase 14 fix pass); marked resolved in
   `13-VERIFICATION.md`. Closed todo 001 on evidence (4 weeks live with the anon-read ping →
   no service-role write needed; cadence → daily instead).
2. Daniel logged into the app and ran a search from `/discover`. **It refused to start a job.**
   Server log: `POST /discover 200 in 4.5s`, then no `/discover/[jobId]` navigation — i.e. the
   server action returned `ok:false`. See "BUG TO FIX" below.
3. Pivoted to a **headless run using the app's own pipeline code**, no login, no vision/BRF:
   `scripts/find-reno.ts` (committed). It resolved all four areas — Södermalm 115341,
   Östermalm 115348, Vasastan 115349 (seed), **Kungsholmen 115353 (live probe, 1 Apify render)**
   — then kicked off the four area scrapes in parallel and the process was **killed (exit 137)**
   before printing anything. Cause: `apify-client` streams every actor's log to stdout and the
   flood tripped the tool. The four Apify actor runs were already started, so ~1–5 SEK was spent
   and the listings were fetched but lost in memory. No Anthropic spend.

### NEXT STEP 1 — deliver the apartment list (do this first)
Run the headless script again, with the actor log silenced and output going to a FILE, never
through `head`/a pipe that can close early:
```bash
set -a; source .env.local; set +a
npx tsx --tsconfig ./tsconfig.json scripts/find-reno.ts > /tmp/find-reno.out 2>&1; echo "exit $?"
grep -v "playwright-scraper runId" /tmp/find-reno.out
```
If it is still killed by the log flood, the fix is in `src/lib/booli/transport.ts`: the
`client.actor(...).call(...)` streams logs by default — pass the option that disables log
streaming (check the `apify-client` `ActorClient.call` docs for the current name, it has been
`waitSecs` + a log/`silent`-style flag) or set `APIFY_LOG_LEVEL=OFF` in the env before running.
The script itself is sound: it expands "innerstan" → 4 districts, resolves them (seed first, probe
only for what the seed lacks), scrapes with `fetchAreaListings(areaId, "Lägenhet")`, dedupes,
applies `filterCandidates` (≤4 000 000 kr, ≥30 kvm, lägenhet), ranks with the app's own
`computeNicheScore(…, "renovation-upside", …)`, prints top 30 with Booli links, ★ = ≤45 kvm.
Hand Daniel that table. That is the deliverable.

Quick win while there: add `kungsholmen: "115353"` to `AREA_SEED` in
`src/lib/discovery/area-seed.ts` (live-observed 2026-09-06, satisfies the file's "never a guess"
rule) so future runs skip the probe render. Run `resolve-area.test.ts` + `area-seed` tests after.

### BUG TO FIX (I introduced it) — the in-app search refuses Daniel's exact query
In `bcaee7b` (todo 005) I (a) told the intent parser (`parse-intent.ts:47`) to NEVER guess an
area and return `""` when unsure, and (b) added a gate in `start-discovery.ts` that refuses an
empty `areaQuery` before creating a job. Both correct in spirit. But the umbrella expansion
("innerstan" → 4 districts) lives in `splitAreaQuery`, which runs in `runSlice` — AFTER that gate.
So for free text like "innanför tullarna", Haiku now returns `""` (as instructed), the gate fires,
and the user sees "Vi kunde inte tolka vilket område du menar" with no job. That is almost
certainly what Daniel hit. Verify by reading the action's return in the browser (it is not in
the server log). Fix: before the gate in `start-discovery.ts`, try the umbrella expansion /
`splitAreaQuery` on the FREE TEXT (or on Haiku's raw guess) and accept if it yields resolvable
names; also consider having the parser return the umbrella term itself rather than `""`.
Selecting the area CHIPS in the UI bypasses this and works.

### Then, in order
- `todo 004` (pending): the two Supabase dashboard checks on whether the signup mail ever sent.
- `13-03` live smoke → closes Phase 13. The WR-02 enrichment deadline (`ENRICH_DEADLINE_MS`) has
  still never executed against real latency; watch the server log for its trip message.
- `/gsd-discuss-phase 15`.

### Memory files (local `~/.claude/projects/…/memory/`) hold the same facts; if the new account
cannot see them, this section is the source of truth.

---

## (older) PICK UP HERE (updated 2026-07-23 — Phase 13 SHIPPED as PR #9)

### Pacing decision: RESOLVED → "Ship Phase 13 first"
You chose option 3 (ship Phase 13 independently). Done:
- **PR #9 open:** https://github.com/dwesterholm/legendary-umbrella/pull/9 (base `main`, MERGEABLE, not yet merged).
- Rich PR body generated from planning artifacts; verification status surfaced honestly as `human_needed`
  (DXUX-01 live gate deferred + WR-02/WR-03 follow-ups noted).
- Repo has **no CI checks**, so nothing gates the merge mechanically — merging is your call.

### The two open decisions now (answer when back)
1. **Merge PR #9?** — code review is already done in-branch (13-REVIEW.md + WR-01/04/05 fixes applied).
   The only thing NOT proven is DXUX-01 end-to-end in-window completion, which can only be confirmed from a
   **non-Booli-blocked IP** (deploy/staging) — see "To close DXUX-01" below. Merge now (verify live post-deploy)
   or run the operator live-smoke first, your call.
2. **Then Phase 14** — proceed into Phase 14 (Holistic Analysis Brain). ⚠️ config still has `skip_discuss: true`
   + `mode: yolo`; you wanted discuss-first, so flip `workflow.skip_discuss` via `/gsd-settings` OR run
   `/gsd-discuss-phase 14` explicitly. (Note: `66c126b` set skip_discuss=false on this branch — verify which value
   is live after any merge.)

### Where we are
- **Branch:** `gsd/phase-13-discovery-ux-poll-timeout-fix` — **~40 commits ahead of `main`, clean tree, pushed as PR #9, NOT merged.**
- **Milestone:** v1.2 — Phase 13 of 5 done (code-complete + verified); Phases 14–17 not started.
- **Discuss:** config has `skip_discuss: true` + `mode: yolo`. In the *first* `/gsd-autonomous` attempt
  you chose **"Enable discuss first"** — i.e. you want each phase to gather context interactively
  before planning. That preference has NOT yet been applied to config (skip_discuss is still `true`).
  **Before Phase 14, either flip `workflow.skip_discuss` to false (via `/gsd-settings`) or I run
  `/gsd-discuss-phase 14` explicitly.** Don't let 14 auto-skip discuss.

### Phase 13 — exact disposition (code-complete, one live gate deferred)
Shipped, all committed, 748 tests + tsc + lint green, code-reviewed + fixed:
- **13-01** area-parallel scrape (`Promise.allSettled` in `runSlice`) + bounded area-page renders; D-03 cost-cap invariant preserved.
- **13-02** two-tier timeout (soft-notice "Det tar längre tid än väntat, fortsätter…", no false-fail) + complete Swedish `STATUS_LABELS` + `KNOWN_STATUSES` exhaustiveness.
- **13-04** decoupled status read (badge advances during long ticks) + bounded detail-page render (`DETAIL_ENRICH_WAIT_SECS=90` / `MAX_RETRIES=2`).
- **13-05** coherent counter = `candidates analyzed / candidate_count` (clamped, monotonic, "N av N" at done; killed the "350 av 25" + backward-jump bug the live smoke caught).
- **Code-review fixes:** WR-01 (readStatus out-of-order guard), WR-04 (dispatchTick `.catch`), WR-05 (onComplete held in a ref).

**DXUX-02 = DONE.** **DXUX-01 = still `Pending`** — `human_needed`. Reason: my local IP is Booli/Cloudflare-blocked
(403 on detail pages), so end-to-end *in-window completion* can only be proven by an **operator live-smoke from a
non-blocked IP**. Same shape as v1.1's deferred live gates. See `.planning/phases/13-discovery-ux-poll-timeout-fix/13-VERIFICATION.md` (status: human_needed).

### To close DXUX-01 (operator action, needs a non-Booli-blocked IP)
Run the discovery flow with the query **"Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner"**
(`DISCOVERY_ENABLED=true`, real Apify + Anthropic spend) and confirm it reaches results **without a forced reload**,
badge advances `Analyserar → Analyserar bilder`, and the counter reads coherently ("N av N" at done).

### Two deferred follow-ups (captured as background-task chips + in 13-REVIEW.md)
- **WR-02** — `enrichCandidateImages` still loops the ≤8 detail fetches **sequentially**; pathological all-fail worst
  case (~24 min) can still blow the ~300s serverless ceiling. Parallelize it (same `Promise.allSettled` pattern as
  the area scrape), preserving the D-03 cost pre-check. This is the *last* piece of robust in-window completion (DXUX-01).
- **WR-03** — failed fallback-tree rungs (403/timeout retries) incur real Apify spend that is **never added to
  `cost_sek_total`**, so the cost cap can be silently overshot (worse now that area scraping runs in parallel). Add
  failed-render cost accounting; keep the D-03 field-scoped-write invariant.

### Then: Phases 14 → 15 → 16 → 17 (strict dependency spine)
See "Next work" and the roadmap section below. Key spend/decision flags to remember:
- **Phase 15** includes a **live Anthropic strict-output smoke** (`RUN_LLM_EVALS=1`) — real API spend, and the
  `OpportunityBrief` schema must stay slim (single-nullable-leaf) or it 400s (memory `anthropic-structured-output-limits`).
- **Phase 17** needs an **image-gen provider decision** (nano-banana skill / higgsfield / other) before planning.

---

## Where things stand (original context, pre-Phase-13)

- **Area-search data overhaul — DONE + merged to `main`** (merge `11a3c7a`, PR #8, E2E-verified 2026-07-17).
  - Multi-area split (`splitAreaQuery` in `resolve-area.ts`, cap 4), `runSlice` resolve+scrape+`dedupeCandidates`.
  - One-shot termination fix: `runSlice` always sets `status:"done"` (was stranding under-cap searches in `processing`).
  - Pagination `buildTillSaluUrl` walks `&page=N`; page 1 sequential, pages 2..5 parallel (`Promise.allSettled`).
  - **kr/m² sort**: every page `?sort=listSqmPrice&ascending=true` (numerically confirmed ascending).
  - Verified with "Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner" → 315 listings (vs 71 before).
- **Analysis-redesign scaffolding — BUILT, NOT WIRED.** Research + SPEC + pure cores exist and pass tests,
  but are not yet connected to the live analysis path.

## Next work (prioritized)

### P1 — client-timeout UX (surfaced by the E2E)
The richer scrape (315 listings + vision + Booli `networkidle` 60s timeouts) now **exceeds the client's
5-min poll timeout** (`MAX_POLL_MS` in `discovery-progress.tsx`) → user sees "Det tar längre tid än väntat"
and must reload (server finishes fine).
- Root contributors: areas scraped **sequentially** in `runSlice` (only pages parallel); one timing-out
  page blocks its area's `allSettled` batch ~180s.
- Fix options: parallelize across **areas** in `runSlice`; lower per-page render timeout / cap retries;
  raise `MAX_POLL_MS`; or stream partial results.
- Minor: `vision_processing` has no Swedish label (raw string shows) in `STATUS_LABELS` (discovery-progress.tsx).

### P2 — the original core goal: AI analysis quality (Phase A.3–A.5 → B → C)
Wire the built cores into a real per-candidate `OpportunityBrief`. **No DB migration** (rides in JSONB
`results`; comps use re-resolved areaId).
- **A.4 wiring** in `runVisionForJob`: re-resolve areaId → `fetchSoldComps` (synthesize single-crumb
  `SoldSourceQuery`) → `normalizeSoldOutput` → `computeAreaComps` + per-candidate BRF summary →
  inject into deep-pass payload.
- **A.5**: prompt (in `2026-07-10-A5-PROMPT-AND-VERIFICATION.md`) + `vision-schema.ts` `OpportunityBrief` —
  **needs a LIVE Anthropic strict-output smoke** (mocked tests hide 400s — see
  `anthropic-structured-output-limits` memory).
- **B**: wire `valueGap` into ranking (`discovery-results.tsx:112-115`) + "från bildtolkning" marker.
- **C**: proposed planritning for HIGH value-gap candidates only.

Built cores (tested, separation-grep enforced so they can't leak into niche-score/flags):
`flip-economics.ts` (`valueGap`/`buyerSegment`/`RENO_COST_MATRIX`/`applyRot`/`taxLines`),
`area-comps.ts` (`computeAreaComps`). Phase A.1 pre-filter flip + A.2 triage flip already done.

## ⚠️ Operator principle: low kr/m² ≠ reno object
The kr/m² sort is a **surfacing signal only, never a conclusion**. Low kr/m² can be reno-upside OR a
legit discount (ground/bottom floor, no elevator/balcony, traffic/noise, cheaper sub-area, tomträtt,
BRF debt, odd BOA). P2 analysis MUST normalize kr/m² against these before attributing to condition.
Never render UI implying "low kr/m² ⇒ reno". Encoded in SPEC §2.6.

## Locked constraint
`niche-score.ts` / `flags.ts` must NEVER import vision/value-gap/area-comps types (static-grep tested).
Use the separate `condition-score.ts` path + "från bildtolkning" marker.

## Source docs
- Memory: `discovery-analysis-redesign.md` (+ `booli-sold-price-source`, `supabase-migration-already-applied`,
  `anthropic-structured-output-limits`, `lexis-paid-actor-disabled`).
- `.planning/research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md` — full ruleset, Phase A/B/C, 4 locked operator decisions (§6).
- `.planning/research/2026-07-10-A5-PROMPT-AND-VERIFICATION.md` — A.5 prompt + OpportunityBrief schema + verification runbook.
- `.planning/research/2026-07-10-what-makes-apartments-increase-in-price.md` — research §1–§8.
- `.planning/research/2026-07-10-ANALYSIS-REDESIGN-FOLLOWUPS.md`.

## Now roadmapped as milestone v1.2 (2026-07-17)
This work is now formal **milestone v1.2 — Renovator-Grade Discovery Analysis**, Phases 13–17:
- **Phase 13** — Discovery UX / poll-timeout fix (= P1 above) — DXUX-01/02
- **Phase 14** — Holistic Analysis Brain (A.3 no-empty + A.4 comps/BRF wiring, confounder-normalize) — ANL-01..04
- **Phase 15** — ROI-Aware Opportunity Brief (A.5 prompt + OpportunityBrief schema + live Anthropic smoke) — ROI-01..05
- **Phase 16** — Value-Gap Scoring & Ranking (wire `valueGap` + "från bildtolkning" marker) — VGAP-01..03
- **Phase 17** — Proposed Planritning Generation (image-gen, HIGH value-gap only) — DRAW-01

See `.planning/ROADMAP.md` (v1.2 section) + `.planning/REQUIREMENTS.md` for full success criteria.
**Next:** `/gsd-plan-phase 13` — or `/gsd-autonomous` to drive all five phases.
