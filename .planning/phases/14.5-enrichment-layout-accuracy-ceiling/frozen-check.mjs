// Phase 14.5, R-06 guard as amended by R-07. Exit 0 = the rule held, exit 1 = it was broken.
//
// R-06 protects a RUNNING enrichment. scripts/pull-slutpriser.ts runs in fresh processes (enrichment batches, the
// BRF pass, --enrich-report) and each new process re-reads its source files, so none of the files below may change
// while such a process can start. The run log .planning/calibration/data/enrich-14.5-full.log has two such windows:
//   1. the first run, from "=== START <iso>" (2026-10-17 12:02 UTC) until Booli's challenge stopped it in batch 2.
//      Its "STOP: batch 2 exit 2" line carries no time; FIRST_RUN_STOPPED_AT is the log's last write of that run
//      (13:09:57 UTC) rounded up to the minute.
//   2. the one restart R-07 allows, from "=== RESTART <iso> ..." until the first "=== END <iso>" after it. The
//      restart wrapper (plan 10) writes END on every outcome: finished, or STOP followed by the cache-only report.
// Between the two windows no enrichment process exists. R-07 lets exactly GAP_ALLOWED change then (the restart's
// page-spacing flag, committed before the restart starts); every other frozen file waits for the restart's END.
//
// Checks, robust at any later time:
//   1. at most one RESTART line, not earlier than 2026-10-18T13:15:00Z (R-07);
//   2. no commit since 744ea7b that touches a frozen file was made inside a window, and a commit made in the gap
//      touches GAP_ALLOWED files only;
//   3. while a window is open (a process may be running) no frozen file has an uncommitted edit; in the gap only
//      GAP_ALLOWED files may.
// Modes:
//   --before-restart  also refuses when a RESTART line already exists, when the first run is not closed, or when any
//                     frozen file has an uncommitted edit (the restart wrapper runs this before it writes RESTART);
//   --require-final   also refuses until the restart's END line exists (the refit gate of plans 10-13).
// Prints the state, file names, commit hashes and times only.
//
//   node .planning/phases/14.5-enrichment-layout-accuracy-ceiling/frozen-check.mjs [--before-restart | --require-final]
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
  // R-07: new in plan 10, imported by scripts/pull-slutpriser.ts for --start-gap-secs, so the restart reads it too.
  "src/lib/booli/start-gate.ts",
];
const GAP_ALLOWED = new Set(["scripts/pull-slutpriser.ts", "src/lib/booli/start-gate.ts"]);
const LOG = ".planning/calibration/data/enrich-14.5-full.log";
const BASE = "744ea7b";
const FIRST_RUN_STOPPED_AT = "2026-10-17T13:10:00Z";
const RESTART_NOT_BEFORE = "2026-10-18T13:15:00Z";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sec = (iso, what) => {
  const s = Date.parse(iso) / 1000;
  if (!Number.isFinite(s)) fail(`${what} går inte att läsa: ${iso}`);
  return s;
};
const iso = (s) => new Date(s * 1000).toISOString().replace(".000Z", "Z");

const mode = process.argv[2] ?? null;
if (mode !== null && mode !== "--before-restart" && mode !== "--require-final") fail(`okänt läge: ${mode}`);

if (!existsSync(LOG)) fail(`berikningsloggen saknas: ${LOG}`);
let start = null;
let firstClosed = null;
let restart = null;
let restarts = 0;
let end = null;
let stoppedAfterRestart = false;
for (const line of readFileSync(LOG, "utf8").split("\n")) {
  let m;
  if ((m = line.match(/^=== START (\S+)/))) {
    if (start === null) start = sec(m[1], "START-raden");
  } else if ((m = line.match(/^=== RESTART (\S+)/))) {
    restarts += 1;
    if (restart === null) restart = sec(m[1], "RESTART-raden");
  } else if ((m = line.match(/^=== END (\S+)/))) {
    if (restart !== null) {
      if (end === null) end = sec(m[1], "END-raden");
    } else if (start !== null && firstClosed === null) {
      firstClosed = sec(m[1], "END-raden");
    }
  } else if (line.startsWith("STOP:")) {
    if (restart !== null) {
      if (end === null) stoppedAfterRestart = true;
    } else if (start !== null && firstClosed === null) {
      firstClosed = sec(FIRST_RUN_STOPPED_AT, "FIRST_RUN_STOPPED_AT");
    }
  }
}
if (start === null) fail("START-raden saknas i berikningsloggen");

// Check 1: one restart, not before the R-07 time, never while the first run could still be running.
if (restarts > 1) fail(`fler än en omstart i loggen (${restarts}); R-07 tillåter en`);
if (restart !== null && restart < sec(RESTART_NOT_BEFORE, "RESTART_NOT_BEFORE")) {
  fail(`omstarten ${iso(restart)} ligger före ${RESTART_NOT_BEFORE} (R-07)`);
}
if (restart !== null && firstClosed === null) fail("omstart utan STOP- eller END-rad för första körningen");

const windows = [[start, firstClosed ?? Infinity, "första körningen"]];
if (restart !== null) windows.push([restart, end ?? Infinity, "omstarten"]);
const open = windows.some(([, b]) => b === Infinity);
const gapEnd = restart ?? Infinity;

// Check 2: commits.
const commits = [];
for (const l of git(["log", "--format=@%H %ct", "--name-only", `${BASE}..HEAD`, "--", ...FROZEN]).split("\n")) {
  if (l.startsWith("@")) {
    const [hash, at] = l.slice(1).split(" ");
    commits.push({ hash, at: Number(at), files: [] });
  } else if (l.trim() && commits.length > 0) {
    commits[commits.length - 1].files.push(l.trim());
  }
}
for (const c of commits) {
  for (const [a, b, name] of windows) {
    if (c.at >= a && c.at < b) fail(`fryst fil ändrad i en commit medan ${name} kunde köra: ${c.hash} (${c.files.join(", ")})`);
  }
  if (firstClosed !== null && c.at >= firstClosed && c.at < gapEnd) {
    const other = c.files.filter((f) => !GAP_ALLOWED.has(f));
    if (other.length > 0) {
      fail(`fryst fil ändrad före omstartens END: ${c.hash} (${other.join(", ")}); i mellanrummet får bara ${[...GAP_ALLOWED].join(" och ")} ändras (R-07)`);
    }
  }
}

// Check 3: the working tree.
const dirty = git(["status", "--porcelain", "--", ...FROZEN])
  .split("\n")
  .filter(Boolean)
  .map((l) => l.slice(3));
if (open && dirty.length > 0) fail(`fryst fil ändrad i arbetskatalogen medan en berikning kan köra: ${dirty.join(", ")}`);
if (!open && restart === null) {
  const other = dirty.filter((f) => !GAP_ALLOWED.has(f));
  if (other.length > 0) fail(`fryst fil ändrad i arbetskatalogen före omstartens END: ${other.join(", ")} (R-07)`);
}

if (mode === "--before-restart") {
  if (restart !== null) fail("omstarten är redan gjord; R-07 tillåter en");
  if (firstClosed === null) fail("första körningen saknar STOP- eller END-rad; ingen omstart medan den kan köra");
  if (dirty.length > 0) fail(`fryst fil har ändringar som inte är incheckade: ${dirty.join(", ")}; checka in före omstarten`);
}
if (mode === "--require-final" && (restart === null || end === null)) {
  fail(restart === null ? "berikningen är inte klar: omstarten (R-07) har inte börjat" : "berikningen är inte klar: omstartens END-rad saknas");
}

console.log(
  restart === null
    ? firstClosed === null
      ? `Berikning: första körningen pågår sedan ${iso(start)}.`
      : `Berikning: stoppad ${iso(firstClosed)} av en Booli-utmaning, ingen process; en omstart tillåten från ${RESTART_NOT_BEFORE} (R-07).`
    : end === null
      ? `Berikning: omstarten pågår sedan ${iso(restart)}.`
      : `Berikning: avslutad ${iso(end)}${stoppedAfterRestart ? " efter en STOP-rad i omstarten (ENR-01 delvis uppfyllt, inget nytt försök, R-07)" : ""}.`,
);
console.log("Frysta filer: inga ändringar medan en berikning kunde köra.");
