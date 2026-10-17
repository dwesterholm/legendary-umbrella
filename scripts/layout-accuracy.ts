/**
 * Layout accuracy runner (Phase 14.5 plan 02, LAYACC-01..03). Free and offline: No model call, no network, no
 * Booli page. The paid rounds of plans 05-07 are separate runners.
 *
 *   npx tsx scripts/layout-accuracy.ts --report --truth <fil> --cache <layoutcache.json> --out <json> [--md <md>]
 *   npx tsx scripts/layout-accuracy.ts --judge-list --snapshot <fil> [--with-urls]
 *   npx tsx scripts/layout-accuracy.ts --check-truth <fil> [--require-locked]
 *   npx tsx scripts/layout-accuracy.ts --select-and-lock <fil> [--dry-run]
 *   npx tsx scripts/layout-accuracy.ts --report --truth <fil> --variant <id> --out <json> [--md <md>]
 *   npx tsx scripts/layout-accuracy.ts --run <id> --dry-run --truth <fil> [--snapshot <fil>] [--cap-sek <n>]
 *
 * What it answers: how often are the layout reads stored in a cache right, measured against a truth file (flats a
 * person judged by eye)? And the tools to build that truth file: the worklist of Booli ids to judge, a check that
 * catches a malformed or edited file, and one command that fixes the measured set, the 50/50 dev/holdout split and
 * the read order before any paid run.
 *
 * Blind judging: --judge-list never opens a layout cache and never prints a read; --report holds counts, ids and
 * enums only. Picture URLs leave only through --with-urls, after the Booli image-host allowlist.
 *
 * Output files may only be written under .planning/phases/ (the locked truth file) or, for reports, also under
 * .planning/calibration/data/. Errors are printed as the class name only (a message can carry a path, a note or
 * request details).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { booliIdOf, parseFitSnapshot } from "@/lib/discovery/fit-score";
import { guardedDataPath, writeJsonAtomic, writeTextAtomic } from "@/lib/discovery/json-store";
import {
  TRUTH_SET_MIN_ROWS,
  accuracyReport,
  layoutTruthFileSchema,
  lockTruthFile,
  measurability,
  renderAccuracyMd,
  validateTruthFile,
  worklistOf,
  type TruthFile,
} from "@/lib/discovery/layout-accuracy";
import type { LayoutFact } from "@/lib/discovery/layout-fact";
import {
  LAYOUT_ROUND_CAP_SEK,
  LAYOUT_VARIANTS,
  factFromVariantRead,
  layoutVariantCachePath,
  loadVariantCache,
  variantReadId,
  variantVersion,
  type LayoutVariantSpec,
  type VariantReadItem,
} from "@/lib/discovery/layout-experiment";
import { LAYOUT_READ_VERSION, layoutFactFromRead, loadLayoutCache } from "@/lib/discovery/layout-read";
import { formatSek } from "@/lib/discovery/sun-floorplan";

const OUT_DIRS = [".planning/phases", ".planning/calibration/data"] as const;
const TRUTH_DIR = ".planning/phases";
const DEFAULT_SNAPSHOT = ".planning/calibration/data/forsale-snapshot-14.4-layout.json";

const USAGE = `Användning (gratis, inget anrop, ingen Booli-sida):
  npx tsx scripts/layout-accuracy.ts --report --truth <sanningsfil> --cache <layoutcache.json> --out <json> [--md <md>]
  npx tsx scripts/layout-accuracy.ts --judge-list --snapshot <snapshot> [--with-urls]
  npx tsx scripts/layout-accuracy.ts --check-truth <sanningsfil> [--require-locked]
  npx tsx scripts/layout-accuracy.ts --select-and-lock <sanningsfil> [--dry-run]
  npx tsx scripts/layout-accuracy.ts --report --truth <sanningsfil> --variant <id> --out <json> [--md <md>]
  npx tsx scripts/layout-accuracy.ts --run <id> --dry-run --truth <sanningsfil> [--snapshot <snapshot>] [--cap-sek <n>]

  --report         Räknar ut träffsäkerheten för de lagrade läsningarna mot sanningsfilen
  --truth <fil>    Sanningsfilen (zod-kontrollerad, bara id:n och uppräkningar)
  --cache <fil>    Layoutcachen med de lagrade läsningarna (poster med nuvarande läsversion används)
  --variant <id>   Använder i stället experimentcachen för varianten (layout-exp-<id>.json), nyaste läsning per annons
  --run <id>       Planerar en omgång för varianten (a, b, c, d-sonnet, d-opus); utan --dry-run krävs den betalda grenen
  --cap-sek <n>    Taket för omgången i kronor (standard och högsta värde ${LAYOUT_ROUND_CAP_SEK})
  --out <fil>      Var rapporten skrivs (.json under .planning/phases/ eller .planning/calibration/data/)
  --md <fil>       Skriver också rapporten som markdown (samma kataloger, .md)
  --judge-list     Arbetslistan: Booli-id:n att bedöma, Folkungagatan 61 först, sedan en bestämd slumpordning; öppnar ingen cache
  --snapshot <fil> Snapshoten som listan byggs av
  --with-urls      Skriver också bild-URL:erna (bara de som passerar Boolis bildvärdslista) för nedladdningsrundan
  --check-truth    Kontrollerar en sanningsfil mot reglerna; slutkod 1 vid första regeln som bryts
  --require-locked Kräver att filen är låst
  --select-and-lock  Väljer urvalet, delar dev/holdout 50/50 (Folkungagatan 61 i holdout), sätter läsordningen och låser filen
  --dry-run        Skriver ut siffrorna men skriver ingenting (och gör inga anrop)
Rapporterna innehåller bara antal, id:n och uppräkningar, aldrig en enskild läsning. Slutkoder: 0 klart, 1 fel.`;

interface Args {
  report: boolean;
  truth: string | null;
  cache: string | null;
  variant: string | null;
  run: string | null;
  capSek: number | null;
  out: string | null;
  md: string | null;
  judgeList: boolean;
  snapshot: string | null;
  withUrls: boolean;
  checkTruth: string | null;
  requireLocked: boolean;
  selectAndLock: string | null;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const a: Args = {
    report: false, truth: null, cache: null, variant: null, run: null, capSek: null, out: null, md: null,
    judgeList: false, snapshot: null, withUrls: false,
    checkTruth: null, requireLocked: false, selectAndLock: null, dryRun: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") a.help = true;
    else if (flag === "--report") a.report = true;
    else if (flag === "--truth" && value !== undefined) { a.truth = value; i++; }
    else if (flag === "--cache" && value !== undefined) { a.cache = value; i++; }
    else if (flag === "--variant" && value !== undefined) { a.variant = value; i++; }
    else if (flag === "--run" && value !== undefined) { a.run = value; i++; }
    else if (flag === "--cap-sek" && value !== undefined) { a.capSek = Number(value); i++; }
    else if (flag === "--out" && value !== undefined) { a.out = value; i++; }
    else if (flag === "--md" && value !== undefined) { a.md = value; i++; }
    else if (flag === "--judge-list") a.judgeList = true;
    else if (flag === "--snapshot" && value !== undefined) { a.snapshot = value; i++; }
    else if (flag === "--with-urls") a.withUrls = true;
    else if (flag === "--check-truth" && value !== undefined) { a.checkTruth = value; i++; }
    else if (flag === "--require-locked") a.requireLocked = true;
    else if (flag === "--select-and-lock" && value !== undefined) { a.selectAndLock = value; i++; }
    else if (flag === "--dry-run") a.dryRun = true;
    else return null;
  }
  if (a.help) return a;
  const modes = [a.report, a.judgeList, a.checkTruth !== null, a.selectAndLock !== null, a.run !== null].filter(Boolean).length;
  if (modes !== 1) return null;
  if (a.report && (a.truth === null || a.out === null || (a.cache === null) === (a.variant === null))) return null;
  if (a.run !== null && a.truth === null) return null;
  if (!a.report && a.run === null && a.truth !== null) return null;
  if (!a.report && (a.cache !== null || a.variant !== null || a.out !== null || a.md !== null)) return null;
  if (a.judgeList && a.snapshot === null) return null;
  if (!a.judgeList && a.run === null && a.snapshot !== null) return null;
  if (!a.judgeList && a.withUrls) return null;
  if (a.checkTruth === null && a.requireLocked) return null;
  if (a.selectAndLock === null && a.run === null && a.dryRun) return null;
  if (a.run === null && a.capSek !== null) return null;
  return a;
}

/** The path when it lies under one of the allowed directories and ends with `ext`, else null. */
function guardedIn(path: string, dirs: readonly string[], ext: string): string | null {
  for (const dir of dirs) {
    const safe = guardedDataPath(path, { dir, ext });
    if (safe !== null) return safe;
  }
  return null;
}

/** An error reduced to its class name; the message can carry paths, notes or request details, so it is never printed. */
const safeError = (error: unknown): string => (error instanceof Error ? error.name : "UNKNOWN");

/** Reads and schema-checks a truth file. On a schema failure prints the first issue's path and message (never a value) and returns null. */
function readTruth(path: string): TruthFile | null {
  const parsed = layoutTruthFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  console.error(`Sanningsfilen: ogiltig (${issue.path.join(".") || "(root)"}: ${issue.message})`);
  return null;
}

// ---------------------------------------------------------------------------
// --report
// ---------------------------------------------------------------------------

/**
 * The newest stored read of the current version per Booli id (cache ids are `booli:<id>|<imageSetKey>`), as the
 * stored fact. Ties on the date are broken by the id so the choice is deterministic.
 */
function productionReads(cachePath: string): Map<number, LayoutFact> {
  const { cache, warning } = loadLayoutCache(cachePath);
  if (warning) console.log(warning);
  const newest = new Map<number, { storedAt: string; id: string; fact: LayoutFact }>();
  for (const entry of Object.values(cache.entries)) {
    if (entry.promptVersion !== LAYOUT_READ_VERSION) continue;
    const m = /^booli:(\d+)\|/.exec(entry.id);
    if (m === null) continue;
    const booliId = Number(m[1]);
    const prior = newest.get(booliId);
    if (prior !== undefined && (prior.storedAt > entry.storedAt || (prior.storedAt === entry.storedAt && prior.id > entry.id))) continue;
    newest.set(booliId, {
      storedAt: entry.storedAt,
      id: entry.id,
      fact: layoutFactFromRead(entry.result, { version: entry.promptVersion, booli: 0, broker: 0 }),
    });
  }
  return new Map([...newest].map(([id, v]) => [id, v.fact]));
}

const pct = (k: number, n: number): string => (n === 0 ? "-" : `${Math.round((100 * k) / n)} %`);

/**
 * The newest stored read per Booli id of a variant cache, as the stored fact (ids are `booli:<id>|<imageSetKey>`;
 * ties on the date are broken by the id so the choice is deterministic). Null when the cache cannot be read: the
 * caller must stop, since an empty report would look like a variant that read nothing.
 */
function variantReads(spec: LayoutVariantSpec): { reads: Map<number, LayoutFact>; spentSek: number } | null {
  const { cache, warning, unreadable } = loadVariantCache(layoutVariantCachePath(spec.id), spec);
  if (warning) console.log(warning);
  if (unreadable) return null;
  const nominalBooli = 1 + spec.images.maxBooliPhotos;
  const newest = new Map<number, { storedAt: string; id: string; fact: LayoutFact }>();
  for (const entry of Object.values(cache.entries)) {
    const m = /^booli:(\d+)\|/.exec(entry.id);
    if (m === null) continue;
    const booliId = Number(m[1]);
    const prior = newest.get(booliId);
    if (prior !== undefined && (prior.storedAt > entry.storedAt || (prior.storedAt === entry.storedAt && prior.id > entry.id))) continue;
    newest.set(booliId, { storedAt: entry.storedAt, id: entry.id, fact: factFromVariantRead(spec, entry.result, { booli: nominalBooli }) });
  }
  return { reads: new Map([...newest].map(([id, v]) => [id, v.fact])), spentSek: cache.spentSekTotal };
}

function report(args: Args & { truth: string; out: string }): number {
  const jsonOut = guardedIn(args.out, OUT_DIRS, ".json");
  if (jsonOut === null) {
    console.error(`--out måste vara en .json-fil under ${OUT_DIRS.join("/ eller ")}/`);
    return 1;
  }
  const mdOut = args.md === null ? null : guardedIn(args.md, OUT_DIRS, ".md");
  if (args.md !== null && mdOut === null) {
    console.error(`--md måste vara en .md-fil under ${OUT_DIRS.join("/ eller ")}/`);
    return 1;
  }
  const file = readTruth(args.truth);
  if (file === null) return 1;
  let r;
  let spendNote = "";
  if (args.variant !== null) {
    const spec = LAYOUT_VARIANTS[args.variant];
    if (spec === undefined) {
      console.error(`Okänd variant ${args.variant}; kända: ${Object.keys(LAYOUT_VARIANTS).join(", ")}`);
      return 1;
    }
    const loaded = variantReads(spec);
    if (loaded === null) {
      console.error(`Variantcachen för ${spec.id} kunde inte läsas; ingen rapport skrevs`);
      return 1;
    }
    r = accuracyReport(file, loaded.reads, { source: `variant:${spec.id}`, version: variantVersion(spec) });
    spendNote = `; variant ${spec.id} har kostat ${formatSek(loaded.spentSek)} kr totalt`;
  } else {
    r = accuracyReport(file, productionReads(args.cache as string), { source: "production", version: LAYOUT_READ_VERSION });
  }
  writeJsonAtomic(jsonOut, r);
  if (mdOut !== null) writeTextAtomic(mdOut, renderAccuracyMd(r));
  const { balcony, korsdrag, bedroom } = r.raw;
  console.log(
    `Rapport: ${r.rows} rader i urvalet, ${r.noRead} utan lagrad läsning; rå träffsäkerhet (utan spärr): ` +
      `balkong ${balcony.correct} av ${balcony.read} lästa (${pct(balcony.correct, balcony.read)}) av ${balcony.decided} avgjorda, ` +
      `korsdrag ${korsdrag.correct} av ${korsdrag.read} (${pct(korsdrag.correct, korsdrag.read)}) av ${korsdrag.decided}, ` +
      `sovrum ${bedroom.correct} av ${bedroom.read} (${pct(bedroom.correct, bedroom.read)}) av ${bedroom.decided}; skrivet till ${args.out}${spendNote}`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// --judge-list
// ---------------------------------------------------------------------------

/** The worklist from a snapshot only: no layout cache is opened and no read is printed (blind judging). */
function judgeList(snapshotPath: string, withUrls: boolean): number {
  const snapshot = parseFitSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  const list = worklistOf(snapshot.rows);
  console.log(`Arbetslista: ${list.length} annonser`);
  for (const e of list) console.log(withUrls ? `${e.position} ${e.booliId} ${e.imageUrls.join(" ")}` : `${e.position} ${e.booliId}`);
  return 0;
}

// ---------------------------------------------------------------------------
// --check-truth
// ---------------------------------------------------------------------------

function checkTruth(path: string, requireLocked: boolean): number {
  const file = readTruth(path);
  if (file === null) return 1;
  const v = validateTruthFile(file, { requireLocked });
  if (!v.ok) {
    console.error(`Sanningsfilen: fel: ${v.error}`);
    return 1;
  }
  const inSet = file.rows.filter((r) => r.inSet).length;
  console.log(`Sanningsfilen: ok (${file.rows.length} rader, ${inSet} i urvalet, ${file.lockedAt === null ? "olåst" : "låst"})`);
  return 0;
}

// ---------------------------------------------------------------------------
// --select-and-lock
// ---------------------------------------------------------------------------

function selectAndLock(path: string, dryRun: boolean): number {
  const safe = dryRun ? path : guardedIn(path, [TRUTH_DIR], ".json");
  if (safe === null) {
    console.error(`Sanningsfilen måste ligga som .json under ${TRUTH_DIR}/ för att kunna låsas`);
    return 1;
  }
  const file = readTruth(path);
  if (file === null) return 1;
  if (file.lockedAt !== null) {
    console.error("Sanningsfilen är redan låst");
    return 1;
  }
  const procedurePath = join(dirname(path), "PROCEDURE.md");
  const procedureText = existsSync(procedurePath) ? readFileSync(procedurePath, "utf8") : null;
  if (procedureText === null && !dryRun) {
    console.error("PROCEDURE.md saknas i samma katalog som sanningsfilen; proceduren måste vara skriven före låsningen");
    return 1;
  }
  const locked = lockTruthFile(file, { seed: file.seed, procedureText: procedureText ?? "", now: new Date().toISOString() });
  const t = locked.triage;
  const inSet = locked.rows.filter((r) => r.inSet);
  const dev = inSet.filter((r) => r.split === "dev").length;
  const holdout = inSet.filter((r) => r.split === "holdout").length;
  const m = measurability(inSet);
  const yn = (b: boolean) => (b ? "ja" : "nej");

  console.log(`Bedömda: ${t?.judged ?? 0}, ej nedladdningsbara: ${t?.unavailable ?? 0}`);
  console.log(`Avgjorda: balkong ${t?.balconyDecided ?? 0}, fönster ${t?.windowsDecided ?? 0}, sovrum ${t?.bedroomDecided ?? 0}, vardagsrum vid balkong ${t?.livingDecided ?? 0}`);
  console.log(`Urval: ${inSet.length} rader (dev ${dev}, holdout ${holdout})`);
  console.log(
    `Mätbart: balkong ${yn(m.balcony.measurable)} (n = ${m.balcony.decided}), korsdrag ${yn(m.korsdrag.measurable)} (n = ${m.korsdrag.decided}), ` +
      `sovrum ${yn(m.bedroom.measurable)} (n = ${m.bedroom.decided})`,
  );
  if (dryRun) {
    console.log("Torrkörning: inget skrivet");
    return 0;
  }
  if (inSet.length < TRUTH_SET_MIN_ROWS) {
    console.error(`Urvalet har bara ${inSet.length} rader; minst ${TRUTH_SET_MIN_ROWS} krävs, inget låst`);
    return 1;
  }
  const v = validateTruthFile(locked, { requireLocked: true });
  if (!v.ok) {
    console.error(`Den låsta filen klarar inte kontrollen: ${v.error}; inget skrivet`);
    return 1;
  }
  writeJsonAtomic(safe, locked);
  console.log(`Låst: ${locked.lockedAt}`);
  return 0;
}

// ---------------------------------------------------------------------------
// --run
// ---------------------------------------------------------------------------

/** The flats of a round, in order: the locked set in its read order, or every row of an unlocked file (dry run only). */
function itemsOf(file: TruthFile, snapshotPath: string): { items: VariantReadItem[]; missing: number[] } {
  const snapshot = parseFitSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  const urlsById = new Map<number, readonly string[] | null>();
  for (const row of snapshot.rows) {
    const id = booliIdOf(row.candidate);
    if (id !== null && !urlsById.has(id)) urlsById.set(id, row.candidate.imageUrls);
  }
  const rows =
    file.lockedAt !== null
      ? file.rows.filter((r) => r.inSet).sort((x, y) => (x.order ?? Number.MAX_SAFE_INTEGER) - (y.order ?? Number.MAX_SAFE_INTEGER))
      : file.rows;
  const items: VariantReadItem[] = [];
  const missing: number[] = [];
  for (const row of rows) {
    if (!urlsById.has(row.booliId)) {
      missing.push(row.booliId);
      continue;
    }
    items.push({ booliId: row.booliId, listingPath: `/bostad/${row.booliId}`, imageUrls: urlsById.get(row.booliId) ?? null });
  }
  return { items, missing };
}

/** The plan of a round with no call: what would be read, what is cached, what it would cost at the variant's estimate. */
function dryRun(spec: LayoutVariantSpec, items: readonly VariantReadItem[], missing: readonly number[], capSek: number): number {
  const { cache, warning } = loadVariantCache(layoutVariantCachePath(spec.id), spec);
  if (warning) console.log(warning);
  const ids = items.map((item) => variantReadId(spec, item));
  const readable = ids.filter((id) => id !== null).length;
  const hits = ids.filter((id) => id !== null && cache.entries[id] !== undefined).length;
  const toCall = readable - hits;
  const estimate = toCall * spec.estSekPerFlat;
  console.log(
    `Variant ${spec.id} (${spec.model}, version ${variantVersion(spec)}): ${spec.label}; ${items.length} lägenheter i körordning, ${readable} med läsbara bilder, ${hits} redan i cachen`,
  );
  console.log(`Bilder per läsning: planritning och ${spec.images.maxBooliPhotos} foton från Booli, inga mäklarbilder; ${spec.steps} steg`);
  console.log(
    `Uppskattat: ${toCall} anrop à ${formatSek(spec.estSekPerFlat)} kr = ${formatSek(estimate)} kr (tak ${formatSek(capSek)} kr${estimate > capSek ? "; uppskattningen överstiger taket, omgången skulle stanna" : ""})`,
  );
  if (missing.length > 0) console.log(`Saknas i snapshoten: ${missing.join(", ")}`);
  console.log("Torrkörning: inga anrop");
  return 0;
}

function run(args: Args & { run: string; truth: string }): number {
  const spec = LAYOUT_VARIANTS[args.run];
  if (spec === undefined) {
    console.error(`Okänd variant ${args.run}; kända: ${Object.keys(LAYOUT_VARIANTS).join(", ")}`);
    return 1;
  }
  const capSek = args.capSek ?? LAYOUT_ROUND_CAP_SEK;
  if (!Number.isFinite(capSek) || capSek <= 0 || capSek > LAYOUT_ROUND_CAP_SEK) {
    console.error(`--cap-sek måste vara över 0 och högst ${LAYOUT_ROUND_CAP_SEK}`);
    return 1;
  }
  if (!args.dryRun) {
    console.error("Betald körning kopplas in i uppgift 2");
    return 1;
  }
  const file = readTruth(args.truth);
  if (file === null) return 1;
  const snapshotPath = args.snapshot ?? DEFAULT_SNAPSHOT;
  if (!existsSync(snapshotPath)) {
    console.error("Snapshoten finns inte; ange --snapshot <fil>");
    return 1;
  }
  const { items, missing } = itemsOf(file, snapshotPath);
  return dryRun(spec, items, missing, capSek);
}

// ---------------------------------------------------------------------------

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.log(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    if (args.report) return report(args as Args & { truth: string; out: string });
    if (args.run !== null) return run(args as Args & { run: string; truth: string });
    if (args.judgeList) return judgeList(args.snapshot as string, args.withUrls);
    if (args.checkTruth !== null) return checkTruth(args.checkTruth, args.requireLocked);
    return selectAndLock(args.selectAndLock as string, args.dryRun);
  } catch (error) {
    console.error("FEL:", safeError(error));
    return 1;
  }
}

process.exit(main());
