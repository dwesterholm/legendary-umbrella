/**
 * Wave 0 Booli probes for Phase 14.1 (personal fit score). At most 7 paid
 * Apify renders, at most 3 per probe, all through the app's own transport
 * (`runPlaywrightRender`, RESIDENTIAL/SE proxy, 2048 MB).
 *
 *   npx tsx scripts/probe-fit-sources.ts [--budget-usd 2] [--dry-run]
 *   npx tsx scripts/probe-fit-sources.ts --analyze .planning/calibration/data/probes-<date>.json
 *
 * Probes
 *   A  sold detail pages (3 renders): do they expose build year, balcony, list price?
 *   B  slutpriser pages 10 / 30 / 60 for a Sodermalm 35-60 m2 slice (3 renders):
 *      how deep does pagination go, in what order do sold dates come?
 *   C  price-remark shapes (0 extra renders): read from B's sold cards.
 *   D  the search card for /bostad/150148 (1 render): what does it say about amenities?
 *
 * The raw dump is written BEFORE any analysis (a paid result must survive an
 * analysis bug) to the gitignored `.planning/calibration/data/` directory.
 * `--analyze <dump.json>` re-runs the analysis offline, with no spend.
 *
 * Secret posture: prints only "satt"/"saknas" for APIFY_API_TOKEN, never the
 * value. Errors are printed as messages only.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  runPlaywrightRender,
  apifySpendSince,
  apifyMonthlyHeadroomUsd,
  waitForLedgerSettle,
} from "@/lib/booli/transport";
import { isBooliUrl } from "@/lib/booli/client";
import { observedApifyUsdEstimate } from "@/lib/discovery/cost";
import { USD_SEK_RATE } from "@/lib/brf/cost";

// ---------------------------------------------------------------------------
// Tunables (override per run: SODERMALM_AREA_ID=... npx tsx ...)
// ---------------------------------------------------------------------------
const MAX_RENDERS = 7;
const MAX_RENDERS_PER_PROBE = 3;
const WAIT_SECS = 240;
const MAX_RETRIES = 3;
const SODERMALM_AREA_ID = process.env.SODERMALM_AREA_ID ?? "115341";
const SOLD_DETAIL_IDS = (process.env.SOLD_DETAIL_IDS ?? "6197601,6082254").split(",");
const SLUTPRIS_PAGES = [10, 30, 60];
const TRACKED_BOOLI_ID = "150148";
const DATA_DIR = join(process.cwd(), ".planning", "calibration", "data");
const PROTOTYPE_COPY = join(DATA_DIR, "prototype-budget-2026-10-12.json");
/** Name only; the value is never read into a variable that is printed. */
const TOKEN_ENV_NAME = "APIFY_API_TOKEN";

// ---------------------------------------------------------------------------
// Raw-dump page function. Runs inside the actor's Chromium: ES2019 only, no
// closures over Node scope. The Booli extractor in page-functions.ts has no
// navigation or challenge handling of its own (the actor loads the page before
// the function runs), so this mirrors its shape: one page.evaluate, then
// hasApollo false when nothing recognisable came back (a blocked page), which
// transport.ts treats as a failed render.
// ---------------------------------------------------------------------------
const RAW_DUMP_PAGE_FUNCTION = `async function pageFunction(context) {
  const { page } = context;
  const dump = await page.evaluate(() => {
    const MAX = 3000000;
    const NL = String.fromCharCode(10);
    const scripts = Array.from(document.scripts)
      .filter((s) => !s.src)
      .map((s) => s.textContent || "");
    // Proven read: the inline script text (self.__next_f is emptied on hydrate).
    let transport = scripts.filter((t) => t.includes("ApolloSSRDataTransport")).join(NL);
    if (!transport) {
      try {
        const arr = window[Symbol.for("ApolloSSRDataTransport")];
        if (arr) transport = JSON.stringify(arr) || "";
      } catch (_) {}
    }
    const flight = scripts
      .filter((t) => t.startsWith("self.__next_f.push("))
      .map((t) => {
        try {
          const arr = JSON.parse(t.slice("self.__next_f.push(".length, t.lastIndexOf(")")));
          return typeof arr[1] === "string" ? arr[1] : "";
        } catch (_) { return ""; }
      })
      .join("");
    return { transport: transport.slice(0, MAX), flight: flight.slice(0, MAX) };
  });
  return {
    hasApollo: dump.transport.length > 0 || dump.flight.length > 0,
    transport: dump.transport,
    flight: dump.flight,
  };
}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ProbeId = "A" | "B" | "D";

interface RenderResult {
  probe: ProbeId;
  label: string;
  url: string;
  ok: boolean;
  error?: string;
  transport: string;
  flight: string;
}

type Json = unknown;

function isRecord(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// URL building (T-14.1-08: URLSearchParams on https://www.booli.se only)
// ---------------------------------------------------------------------------
const BOOLI = "https://www.booli.se";

function soldDetailUrl(id: string): string {
  if (!/^\d+$/.test(id)) throw new Error(`Ogiltigt id: ${id}`);
  return `${BOOLI}/annons/${id}`;
}

function searchUrl(path: "/sok/slutpriser" | "/sok/till-salu", params: Record<string, string>): string {
  const sp = new URLSearchParams(params);
  return `${BOOLI}${path}?${sp.toString()}`;
}

function slutpriserUrl(page: number): string {
  return searchUrl("/sok/slutpriser", {
    areaIds: SODERMALM_AREA_ID,
    objectType: "Lägenhet",
    minLivingArea: "35",
    maxLivingArea: "60",
    page: String(page),
  });
}

function trackedCardUrl(): string {
  return searchUrl("/sok/till-salu", {
    areaIds: SODERMALM_AREA_ID,
    objectType: "Lägenhet",
    minLivingArea: "35",
    maxLivingArea: "36",
  });
}

function thirdSoldIdFromPrototype(): string | null {
  if (!existsSync(PROTOTYPE_COPY)) return null;
  try {
    const parsed: Json = JSON.parse(readFileSync(PROTOTYPE_COPY, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.sold)) return null;
    for (const row of parsed.sold) {
      if (!isRecord(row)) continue;
      if (row.district !== "Kungsholmen") continue;
      const m = typeof row.url === "string" ? row.url.match(/^\/annons\/(\d+)$/) : null;
      if (m) return m[1];
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Render budget (hard limits, printed counter)
// ---------------------------------------------------------------------------
let rendersStarted = 0;
const perProbe: Record<ProbeId, number> = { A: 0, B: 0, D: 0 };

async function render(probe: ProbeId, label: string, url: string): Promise<RenderResult> {
  if (!isBooliUrl(url)) throw new Error(`Inte en Booli-url: ${url}`);
  if (rendersStarted >= MAX_RENDERS) throw new Error("Render-taket (7) nått - avbryter");
  if (perProbe[probe] >= MAX_RENDERS_PER_PROBE) throw new Error(`Probe ${probe}: tak ${MAX_RENDERS_PER_PROBE} nått`);
  rendersStarted += 1;
  perProbe[probe] += 1;
  console.log(`  render ${rendersStarted}/${MAX_RENDERS} [${probe}] ${label}`);
  try {
    const items = await runPlaywrightRender(url, RAW_DUMP_PAGE_FUNCTION, {
      waitSecs: WAIT_SECS,
      maxRequestRetries: MAX_RETRIES,
    });
    const first = items[0];
    const rec = isRecord(first) ? first : {};
    return {
      probe,
      label,
      url,
      ok: true,
      transport: typeof rec.transport === "string" ? rec.transport : "",
      flight: typeof rec.flight === "string" ? rec.flight : "",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`  render [${probe}] ${label}: MISSLYCKADES (${message})`);
    return { probe, label, url, ok: false, error: message, transport: "", flight: "" };
  }
}

// ---------------------------------------------------------------------------
// Node-side parsing (defensive: typeof checks, no eval of payload text)
// ---------------------------------------------------------------------------
/** The JSON object literal that starts at the "{" enclosing `idx` (same approach as the browser extractor). */
function objectAround(text: string, idx: number): string | null {
  const start = text.lastIndexOf("{", idx);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Every distinct object in `transport` whose __typename is `typename`. */
function objectsOfType(transport: string, typename: string): Record<string, Json>[] {
  const out: Record<string, Json>[] = [];
  const seen = new Set<string>();
  const marker = `"__typename":"${typename}"`;
  let idx = transport.indexOf(marker);
  while (idx >= 0) {
    const literal = objectAround(transport, idx);
    if (literal && !seen.has(literal)) {
      seen.add(literal);
      try {
        const o: Json = JSON.parse(literal);
        if (isRecord(o) && o.__typename === typename) out.push(o);
      } catch {
        // not a clean object literal; skip
      }
    }
    idx = transport.indexOf(marker, idx + marker.length);
  }
  return out;
}

function walk(node: Json, visit: (o: Record<string, Json>) => void, depth = 0): void {
  if (depth > 80 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit, depth + 1);
    return;
  }
  const rec = node as Record<string, Json>;
  visit(rec);
  for (const v of Object.values(rec)) walk(v, visit, depth + 1);
}

/** Parsed `<id>:<json>` rows of an App Router flight payload. */
function flightRows(flight: string): Json[] {
  const rows: Json[] = [];
  for (const line of flight.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    try {
      rows.push(JSON.parse(line.slice(colon + 1)));
    } catch {
      // flight rows that are not plain JSON (references, chunks) are skipped
    }
  }
  return rows;
}

const compact = (v: Json, max = 200): string => {
  const s = JSON.stringify(v) ?? "";
  return s.length > max ? `${s.slice(0, max)}...` : s;
};

function snippets(text: string, re: RegExp, max: number, radius = 70): string[] {
  const out: string[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m = g.exec(text);
  while (m && out.length < max) {
    const from = Math.max(0, m.index - radius);
    out.push(text.slice(from, Math.min(text.length, m.index + m[0].length + radius)).replace(/\s+/g, " "));
    m = g.exec(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Probe A - sold detail fields
// ---------------------------------------------------------------------------
interface SoldDetailFindings {
  label: string;
  ok: boolean;
  flightChars: number;
  infoPairs: string[];
  buildYear: "present" | "absent";
  buildYearEvidence: string[];
  balcony: "present" | "absent";
  balconyEvidence: string[];
  listPrice: "present" | "absent";
  listPriceEvidence: string[];
}

function analyseSoldDetail(r: RenderResult): SoldDetailFindings {
  const rows = flightRows(r.flight);
  const pairs: string[] = [];
  const pairKeys = /^(InfoPoint|KeyValueOutput)/;
  for (const row of rows) {
    walk(row, (o) => {
      if (typeof o.__typename === "string" && pairKeys.test(o.__typename) && pairs.length < 40) {
        pairs.push(`${o.__typename}: ${compact(o, 160)}`);
      }
    });
  }
  const buildYearRe = /"constructionYear"\s*:\s*(1[6-9]\d\d|20[0-2]\d)|(Bygg(?:nads)?[aå]r)[^0-9]{0,40}(1[6-9]\d\d|20[0-2]\d)/i;
  const buildYearHits = snippets(r.flight, buildYearRe, 3);
  const listPriceHits = snippets(r.flight, /"listPrice"\s*:\s*\{[^}]{0,120}\}/, 2, 10);
  // Balcony: read the sold entity's `amenities` array through its Amenity
  // objects (key + label), not a free-text search (generic UI copy would give
  // false positives, and a regex over the array stops at the first nested "]").
  const amenityKeys: string[] = [];
  for (const row of rows) {
    walk(row, (o) => {
      if (o.__typename === "Amenity" && typeof o.key === "string") amenityKeys.push(o.key);
    });
  }
  const balconyRe = /balcon|balkong|terrass|uteplats|patio/i;
  const balconyKeys = amenityKeys.filter((k) => balconyRe.test(k));
  const balconyInPairs = pairs.filter((p) => balconyRe.test(p));
  const balconyEvidence = [
    `Amenity-nycklar: ${amenityKeys.length ? amenityKeys.join(", ") : "(tom amenities-lista)"}`,
    ...balconyInPairs,
  ];
  return {
    label: r.label,
    ok: r.ok,
    flightChars: r.flight.length,
    infoPairs: pairs,
    buildYear: buildYearHits.length > 0 ? "present" : "absent",
    buildYearEvidence: buildYearHits,
    balcony: balconyKeys.length > 0 || balconyInPairs.length > 0 ? "present" : "absent",
    balconyEvidence,
    listPrice: listPriceHits.length > 0 ? "present" : "absent",
    listPriceEvidence: listPriceHits,
  };
}

// ---------------------------------------------------------------------------
// Probe B / C - slutpriser pages
// ---------------------------------------------------------------------------
const SV_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, maj: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11,
};

/** Best-effort display-date parse (ISO or "12 okt. 2026"); null when unreadable. */
function parseDisplayDate(s: string): number | null {
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const sv = s.toLowerCase().match(/(\d{1,2})\s+([a-zåäö]{3,})\.?\s+(\d{4})/);
  if (sv) {
    const mon = SV_MONTHS[sv[2].slice(0, 3)];
    if (mon !== undefined) return Date.UTC(Number(sv[3]), mon, Number(sv[1]));
  }
  return null;
}

type RemarkClass = "plus" | "hyphen" | "en-dash" | "minus-sign" | "other" | "null";

function classifyRemark(remark: Json): RemarkClass {
  if (remark === null || remark === undefined) return "null";
  const label = isRecord(remark) && typeof remark.label === "string" ? remark.label.trim() : "";
  if (label === "") return "other";
  const c = label.charAt(0);
  if (c === "+") return "plus";
  if (c === "-") return "hyphen";
  if (c === "–") return "en-dash";
  if (c === "−") return "minus-sign";
  return "other";
}

interface SlutprisPage {
  page: number;
  ok: boolean;
  cards: number;
  kinds: { sold: number; listing: number; project: number; other: number };
  soldDates: string[];
  minDate: string | null;
  maxDate: string | null;
  parsedDates: number;
  nonIncreasingShare: number | null;
  newestTs: number | null;
  remarkSamples: { cls: RemarkClass; remark: Json }[];
}

function analyseSlutpriserPage(r: RenderResult, page: number): SlutprisPage {
  const cards = objectsOfType(r.transport, "ListableProperty");
  const kinds = { sold: 0, listing: 0, project: 0, other: 0 };
  const soldDates: string[] = [];
  const remarkSamples: { cls: RemarkClass; remark: Json }[] = [];
  for (const o of cards) {
    const kind = String(o.originId ?? "").split(":")[0];
    if (kind === "sold") kinds.sold += 1;
    else if (kind === "listing") kinds.listing += 1;
    else if (kind === "project") kinds.project += 1;
    else kinds.other += 1;
    if (kind === "sold") {
      if (typeof o.displayDate === "string") soldDates.push(o.displayDate);
      remarkSamples.push({ cls: classifyRemark(o.priceRemark), remark: o.priceRemark ?? null });
    }
  }
  const ts = soldDates.map(parseDisplayDate).filter((x): x is number => x !== null);
  let nonInc: number | null = null;
  if (ts.length >= 2) {
    let ok = 0;
    for (let i = 1; i < ts.length; i++) if (ts[i] <= ts[i - 1]) ok += 1;
    nonInc = ok / (ts.length - 1);
  }
  return {
    page,
    ok: r.ok,
    cards: cards.length,
    kinds,
    soldDates,
    minDate: ts.length ? new Date(Math.min(...ts)).toISOString().slice(0, 10) : null,
    maxDate: ts.length ? new Date(Math.max(...ts)).toISOString().slice(0, 10) : null,
    parsedDates: ts.length,
    nonIncreasingShare: nonInc,
    newestTs: ts.length ? Math.max(...ts) : null,
    remarkSamples,
  };
}

function iconKeyPath(remark: Json): string | null {
  let found: string | null = null;
  const visit = (node: Json, path: string, depth: number): void => {
    if (found || depth > 6 || node === null || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, Json>)) {
      const p = `${path}.${k}`;
      if (typeof v === "string" && /trend(up|down)/i.test(v)) {
        found = p;
        return;
      }
      visit(v, p, depth + 1);
    }
  };
  visit(remark, "priceRemark", 0);
  return found;
}

// ---------------------------------------------------------------------------
// Probe D - the 150148 card
// ---------------------------------------------------------------------------
interface TrackedCard {
  found: boolean;
  keys: string[];
  amenities: Json;
  displayTexts: string[];
  verdict: "true" | "false" | "not-on-card" | "listing-not-found";
}

function analyseTrackedCard(r: RenderResult): TrackedCard {
  const cards = objectsOfType(r.transport, "ListableProperty");
  const card = cards.find((o) => typeof o.url === "string" && o.url.replace(/\/$/, "").endsWith(`/bostad/${TRACKED_BOOLI_ID}`));
  if (!card) return { found: false, keys: [], amenities: null, displayTexts: [], verdict: "listing-not-found" };
  const displayTexts: string[] = [];
  if (isRecord(card.displayAttributes) && Array.isArray(card.displayAttributes.dataPoints)) {
    for (const p of card.displayAttributes.dataPoints) {
      if (isRecord(p) && isRecord(p.value) && typeof p.value.plainText === "string") {
        displayTexts.push(`${String(p.key)}=${p.value.plainText}`);
      }
    }
  }
  let verdict: TrackedCard["verdict"] = "not-on-card";
  if (Array.isArray(card.amenities)) {
    const text = JSON.stringify(card.amenities).toLowerCase();
    verdict = /balcony|balkong/.test(text) ? "true" : card.amenities.length > 0 ? "false" : "not-on-card";
  }
  return { found: true, keys: Object.keys(card), amenities: card.amenities ?? null, displayTexts, verdict };
}

// ---------------------------------------------------------------------------
// Analysis + Decisions suggestion
// ---------------------------------------------------------------------------
function analyse(results: RenderResult[]): void {
  console.log("\n=== PROBE A: sold detail pages ===");
  const aRes = results.filter((r) => r.probe === "A");
  const findings = aRes.map(analyseSoldDetail);
  for (const f of findings) {
    console.log(`\n[${f.label}] ok=${f.ok} flightChars=${f.flightChars}`);
    console.log(`  Byggår: ${f.buildYear}  Balkong: ${f.balcony}  listPrice: ${f.listPrice}`);
    for (const e of f.buildYearEvidence) console.log(`  byggår-träff: ${e}`);
    for (const e of f.balconyEvidence.slice(0, 4)) console.log(`  balkong-träff: ${e}`);
    for (const e of f.listPriceEvidence) console.log(`  listPrice-träff: ${e}`);
    console.log(`  InfoPoint/KeyValueOutput (${f.infoPairs.length}, max 40):`);
    for (const p of f.infoPairs) console.log(`    ${p}`);
  }
  const okA = findings.filter((f) => f.ok);
  const agg = (pick: (f: SoldDetailFindings) => "present" | "absent"): string =>
    okA.length === 0 ? "unknown" : okA.some((f) => pick(f) === "present") ? "present" : "absent";

  if (okA.length > 0) {
    const n = (pick: (f: SoldDetailFindings) => "present" | "absent") => okA.filter((f) => pick(f) === "present").length;
    console.log(
      `\n  Täckning över ${okA.length} sidor: byggår ${n((f) => f.buildYear)}/${okA.length}, ` +
        `balkong-amenity ${n((f) => f.balcony)}/${okA.length}, listPrice ${n((f) => f.listPrice)}/${okA.length}`,
    );
  }

  console.log("\n=== PROBE B: slutpriser pages ===");
  const bPages: SlutprisPage[] = [];
  for (const page of SLUTPRIS_PAGES) {
    const r = results.find((x) => x.probe === "B" && x.label === `slutpriser sida ${page}`);
    if (!r) continue;
    const p = analyseSlutpriserPage(r, page);
    bPages.push(p);
    console.log(
      `  sida ${page}: ok=${p.ok} kort=${p.cards} (sold ${p.kinds.sold}, listing ${p.kinds.listing}, project ${p.kinds.project}, other ${p.kinds.other})` +
        ` datum ${p.minDate ?? "-"}..${p.maxDate ?? "-"} (tolkade ${p.parsedDates}/${p.soldDates.length})` +
        ` icke-stigande ${p.nonIncreasingShare === null ? "-" : p.nonIncreasingShare.toFixed(2)}`,
    );
    if (p.soldDates.length) console.log(`    första datumsträngar: ${p.soldDates.slice(0, 5).join(" | ")}`);
  }

  console.log("\n=== PROBE C: price remark shapes (from B's sold cards) ===");
  const classCounts: Record<RemarkClass, number> = { plus: 0, hyphen: 0, "en-dash": 0, "minus-sign": 0, other: 0, null: 0 };
  const classSample: Partial<Record<RemarkClass, Json>> = {};
  for (const p of bPages) {
    for (const s of p.remarkSamples) {
      classCounts[s.cls] += 1;
      if (classSample[s.cls] === undefined && s.cls !== "null") classSample[s.cls] = s.remark;
    }
  }
  console.log(`  klasser: ${compact(classCounts)}`);
  let iconPath: string | null = null;
  for (const [cls, remark] of Object.entries(classSample)) {
    console.log(`  rå priceRemark [${cls}] (alla nycklar): ${compact(remark, 500)}`);
    if (isRecord(remark)) console.log(`    nycklar: ${Object.keys(remark).join(", ")}`);
    iconPath = iconPath ?? iconKeyPath(remark);
  }

  console.log(`\n=== PROBE D: card for /bostad/${TRACKED_BOOLI_ID} ===`);
  const dRes = results.find((r) => r.probe === "D");
  const card = dRes ? analyseTrackedCard(dRes) : null;
  if (!dRes) console.log("  (ingen render)");
  else if (!dRes.ok) console.log("  render misslyckades");
  if (card) {
    console.log(`  hittad: ${card.found}`);
    if (card.found) {
      console.log(`  toppnycklar: ${card.keys.join(", ")}`);
      console.log(`  amenities: ${compact(card.amenities, 300)}`);
      console.log(`  displayAttributes: ${card.displayTexts.join(" | ")}`);
    }
    console.log(`  balkong på kortet: ${card.verdict}`);
  }

  // ---- suggested Decisions block (an executor still reads the evidence above) ----
  const bOk = bPages.filter((p) => p.ok);
  const withSold = bOk.filter((p) => p.kinds.sold > 0);
  let depth: string;
  if (bOk.length === 0) depth = "unknown";
  else if (withSold.length === 0) depth = "1-9";
  else depth = String(Math.max(...withSold.map((p) => p.page)));

  let order = "unknown";
  const dated = bOk.filter((p) => p.parsedDates >= 5 && p.nonIncreasingShare !== null);
  if (dated.length > 0) {
    const within = dated.every((p) => (p.nonIncreasingShare ?? 0) >= 0.9);
    const byPage = [...dated].sort((a, b) => a.page - b.page);
    let across = true;
    for (let i = 1; i < byPage.length; i++) {
      if ((byPage[i].newestTs ?? 0) > (byPage[i - 1].newestTs ?? 0)) across = false;
    }
    order = within && across ? "newest-first" : "not-newest-first";
  }

  const classesSeen = (Object.keys(classCounts) as RemarkClass[]).filter((c) => classCounts[c] > 0);
  console.log("\n=== FÖRSLAG TILL DECISIONS (granska mot bevisen ovan) ===");
  console.log(`SOLD_DETAIL_BUILD_YEAR: ${agg((f) => f.buildYear)}`);
  console.log(`SOLD_DETAIL_BALCONY: ${agg((f) => f.balcony)}`);
  console.log(`SOLD_DETAIL_LIST_PRICE: ${agg((f) => f.listPrice)}`);
  console.log(`SLUTPRIS_PAGE_DEPTH: ${depth}`);
  console.log(`SLUTPRIS_ORDER: ${order}`);
  console.log(`NEGATIVE_LABEL_SHAPES: ${classesSeen.length ? classesSeen.join(",") : "none-seen"}`);
  console.log(`PRICE_REMARK_ICON_KEY: ${iconPath ?? "none"}`);
  console.log(`CARD_150148_BALCONY: ${card ? card.verdict : "listing-not-found"}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

async function main() {
  const analyzeFile = argValue("--analyze");
  if (analyzeFile) {
    const dump: Json = JSON.parse(readFileSync(analyzeFile, "utf8"));
    if (!isRecord(dump) || !Array.isArray(dump.results)) throw new Error("Okänt dumpformat");
    analyse(dump.results as RenderResult[]);
    return;
  }

  const dryRun = process.argv.includes("--dry-run");
  const budgetArg = argValue("--budget-usd");
  const budgetUsd = budgetArg === null ? 2 : Number(budgetArg);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("--budget-usd måste vara ett positivt tal");

  // Plan the renders first (so --dry-run shows exactly what would be spent).
  const third = thirdSoldIdFromPrototype();
  const soldIds = [...SOLD_DETAIL_IDS, ...(third && !SOLD_DETAIL_IDS.includes(third) ? [third] : [])].slice(0, 3);
  const plan: { probe: ProbeId; label: string; url: string }[] = [
    ...soldIds.map((id) => ({ probe: "A" as const, label: `sold detalj ${id}`, url: soldDetailUrl(id) })),
    ...SLUTPRIS_PAGES.map((p) => ({ probe: "B" as const, label: `slutpriser sida ${p}`, url: slutpriserUrl(p) })),
    { probe: "D" as const, label: `till-salu kort ${TRACKED_BOOLI_ID}`, url: trackedCardUrl() },
  ];
  if (plan.length > MAX_RENDERS) throw new Error("Planen överskrider render-taket");
  console.log(`Planerade renders: ${plan.length} (tak ${MAX_RENDERS}, högst ${MAX_RENDERS_PER_PROBE} per probe)`);
  for (const p of plan) console.log(`  [${p.probe}] ${p.url}`);
  if (third === null) console.log("  (tredje sålda id saknas i prototypkopian - probe A kör två renders)");
  if (dryRun) {
    console.log("--dry-run: inga renders körda.");
    return;
  }

  // Preflight (T-14.1-01: presence only, never the value).
  const tokenState = process.env[TOKEN_ENV_NAME] ? "satt" : "saknas";
  console.log(`${TOKEN_ENV_NAME}: ${tokenState}`);
  if (tokenState === "saknas") process.exit(1);
  const headroom = await apifyMonthlyHeadroomUsd();
  console.log(`Apify månadsutrymme: ${headroom === null ? "okänt" : `${headroom.toFixed(2)} USD`}, budget ${budgetUsd.toFixed(2)} USD`);
  if (headroom !== null && headroom < budgetUsd) {
    console.error(`FEL: månadsutrymmet (${headroom.toFixed(2)} USD) är mindre än --budget-usd (${budgetUsd.toFixed(2)} USD). Ingen körning startad.`);
    process.exit(1);
  }

  const t0 = new Date();
  console.log(`Start: ${t0.toISOString()}`);
  const results = await Promise.all(plan.map((p) => render(p.probe, p.label, p.url)));
  console.log(`Renders startade: ${rendersStarted}/${MAX_RENDERS}`);

  // Dump BEFORE analysis: a paid result must survive an analysis bug.
  mkdirSync(DATA_DIR, { recursive: true });
  const date = t0.toISOString().slice(0, 10);
  const dumpPath = join(DATA_DIR, `probes-${date}.json`);
  writeFileSync(dumpPath, JSON.stringify({ startedAt: t0.toISOString(), results }));
  console.log(`Rådump: ${dumpPath}`);
  for (const r of results) {
    if (r.probe !== "A" || !r.ok) continue;
    const id = r.url.split("/").pop();
    const p = join(DATA_DIR, `probe-sold-detail-${id}.txt`);
    writeFileSync(p, r.flight);
    console.log(`Flight-text (14.1-08 fixture): ${p}`);
  }

  analyse(results);

  // Spend ledger: the real bill from the runs API; labelled estimate only if that fails.
  console.log("\n=== KOSTNAD ===");
  await waitForLedgerSettle();
  const spend = await apifySpendSince(t0);
  if (spend) {
    console.log(
      `Apify-kostnad: ${spend.usd.toFixed(4)} USD (runs-api) = ${(spend.usd * USD_SEK_RATE).toFixed(2)} SEK` +
        ` | körningar ${spend.runs} (ok ${spend.succeeded}, timeout ${spend.timedOut}, fel ${spend.failed}, övrigt ${spend.other}, saknar kostnad ${spend.missingUsage})`,
    );
    console.log("Obs: huvudboken är kontoomfattande - en samtidig körning från annat verktyg i samma fönster räknas också.");
  } else {
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    const est = observedApifyUsdEstimate({ succeeded: ok, timedOut: failed });
    console.log(`Apify-kostnad: ${est.toFixed(4)} USD (estimate) - uppskattning (runs-API:t svarade inte), ${(est * USD_SEK_RATE).toFixed(2)} SEK`);
  }
}

main().catch((e) => {
  console.error("FEL:", e?.message ?? e);
  process.exit(1);
});
