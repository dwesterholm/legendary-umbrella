// Phase 14.5, R-07 gate for Booli traffic from this Mac. Exit 0 = traffic may start now, exit 1 = wait.
//
// Booli challenged this Mac's local browser on 2026-10-17 (enrichment batch 2, about 13:09 UTC). R-07: no Booli
// traffic from this Mac before 2026-10-18T13:15:00Z: not the picture downloads from Booli's image host for the truth
// set (plans 06-07), not the enrichment restart (plan 10), not the live run (plan 13). The same 24-hour wait follows
// every later refusal: a picture download answered with HTTP 403/429 or with a page instead of a picture (recorded
// with --refused), or a timed "STOP:" line the enrichment restart wrote after its "=== RESTART" line.
//
//   node <phase dir>/booli-gate.mjs [--hours <h>]                  may traffic of about h hours (default 1) start now?
//   node <phase dir>/booli-gate.mjs --stamp <label> [--hours <h>]  the same; when allowed, appends "<iso> start <label>"
//   node <phase dir>/booli-gate.mjs --refused <label>              appends "<iso> refused <label>"; exit 0
//   node <phase dir>/booli-gate.mjs --check-stamps <label|all>     exit 0 when the log has at least one start line with
//                                                                  that label and every such start was allowed at its time
// Also waits while a scripts/pull-slutpriser.ts process runs (one Booli client at a time) and when [now, now + h]
// touches Monday 06:30-09:30 local time (the weekly launchd job starts Monday 07:00).
// The traffic log .planning/calibration/data/booli-traffic-14.5.log is gitignored and holds times and labels only;
// labels are lower-case letters, digits and hyphens, so no URL can enter it. Run from the repository root.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const NOT_BEFORE = Date.parse("2026-10-18T13:15:00Z");
const DAY_MS = 24 * 3600 * 1000;
const TRAFFIC_LOG = ".planning/calibration/data/booli-traffic-14.5.log";
const ENRICH_LOG = ".planning/calibration/data/enrich-14.5-full.log";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : (process.argv[i + 1] ?? "");
};
const checkedLabel = (v, allowAll = false) => {
  if (allowAll && v === "all") return v;
  if (v === null || !/^[a-z0-9-]{1,40}$/.test(v)) fail(`ogiltig etikett: använd a-z, 0-9 och bindestreck (fick "${v ?? ""}")`);
  return v;
};
const readLines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n") : []);
const append = (line) => {
  mkdirSync(dirname(TRAFFIC_LOG), { recursive: true });
  appendFileSync(TRAFFIC_LOG, `${line}\n`);
};

const traffic = readLines(TRAFFIC_LOG)
  .map((l) => l.match(/^(\S+) (start|refused) ([a-z0-9-]+)$/))
  .filter(Boolean)
  .map((m) => ({ at: Date.parse(m[1]), kind: m[2], label: m[3] }))
  .filter((e) => Number.isFinite(e.at));
const enrich = readLines(ENRICH_LOG);
const restartIndex = enrich.findIndex((l) => l.startsWith("=== RESTART "));
const restartStops =
  restartIndex < 0
    ? []
    : enrich
        .slice(restartIndex)
        .map((l) => l.match(/^STOP:.*\s(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*$/))
        .filter(Boolean)
        .map((m) => Date.parse(m[1]))
        .filter(Number.isFinite);

/** Earliest allowed start for traffic beginning at `at`, from what was recorded at or before `at`. */
function earliest(at) {
  let t = NOT_BEFORE;
  for (const e of traffic) if (e.kind === "refused" && e.at <= at) t = Math.max(t, e.at + DAY_MS);
  for (const s of restartStops) if (s <= at) t = Math.max(t, s + DAY_MS);
  return t;
}

function enrichmentRunning() {
  try {
    execFileSync("pgrep", ["-f", "scripts/pull-slutpriser[.]ts"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function touchesWeeklyJob(fromMs, hours) {
  for (let t = fromMs; t <= fromMs + hours * 3600e3; t += 5 * 60e3) {
    const d = new Date(t);
    const hm = d.getHours() * 100 + d.getMinutes();
    if (d.getDay() === 1 && hm >= 630 && hm <= 930) return true;
  }
  return false;
}

const refused = argValue("--refused");
if (refused !== null) {
  const label = checkedLabel(refused);
  const now = Date.now();
  append(`${iso(now)} refused ${label}`);
  console.log(`Vägran noterad ${iso(now)} (${label}); nästa Booli-trafik tidigast ${iso(now + DAY_MS)}.`);
  process.exit(0);
}

const check = argValue("--check-stamps");
if (check !== null) {
  const label = checkedLabel(check, true);
  const starts = traffic.filter((e) => e.kind === "start" && (label === "all" || e.label === label));
  if (starts.length === 0) fail(`ingen start med etiketten ${label} i trafikloggen`);
  for (const e of starts) {
    const t = earliest(e.at);
    if (e.at < t) fail(`start ${e.label} ${iso(e.at)} låg före ${iso(t)} (R-07)`);
  }
  console.log(`${starts.length} start(er) med etiketten ${label}, alla tillåtna (R-07).`);
  process.exit(0);
}

const hoursRaw = argValue("--hours");
const hours = hoursRaw === null ? 1 : Number(hoursRaw);
if (!(hours > 0 && hours <= 12)) fail("--hours måste vara ett tal över 0 och högst 12");
const now = Date.now();
const allowedFrom = earliest(now);
if (now < allowedFrom) fail(`Booli-trafik tidigast ${iso(allowedFrom)} (R-07); nu ${iso(now)}.`);
if (enrichmentRunning()) fail("En berikning (scripts/pull-slutpriser.ts) körs; en Booli-klient i taget.");
if (touchesWeeklyJob(now, hours)) fail(`De närmaste ${hours} h når måndag 06:30-09:30 (veckojobbet startar 07:00); vänta.`);
const stamp = argValue("--stamp");
if (stamp !== null) append(`${iso(now)} start ${checkedLabel(stamp)}`);
console.log(`Booli-trafik tillåten nu (${iso(now)}; tidigast var ${iso(allowedFrom)}).`);
