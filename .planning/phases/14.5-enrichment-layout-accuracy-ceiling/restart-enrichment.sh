#!/usr/bin/env bash
# Phase 14.5, plan 10, R-07: the ONE restart of the remaining sold-page enrichment.
#
# The first run (2026-10-17) stopped on a Booli challenge. R-07 allows one gentler restart: the same commands, but one
# page at a time (--concurrency 1) and at least 2 s between page starts (--start-gap-secs 2), local browser only
# (never --allow-apify, D-13), not before 2026-10-18 13:15 UTC and not into the Monday job window.
#
# Start it (the Mac awake and unlocked, the local renderer is headed):
#   caffeinate -i bash .planning/phases/14.5-enrichment-layout-accuracy-ceiling/restart-enrichment.sh
#
# Any non-zero exit is terminal: "STOP: <step> exit <rc> <iso>", no later page-rendering step, the cache-only
# --enrich-report, then "=== END <iso> === stoppad: ..." (ENR-01 partly met, no second restart in this phase).
# The log is the one source log of the runs: .planning/calibration/data/enrich-14.5-full.log (gitignored).
set -u

cd "$(git rev-parse --show-toplevel)" || exit 1

LOG=.planning/calibration/data/enrich-14.5-full.log
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# a. Gates. If either refuses, nothing is written to LOG and nothing renders.
node .planning/phases/14.5-enrichment-layout-accuracy-ceiling/frozen-check.mjs --before-restart || exit 1
node .planning/phases/14.5-enrichment-layout-accuracy-ceiling/booli-gate.mjs --stamp enrichment-restart --hours 4 || exit 1

# b. The one RESTART line.
echo "=== RESTART $(now) === R-07: kvarvarande berikning, BRF-pass, rapport" >> "$LOG"

# c. Steps. Each: a start line, the command with stdout and stderr appended to LOG, an exit line.
run_step() {
  local name="$1"
  shift
  echo "--- $name $(now)" >> "$LOG"
  "$@" >> "$LOG" 2>&1
  local rc=$?
  echo "--- $name exit $rc" >> "$LOG"
  return $rc
}

# d. First non-zero exit: STOP, no later rendering step, the cache-only report, the closing END line.
stop_with() {
  local name="$1" rc="$2"
  echo "STOP: $name exit $rc $(now)" >> "$LOG"
  npx tsx scripts/pull-slutpriser.ts --enrich-report --enrich-since 2025-10-20 >> "$LOG" 2>&1
  echo "=== END $(now) === stoppad: $name exit $rc efter omstarten (R-07: ENR-01 delvis uppfyllt, inget nytt försök)" >> "$LOG"
  exit "$rc"
}

# r1 and r2: one invocation reads at most 1 500 rows and about 1 620 remain; r2 prints "Inget att berika." when
# nothing is left. This is still the one restart, as the first run also needed several invocations.
for step in r1 r2; do
  run_step "$step" npx tsx scripts/pull-slutpriser.ts --enrich-sample 1500 --enrich-max 1500 --enrich-since 2025-10-20 --re-enrich --renderer local --concurrency 1 --start-gap-secs 2 || stop_with "$step" "$?"
done

run_step brf npx tsx scripts/pull-slutpriser.ts --brf-pass --brf-max 1500 --renderer local --concurrency 1 --max-minutes 120 --start-gap-secs 2 || stop_with brf "$?"

# e. Finished: the cache-only report, then END.
npx tsx scripts/pull-slutpriser.ts --enrich-report --enrich-since 2025-10-20 >> "$LOG" 2>&1
echo "=== END $(now) ===" >> "$LOG"
