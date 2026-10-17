// Phase 14.5, R-06 guard. Exit 0 = the rule held, exit 1 = it was broken.
//
// The enrichment that started 2026-10-17 12:02 UTC runs scripts/pull-slutpriser.ts in fresh processes
// (three batches, then the BRF pass, then --enrich-report). Each new process re-reads its source files, so
// none of the 18 files below may change until the line "=== END <iso-time> ===" is in the run log.
//
// Checks, robust at any later time:
//   1. every commit since 744ea7b that touches one of the 18 files was made at or after the END time;
//   2. while there is no END line yet, none of the 18 files has an uncommitted edit in the working tree.
// Prints file names and commit hashes only.
//
//   node .planning/phases/14.5-enrichment-layout-accuracy-ceiling/frozen-check.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const FROZEN = [
  "scripts/pull-slutpriser.ts",
  "src/lib/apify/booli-scraper.ts",
  "src/lib/booli/brf-page.ts",
  "src/lib/booli/client.ts",
  "src/lib/booli/fallback-tree.ts",
  "src/lib/booli/image-host.ts",
  "src/lib/booli/local-browser.ts",
  "src/lib/booli/page-functions.ts",
  "src/lib/booli/slutpriser.ts",
  "src/lib/booli/transport.ts",
  "src/lib/brf/cost.ts",
  "src/lib/broker/fetch-broker-page.ts",
  "src/lib/broker/parse-broker-page.ts",
  "src/lib/broker/url-guard.ts",
  "src/lib/discovery/area-seed.ts",
  "src/lib/discovery/cost.ts",
  "src/lib/discovery/filter-schema.ts",
  "src/lib/discovery/hedonic-model.ts",
];
const LOG = ".planning/calibration/data/enrich-14.5-full.log";
const BASE = "744ea7b";

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const match = existsSync(LOG) ? readFileSync(LOG, "utf8").match(/^=== END (\S+)/m) : null;
const endSec = match ? Date.parse(match[1]) / 1000 : null;
if (match && !Number.isFinite(endSec)) {
  console.error(`END-raden går inte att läsa: ${match[0]}`);
  process.exit(1);
}

const commits = git(["log", "--format=%H %ct", `${BASE}..HEAD`, "--", ...FROZEN]);
for (const line of commits ? commits.split("\n") : []) {
  const [hash, committedAt] = line.split(" ");
  if (endSec === null || Number(committedAt) < endSec) {
    console.error(`fryst fil ändrad i en commit före END: ${hash}`);
    process.exit(1);
  }
}

if (endSec === null) {
  const dirty = git(["status", "--porcelain", "--", ...FROZEN]);
  if (dirty) {
    console.error(`fryst fil ändrad i arbetskatalogen före END:\n${dirty}`);
    process.exit(1);
  }
}

console.log(endSec === null ? "Frysta filer orörda (END saknas än)." : "Frysta filer: inga ändringar före END.");
