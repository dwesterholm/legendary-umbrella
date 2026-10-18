/**
 * spike-report.ts - the result of the live spike on the city's building-permit list, and the rule that turns it into
 * GO or STOP (Phase 14.6, CASE-03, D-01, D-04, R-06, R-07).
 *
 * PURE: no network, no file access. `scripts/bygglov-spike.ts` runs the spike and hands the facts to
 * {@link buildSpikeReport}; this file decides the verdict, checks the shape and writes the Swedish summary.
 *
 * THE STOP RULE (D-01, D-04): the city saying no ends the phase at the spike. "No" means HTTP 403 or 429, a login
 * wall, a terms page, a changed page shape, an answer that is not HTML, a redirect (we send `redirect: "error"`, so
 * a redirect to a login page would look like a network failure and must not pass for one), a robots.txt that closes
 * the case pages, or a case page that links to terms of use. Two more stops say the spike showed nothing: fewer than
 * 10 buildings tried, or no fastighetsbeteckning found for any of them. A Min Karta refusal is NOT a stop: that host
 * is turned off and the other three ways of finding a fastighetsbeteckning stay.
 *
 * WHAT THE EVIDENCE MAY HOLD: addresses and fastighetsbeteckningar (public property data), counts, tags, years and
 * months. No handler name, no document list, no free case text: the schema is strict, so an extra key is a failure.
 */
import { z } from "zod/v4";
import type { StoredCase } from "@/lib/stockholm/bygglov-classify";

// ---------------------------------------------------------------------------
// The buildings
// ---------------------------------------------------------------------------

export interface SpikeBuilding {
  /** The Booli ids of the flats (two ids can share one address). */
  readonly booliIds: readonly string[];
  readonly address: string;
  readonly district: string;
  readonly constructionYear: number | null;
  /** The association name as Booli gave it; null when Booli gave none. A guess for rung (a2) when it ends in a number. */
  readonly brfName: string | null;
}

/**
 * The 13 addresses of D-04, from the 2026-10-13 snapshot: Folkungagatan 61 first, then the twelve flats eye-checked in
 * 14.4 (Tjurbergsgatan 38 is one address with two ids), then two buildings from the 1960s and 1970s.
 */
export const SPIKE_BUILDINGS: readonly SpikeBuilding[] = [
  { booliIds: ["150148"], address: "Folkungagatan 61", district: "Södermalm", constructionYear: 1912, brfName: null },
  { booliIds: ["130457"], address: "Idungatan 5", district: "Vasastan", constructionYear: 1969, brfName: "BRF Skalmejblåsaren 12" },
  { booliIds: ["142942"], address: "Karlsviksgatan 9", district: "Kungsholmen", constructionYear: 1926, brfName: "BRF Gjuteriet 4" },
  { booliIds: ["144070"], address: "Fridhemsgatan 41", district: "Kungsholmen", constructionYear: 1884, brfName: "BRF Ankaret 1" },
  { booliIds: ["208640"], address: "Creutzgatan 2", district: "Kungsholmen", constructionYear: 1926, brfName: "HSB BRF Kalkonen i Stockholm" },
  { booliIds: ["309602"], address: "Frödingsvägen 9", district: "Kungsholmen", constructionYear: 1931, brfName: "HSB BRF Fredhäll i Stockholm" },
  { booliIds: ["315823"], address: "Hallandsgatan 30", district: "Södermalm", constructionYear: 1929, brfName: null },
  { booliIds: ["323721"], address: "Bergsundsgatan 14", district: "Södermalm", constructionYear: 1939, brfName: "BRF Bergsundsklippan" },
  { booliIds: ["324812"], address: "Tjurbergsgatan 34", district: "Södermalm", constructionYear: 1927, brfName: "HSB BRF Vågskivan i Stockholm" },
  { booliIds: ["324847", "324863"], address: "Tjurbergsgatan 38", district: "Södermalm", constructionYear: null, brfName: "HSB BRF Vågskivan i Stockholm" },
  { booliIds: ["328402"], address: "Gyllenborgsgatan 15", district: "Kungsholmen", constructionYear: 1926, brfName: "HSB BRF Kalkonen i Stockholm" },
  { booliIds: ["767763"], address: "Tideliusgatan 55", district: "Södermalm", constructionYear: 1968, brfName: "BRF Pinnpojken" },
  { booliIds: ["6295311"], address: "Hornsgatan 119", district: "Södermalm", constructionYear: 1970, brfName: "BRF Lingonet" },
];

// ---------------------------------------------------------------------------
// Robots
// ---------------------------------------------------------------------------

/** The three kinds of page the phase asks for, in lower case (robots.txt paths are compared without case). */
const CASE_PAGE_PATHS = [
  "/byggochplantjansten/arendeochhandlingar",
  "/byggochplantjansten/arende/arende/1",
  "/byggochplantjansten/casesearch/addresssearch",
] as const;

interface RobotsRule {
  readonly allow: boolean;
  readonly path: string;
}

/** The rules that apply to `User-agent: *` (a group that names several agents counts when one of them is `*`). */
function rulesForAnyAgent(text: string): RobotsRule[] {
  const rules: RobotsRule[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const rawLine of text.slice(0, 64 * 1024).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      inRules = true;
      if (agents.includes("*") && value !== "") rules.push({ allow: field === "allow", path: value });
    }
  }
  return rules;
}

/** A robots path pattern (`*` any run, `$` end) as a regular expression anchored at the start of the path. */
function patternOf(path: string): RegExp {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path).toLowerCase();
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

/** Longest matching rule wins, allow wins a tie (the usual reading of robots.txt). */
function blocked(rules: readonly RobotsRule[], path: string): boolean {
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of rules) {
    if (!patternOf(rule.path).test(path)) continue;
    const length = rule.path.length;
    if (best === null || length > best.length || (length === best.length && rule.allow)) best = { length, allow: rule.allow };
  }
  return best !== null && !best.allow;
}

export interface RobotsReading {
  /** True when any of the three kinds of case page is closed for `User-agent: *`. */
  readonly disallowsCasePages: boolean;
  /** Disallow lines that touch the e-service (as written, cut at 80 characters, at most 10). */
  readonly rulesUnderService: string[];
}

/** Reads a robots.txt for the e-service. An empty or non-robots text (a 404 page, HTML) closes nothing. */
export function readRobots(text: string): RobotsReading {
  const rules = rulesForAnyAgent(text);
  const disallowsCasePages = CASE_PAGE_PATHS.some((path) => blocked(rules, path));
  const rulesUnderService = rules
    .filter((r) => !r.allow && (r.path.toLowerCase().startsWith("/byggochplantjansten") || CASE_PAGE_PATHS.some((p) => patternOf(r.path).test(p))))
    .map((r) => r.path.slice(0, 80))
    .slice(0, 10);
  return { disallowsCasePages, rulesUnderService };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** What a city refusal is called when it ends the run. */
export const SPIKE_STOP_LABELS = ["http-403", "http-429", "inloggning", "villkor", "andrad-sida", "fel-innehallstyp", "omdirigering", "pausad"] as const;

export type MinKartaStatus = "accepted" | "nekad" | "fel" | "ej prövad";

export interface VerdictInput {
  /** The label of the CityStop that ended the run, or null. */
  readonly refusal: string | null;
  /** From robots.txt; null when it was not read. */
  readonly robotsDisallows: boolean | null;
  /** Anchor texts that look like terms of use, from the pages read. */
  readonly termsLinks: readonly string[];
  /** Requests whose answer was a redirect (we refuse to follow one). */
  readonly redirects?: number;
  readonly minkarta: MinKartaStatus;
  /** Buildings the run got to, and how many it needed to count as a spike (10 of 13; a narrower run needs all it asked for). */
  readonly buildingsAttempted?: number;
  readonly buildingsRequired?: number;
  /** Buildings whose fastighetsbeteckning was found. A run where none was found shows nothing, so it is no GO. */
  readonly buildingsResolved?: number;
}

export type SpikeVerdict =
  | { verdict: "go"; reason: null; minkarta: MinKartaStatus }
  | { verdict: "stop"; reason: string; minkarta: MinKartaStatus };

/** GO or STOP. The first stop reason found wins, in the order the city could have told us no. */
export function spikeVerdict(input: VerdictInput): SpikeVerdict {
  const stop = (reason: string): SpikeVerdict => ({ verdict: "stop", reason, minkarta: input.minkarta });
  if (input.refusal !== null && (SPIKE_STOP_LABELS as readonly string[]).includes(input.refusal)) return stop(input.refusal);
  if ((input.redirects ?? 0) > 0) return stop("omdirigering");
  if (input.robotsDisallows === true) return stop("robots");
  if (input.termsLinks.length > 0) return stop("villkor-lank");
  if (input.buildingsRequired !== undefined && (input.buildingsAttempted ?? 0) < input.buildingsRequired) return stop("for-fa-byggnader");
  if (input.buildingsResolved !== undefined && input.buildingsResolved === 0) return stop("ingen-losning");
  return { verdict: "go", reason: null, minkarta: input.minkarta };
}

// ---------------------------------------------------------------------------
// Facts from the stored cases
// ---------------------------------------------------------------------------

const refusedOutcome = (c: StoredCase): boolean => c.latest !== null && /avskriv|avslag/i.test(`${c.latest.type} ${c.latest.code ?? ""}`);

/**
 * The years of the building's stambyte cases (enforcement cases and refused or withdrawn ones left out): the year of the
 * Slutbesked when one is on record, else the year the case started. Sorted, no duplicates.
 */
export function stambyteYearsOf(cases: readonly StoredCase[]): number[] {
  const years = cases
    .filter((c) => c.kinds.includes("stambyte") && !c.tillsyn && !refusedOutcome(c))
    .map((c) => Number((c.slutbeskedDate ?? c.startDate).slice(0, 4)));
  return [...new Set(years)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const RUNG = z.enum(["a", "a2", "b", "c"]);
const KIND_KEY = z.string().regex(/^[a-z_]{1,30}$/);
const MONTH = z.string().regex(/^\d{4}-\d{2}$/);
const SHORT = z.string().max(120);

const caseNoteSchema = z.strictObject({
  kind: KIND_KEY,
  month: MONTH,
  /** What the decisions say; null when the detail page was not read. */
  decision: z.string().regex(/^[a-z]{1,20}$/).nullable(),
});

const buildingSchema = z.strictObject({
  booliIds: z.array(z.string().regex(/^\d{1,10}$/)).min(1).max(4),
  address: z.string().max(80),
  constructionYear: z.number().int().nullable(),
  rungsTried: z.array(RUNG).max(4),
  rung: RUNG.nullable(),
  beteckning: z.string().max(80).nullable(),
  status: z.enum(["resolved", "ambiguous", "no_candidates", "fetch_failed", "avbruten"]),
  fromCache: z.boolean(),
  buildCases: z.number().int().min(0).nullable(),
  otherCases: z.number().int().min(0).nullable(),
  kinds: z.record(KIND_KEY, z.number().int().min(0)),
  stambyteYears: z.array(z.number().int()).max(40),
  stambyteOngoing: z.boolean().nullable(),
  balconyCases: z.array(caseNoteSchema).max(30),
  recentInteresting: z.array(caseNoteSchema).max(6),
  detailPagesRead: z.number().int().min(0),
  requestSeconds: z.array(z.number().min(0)).max(20),
  notes: z.array(SHORT).max(8),
  /** The label of the CityStop that ended this building's lookup (refusal or not), or null. */
  refusal: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable(),
});

const statsSchema = z.strictObject({
  median: z.number().min(0).nullable(),
  max: z.number().min(0).nullable(),
  n: z.number().int().min(0),
});

export const spikeReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ranAt: z.string(),
  /** True for a run on saved pages: no request was made and the three untested facts were not tested. */
  dryRun: z.boolean(),
  verdict: z.enum(["go", "stop"]),
  stopReason: z.string().max(60).nullable(),
  requests: z.strictObject({ city: z.number().int().min(0), minkarta: z.number().int().min(0) }),
  secondsPerRequest: statsSchema,
  minkartaSecondsPerRequest: statsSchema,
  robots: z.strictObject({
    status: z.number().int().nullable(),
    disallowsCasePages: z.boolean().nullable(),
    rulesUnderService: z.array(z.string().max(80)).max(10),
  }),
  termsLinks: z.array(z.string().max(80)).max(10),
  redirects: z.number().int().min(0),
  substringTest: z.strictObject({
    query: z.literal("ambyte"),
    /** Cases the word "ambyte" found in the window. Null: not run or the page was too big to read. */
    count: z.number().int().min(0).nullable(),
    /** Cases the word "stambyte" found in the same window. */
    stambyteCount: z.number().int().min(0).nullable(),
    /** How many of the "stambyte" cases the "ambyte" search found too. */
    overlap: z.number().int().min(0).nullable(),
    /** true: the field matches inside words. false: whole words only. null: no clear answer. */
    substring: z.boolean().nullable(),
  }),
  minkarta: z.strictObject({
    address: z.string().max(80),
    status: z.enum(["accepted", "nekad", "fel", "ej prövad"]),
    beteckning: z.string().max(80).nullable(),
    agreesWithCity: z.boolean().nullable(),
    calls: z.number().int().min(0),
  }),
  distinctBeteckningar: z.number().int().min(0),
  buildings: z.array(buildingSchema).max(20),
});

export type SpikeReport = z.infer<typeof spikeReportSchema>;
export type SpikeBuildingRecord = z.infer<typeof buildingSchema>;

export interface SpikeRunFacts {
  readonly ranAt: string;
  readonly dryRun: boolean;
  readonly buildings: readonly SpikeBuildingRecord[];
  /** How many buildings the run was asked to do. */
  readonly selectedCount: number;
  readonly requests: { city: number; minkarta: number };
  readonly citySeconds: readonly number[];
  readonly minkartaSeconds: readonly number[];
  readonly robots: { status: number | null; text: string | null };
  readonly termsLinks: readonly string[];
  readonly redirects: number;
  readonly refusal: string | null;
  readonly substringTest: SpikeReport["substringTest"];
  readonly minkarta: SpikeReport["minkarta"];
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Median and maximum of a list of seconds, one decimal; null for an empty list. */
export function secondsStats(values: readonly number[]): { median: number | null; max: number | null; n: number } {
  if (values.length === 0) return { median: null, max: null, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median: round1(median), max: round1(sorted[sorted.length - 1]), n: sorted.length };
}

/** Builds the report (verdict included) and checks it against the strict schema. Throws if the shape is wrong. */
export function buildSpikeReport(facts: SpikeRunFacts): SpikeReport {
  const robots = facts.robots.text === null ? null : readRobots(facts.robots.text);
  const decided = spikeVerdict({
    refusal: facts.refusal,
    robotsDisallows: robots === null ? null : robots.disallowsCasePages,
    termsLinks: facts.termsLinks,
    redirects: facts.redirects,
    minkarta: facts.minkarta.status,
    buildingsAttempted: facts.buildings.length,
    buildingsRequired: Math.min(10, facts.selectedCount),
    buildingsResolved: facts.buildings.filter((b) => b.beteckning !== null).length,
  });
  const beteckningar = new Set(
    facts.buildings.flatMap((b) => (b.beteckning === null ? [] : [b.beteckning.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv")])),
  );
  return spikeReportSchema.parse({
    schemaVersion: 1,
    ranAt: facts.ranAt,
    dryRun: facts.dryRun,
    verdict: decided.verdict,
    stopReason: decided.reason,
    requests: facts.requests,
    secondsPerRequest: secondsStats(facts.citySeconds),
    minkartaSecondsPerRequest: secondsStats(facts.minkartaSeconds),
    robots: {
      status: facts.robots.status,
      disallowsCasePages: robots === null ? null : robots.disallowsCasePages,
      rulesUnderService: robots === null ? [] : robots.rulesUnderService,
    },
    termsLinks: [...new Set(facts.termsLinks.map((t) => t.slice(0, 80)))].slice(0, 10),
    redirects: facts.redirects,
    substringTest: facts.substringTest,
    minkarta: facts.minkarta,
    distinctBeteckningar: beteckningar.size,
    buildings: facts.buildings,
  });
}

// ---------------------------------------------------------------------------
// The Swedish summary
// ---------------------------------------------------------------------------

const sv = (x: number | null): string => (x === null ? "-" : x.toFixed(1).replace(".", ","));
const cell = (text: string): string => text.replace(/\|/g, "/");

function kindsText(kinds: Record<string, number>): string {
  const parts = Object.entries(kinds)
    .filter(([kind]) => kind !== "annat")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([kind, n]) => `${kind} ${n}`);
  return parts.length === 0 ? "-" : parts.join(", ");
}

function substringParagraph(t: SpikeReport["substringTest"], dryRun: boolean): string[] {
  if (dryRun || t.substring === null) {
    const why = dryRun ? "Inte prövat (torrkörning)." : t.count === null || t.stambyteCount === null ? "Provet gav inget läsbart svar." : `Orden gav ${t.count} (ambyte) och ${t.stambyteCount} (stambyte) ärenden, ${t.overlap ?? 0} gemensamma: inget tydligt svar.`;
    return [
      `1. Beskrivningsfältet, sökning inne i ord: ${why}`,
      "   Vad det betyder: tills vi vet söker veckokörningen på hela ordet 'stambyte' och räknar inte med att korta ordstammar fungerar.",
    ];
  }
  const found = `Sökordet 'ambyte' gav ${t.count} ärenden och 'stambyte' gav ${t.stambyteCount} i samma fönster (Södermalm, 2025); ${t.overlap} av de senare fanns också i den förra.`;
  return t.substring
    ? [
        `1. Beskrivningsfältet söker inne i ord: JA. ${found}`,
        "   Vad det betyder: vi kan söka på en kort ordstam och få med 'stambyte', 'VA-stambyte' och 'stambyten' i ett anrop.",
      ]
    : [
        `1. Beskrivningsfältet söker inne i ord: NEJ, bara hela ord. ${found}`,
        "   Vad det betyder: en sökning på 'stambyte' missar böjningar och sammansättningar. Svepet måste lista varje form eller läsa bredare och sortera själv.",
      ];
}

function robotsParagraph(r: SpikeReport["robots"], dryRun: boolean): string[] {
  if (dryRun) return ["2. robots.txt: inte läst (torrkörning).", "   Vad det betyder: ingenting är mätt än."];
  if (r.status === null) return ["2. robots.txt: kunde inte läsas.", "   Vad det betyder: vi vet inte vad sajten ber robotar om."];
  if (r.disallowsCasePages === true) {
    return [
      `2. robots.txt (HTTP ${r.status}): stänger ärendesidorna för alla robotar. Regler: ${r.rulesUnderService.join(", ") || "-"}.`,
      "   Vad det betyder: STOPP. Vi hämtar inte sidor som sajten ber robotar låta bli.",
    ];
  }
  return [
    `2. robots.txt (HTTP ${r.status}): ${r.rulesUnderService.length === 0 ? "inga regler som rör ärendesidorna" : `regler som inte rör våra sidor: ${r.rulesUnderService.join(", ")}`}.`,
    "   Vad det betyder: sajten ber inte robotar hålla sig borta från de tre sidtyper vi använder.",
  ];
}

function minkartaParagraph(m: SpikeReport["minkarta"]): string[] {
  const where = `${m.address}, ${m.calls} anrop`;
  switch (m.status) {
    case "accepted":
      return [
        `3. Min Karta med vårt ärliga User-Agent (${where}): togs emot. Svar: ${m.beteckning ?? "ingen fastighet"}${m.agreesWithCity === null ? "" : m.agreesWithCity ? ", samma som stadens egen sökning" : ", men stadens egen sökning sa något annat"}.`,
        "   Vad det betyder: den sista utvägen (steg c) kan användas, högst några adresser per körning.",
      ];
    case "nekad":
      return [
        `3. Min Karta med vårt ärliga User-Agent (${where}): NEKAD. Värden är avstängd utan slutdatum.`,
        "   Vad det betyder: steg c är av för gott. De tre andra stegen (mäklartext, föreningsnamn, stadens adresssökning) räcker; en adress som inte går att lösa blir okänd.",
      ];
    case "fel":
      return [
        `3. Min Karta (${where}): tekniskt fel, varken ja eller nej.`,
        "   Vad det betyder: oklart. Steg c används inte i den här körningen.",
      ];
    default:
      return ["3. Min Karta: inte prövad.", "   Vad det betyder: ingenting är mätt än."];
  }
}

/** The report in plain Swedish for Daniel. Starts with the heading and an "Utfall:" line. */
export function renderSpikeMarkdown(report: SpikeReport): string {
  const out: string[] = [];
  out.push("# Spike: stadens ärendelista (14.6)");
  out.push("");
  out.push(report.verdict === "go" ? "Utfall: GO" : `Utfall: STOPP (${report.stopReason ?? "okänd orsak"})`);
  out.push("");
  if (report.dryRun) out.push("Det här är en torrkörning på sparade sidor: inget anrop gjordes och de tre okända sakerna är inte mätta.", "");

  const found = report.buildings.filter((b) => b.beteckning !== null).length;
  const byRung = (rung: string) => report.buildings.filter((b) => b.rung === rung).length;
  out.push(`Körd ${report.ranAt}. Stadens e-tjänst: ${report.requests.city} anrop, median ${sv(report.secondsPerRequest.median)} s, längst ${sv(report.secondsPerRequest.max)} s. Min Karta: ${report.requests.minkarta} anrop.`);
  out.push(
    `Fastighetsbeteckning hittad för ${found} av ${report.buildings.length} adresser (a ${byRung("a")}, a2 ${byRung("a2")}, b ${byRung("b")}, c ${byRung("c")}), antal olika fastigheter: ${report.distinctBeteckningar}.`,
  );
  if (report.verdict === "stop") {
    out.push("", "STOPP betyder att fasen slutar här med de här fakta (D-04). Inga fler anrop görs mot stadens sajt.");
  }
  out.push("", "## De tre sakerna som inte var prövade", "");
  out.push(...substringParagraph(report.substringTest, report.dryRun));
  out.push("");
  out.push(...robotsParagraph(report.robots, report.dryRun));
  out.push("");
  out.push(...minkartaParagraph(report.minkarta));
  if (report.termsLinks.length > 0) out.push("", `Länkar som liknar användarvillkor på ärendesidorna: ${report.termsLinks.join(", ")}.`);
  if (report.redirects > 0) out.push("", `${report.redirects} anrop fick en omdirigering (vi följer ingen).`);

  out.push("", "## Byggnaderna", "");
  out.push("| Adress | Fastighet | Hittad med | Ärenden | Stambyte (år) | Balkong | Anrop (s) |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const b of report.buildings) {
    const shown = b.balconyCases.slice(0, 3).map((c) => `${c.kind} ${c.month}${c.decision ? ` (${c.decision})` : ""}`);
    const balcony = b.balconyCases.length === 0 ? "-" : `${shown.join(", ")}${b.balconyCases.length > 3 ? ` (+${b.balconyCases.length - 3})` : ""}`;
    out.push(
      `| ${cell(b.address)} | ${cell(b.beteckning ?? `okänd (${b.status})`)} | ${b.rung ?? "-"}${b.fromCache ? " (cache)" : ""} | ${b.buildCases ?? "-"} | ${b.stambyteYears.join(", ") || "-"}${b.stambyteOngoing === true ? " (pågår)" : ""} | ${cell(balcony)} | ${b.requestSeconds.map(sv).join(" ") || "-"} |`,
    );
  }

  out.push("", "## Per byggnad", "");
  for (const b of report.buildings) {
    out.push(`### ${b.address}${b.constructionYear === null ? "" : ` (byggd ${b.constructionYear})`}`);
    out.push(`- Fastighet: ${b.beteckning ?? "okänd"}; steg som prövades: ${b.rungsTried.join(", ") || "-"}; ärenden: ${b.buildCases ?? "-"} (andra: ${b.otherCases ?? "-"}); detaljsidor lästa: ${b.detailPagesRead}`);
    out.push(`- Typer: ${kindsText(b.kinds)}`);
    if (b.recentInteresting.length > 0) {
      out.push(`- Senaste intressanta: ${b.recentInteresting.map((c) => `${c.kind} ${c.month}${c.decision ? ` (${c.decision})` : ""}`).join(", ")}`);
    }
    for (const note of b.notes) out.push(`- Anmärkning: ${note}`);
    if (b.refusal !== null) out.push(`- Uppslaget avbröts: ${b.refusal}`);
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
