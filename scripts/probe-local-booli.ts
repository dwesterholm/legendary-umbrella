/**
 * Free local probe for the local browser rung (Phase 14.2, WATCH-01 and WATCH-02).
 *
 *   npx tsx scripts/probe-local-booli.ts search --area <areaId> [--pages N]
 *       [--min-area N] [--price-decrease] [--max-price N] [--save-meta <path>]
 *   npx tsx scripts/probe-local-booli.ts detail <booli-url> [--save <path>] [--mode new-headless]
 *   npx tsx scripts/probe-local-booli.ts brf <digits-id> [--save <path>] [--raw]
 *
 * Opens a headed Chromium on this Mac (parked off-screen unless
 * BOOLI_LOCAL_WINDOW=visible) and prints what Booli shipped. It never calls
 * Apify and costs nothing: the ledger lines say so, and the Apify fallback is
 * off (no `allowApify`).
 *
 * `search` without capture flags renders N till-salu pages through the SAME
 * `fetchAreaListings` and `toCandidate` the weekly run uses. With any of
 * --min-area / --price-decrease / --max-price / --save-meta it renders page 1
 * through a dedicated CAPTURE page function (a repo constant, compiled like
 * every other page function) that hands back the raw Apollo transport text,
 * then prints Booli's three result counts (till salu, Nyproduktion,
 * Slutpriser) and the cards on the page.
 *
 * `--save-meta` and `detail --save` write SANITIZED fixtures (T-14.2-09): every
 * key named like agent / person / contact / seller / phone / email is dropped,
 * `description` becomes null, at most two images are kept, and the result is
 * scanned for e-mail and phone values before anything is written. Booli's
 * public listing facts and the agency (company) name stay. Save paths are
 * accepted only under src/lib/booli/__fixtures__/ or .planning/calibration/data/
 * (T-14.2-13).
 *
 * Secret posture: prints no environment values at all.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { AREA_SEED } from "@/lib/discovery/area-seed";
import { toCandidate } from "@/lib/discovery/candidate";
import { APOLLO_PAGE_FUNCTION } from "@/lib/booli/page-functions";

const USAGE = `Användning:
  npx tsx scripts/probe-local-booli.ts search --area <områdes-id> [--pages N] [--min-area N]
      [--price-decrease] [--max-price N] [--save-meta <sökväg>]
  npx tsx scripts/probe-local-booli.ts search --area <områdes-id> --complete [--min-area N]
  npx tsx scripts/probe-local-booli.ts detail <booli-url> [--save <sökväg>] [--mode new-headless]
  npx tsx scripts/probe-local-booli.ts brf <id> [--save <sökväg>] [--raw]

  --area <id>        Booli-områdes-id, till exempel 115341 (Södermalm)
  --pages <n>        antal sökresultatsidor, standard 1 (1-5)
  --complete         hämta tills Boolis eget antal är nått (högst 15 sidor) och skriv
                     "Fullständighet: N av M annonser (P sidor, komplett|ofullständig)"
  --min-area <n>     minsta boarea i kvm (minLivingArea)
  --price-decrease   skickar priceDecrease=1 (kontrollerat 2026-10-13: söksidan ignorerar den,
                     antalet blir detsamma; prissänkta annonser syns i kortens priceRemark)
  --max-price <n>    högsta pris (maxListPrice), bara för information (A6)
  --save-meta <p>    spara ett sanerat sökresultat-utdrag som fixtur
  --save <p>         spara den sanerade annonsposten som fixtur
  --mode new-headless  kör utan fönster (A1, obevisat mot Booli)
  brf <id>           läs Boolis offentliga BRF-sida (/bostadsrattsforening/<siffror>) och skriv
                     lån, boarea och skuld per kvm; --save sparar sidtexten kortad till
                     ekonomiraderna (rader som nämner personer tas bort), --raw skriver ut
                     sidtexten (bara för felsökning, aldrig till git)

Sparsökvägar måste ligga under src/lib/booli/__fixtures__/ eller .planning/calibration/data/.
Gratis: använder bara den lokala webbläsaren, aldrig Apify.`;

interface SearchArgs {
  mode: "search";
  area: string;
  pages: number;
  minArea: number | null;
  priceDecrease: boolean;
  maxPrice: number | null;
  saveMeta: string | null;
  complete: boolean;
}
interface DetailArgs {
  mode: "detail";
  url: string;
  save: string | null;
  browserMode: "headed" | "new-headless";
}
interface BrfArgs {
  mode: "brf";
  id: string;
  save: string | null;
  raw: boolean;
}
type Args = SearchArgs | DetailArgs | BrfArgs;

const isPosInt = (v: string | undefined): v is string => v !== undefined && /^\d+$/.test(v) && Number(v) >= 1;

function parseArgs(argv: string[]): Args | null {
  const [mode, ...rest] = argv;
  if (mode === "search") {
    const a: SearchArgs = { mode, area: "", pages: 1, minArea: null, priceDecrease: false, maxPrice: null, saveMeta: null, complete: false };
    let area: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (flag === "--area" && value !== undefined && /^\d+$/.test(value)) {
        area = value;
        i++;
      } else if (flag === "--pages" && isPosInt(value) && Number(value) <= 5) {
        a.pages = Number(value);
        i++;
      } else if (flag === "--min-area" && isPosInt(value)) {
        a.minArea = Number(value);
        i++;
      } else if (flag === "--max-price" && isPosInt(value)) {
        a.maxPrice = Number(value);
        i++;
      } else if (flag === "--price-decrease") {
        a.priceDecrease = true;
      } else if (flag === "--complete") {
        a.complete = true;
      } else if (flag === "--save-meta" && value !== undefined) {
        a.saveMeta = value;
        i++;
      } else {
        return null;
      }
    }
    if (area === null) return null;
    a.area = area;
    return a;
  }
  if (mode === "detail") {
    const [url, ...flags] = rest;
    if (url === undefined || url.startsWith("--")) return null;
    const a: DetailArgs = { mode, url, save: null, browserMode: "headed" };
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      const value = flags[i + 1];
      if (flag === "--save" && value !== undefined) {
        a.save = value;
        i++;
      } else if (flag === "--mode" && value === "new-headless") {
        a.browserMode = "new-headless";
        i++;
      } else {
        return null;
      }
    }
    return a;
  }
  if (mode === "brf") {
    const [id, ...flags] = rest;
    if (id === undefined || !/^\d+$/.test(id)) return null;
    const a: BrfArgs = { mode, id, save: null, raw: false };
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      const value = flags[i + 1];
      if (flag === "--save" && value !== undefined) {
        a.save = value;
        i++;
      } else if (flag === "--raw") {
        a.raw = true;
      } else {
        return null;
      }
    }
    return a;
  }
  return null;
}

function areaName(id: string): string {
  const hit = Object.entries(AREA_SEED).find(([, v]) => v === id);
  return hit ? hit[0].charAt(0).toUpperCase() + hit[0].slice(1) : id;
}

const kr = (n: number | null) => (n === null ? "-" : Math.round(n).toLocaleString("sv-SE"));

// ---------------------------------------------------------------------------
// Save paths (T-14.2-13)
// ---------------------------------------------------------------------------

const SAVE_ROOTS = [resolve("src/lib/booli/__fixtures__"), resolve(".planning/calibration/data")];

/** The absolute save path, or null when it lies outside the two allowed directories. */
function guardedSavePath(path: string): string | null {
  const abs = resolve(path);
  return SAVE_ROOTS.some((root) => abs === root || abs.startsWith(root + sep)) ? abs : null;
}

function writeText(abs: string, text: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

// ---------------------------------------------------------------------------
// Sanitizing (T-14.2-09)
// ---------------------------------------------------------------------------

/** Keys that can carry a person or a contact detail. `agency` is a company and stays. */
const PII_KEY = /agent|person|contact|phone|mobile|e-?mail|seller|realtor/i;
const EMAIL_VALUE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_VALUE = /(?:\+46|0046)[\s\d-]{7,}|(?<!\d)0\d{1,2}[-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2}(?!\d)/;

/** Deep copy without PII-named keys, with `description` nulled and image lists cut to two. */
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEY.test(key)) continue;
      if (key === "description") {
        out[key] = null;
        continue;
      }
      if (key === "images" && Array.isArray(v)) {
        out[key] = v.slice(0, 2).map(sanitize);
        continue;
      }
      out[key] = sanitize(v);
    }
    return out;
  }
  return value;
}

/** Paths of string values that look like an e-mail address or a phone number. */
function piiValuePaths(value: unknown, path = "$"): string[] {
  if (typeof value === "string") {
    return EMAIL_VALUE.test(value) || PHONE_VALUE.test(value) ? [path] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => piiValuePaths(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => piiValuePaths(v, `${path}.${k}`));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Capture page function (T-14.2-03: a repo constant, compiled like the others)
// ---------------------------------------------------------------------------

/** A string EXPRESSION run in the page: the joined inline Apollo transport scripts. ES5 on purpose. */
const TRANSPORT_EXPRESSION =
  'Array.from(document.scripts).filter(function (s) { return !s.src; })' +
  '.map(function (s) { return s.textContent || ""; })' +
  '.filter(function (t) { return t.indexOf("ApolloSSRDataTransport") >= 0; }).join("\\n")';

const CAPTURE_PAGE_FUNCTION = `async function pageFunction(context) {
  const { page } = context;
  const transport = String(await page.evaluate(${JSON.stringify(TRANSPORT_EXPRESSION)}));
  return {
    hasApollo: transport.length > 0,
    __APOLLO_STATE__: transport.length > 0 ? { "Capture:0": { transport: transport } } : null,
  };
}`;

/** The JSON object literal that starts at the "{" at `start`, or null. Same brace walk the extractor uses. */
function objectFrom(text: string, start: number): string | null {
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

interface CountObject {
  totalCount: number;
  title: string | null;
  meta: Record<string, unknown>;
}

/** Every `"totalCount":N,"meta":{...}` pair in the transport text (the meta object is cut forward). */
function countObjectsOf(text: string): CountObject[] {
  const out: CountObject[] = [];
  const seen = new Set<string>();
  const marker = '"totalCount":';
  let idx = text.indexOf(marker);
  while (idx >= 0) {
    let j = idx + marker.length;
    let digits = "";
    while (j < text.length && text[j] >= "0" && text[j] <= "9") digits += text[j++];
    const metaMarker = ',"meta":';
    if (digits !== "" && text.startsWith(metaMarker, j) && text[j + metaMarker.length] === "{") {
      const literal = objectFrom(text, j + metaMarker.length);
      if (literal) {
        try {
          const meta = JSON.parse(literal) as Record<string, unknown>;
          const title = (meta.title as { plainText?: unknown } | undefined)?.plainText;
          const key = `${digits}|${literal}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ totalCount: Number(digits), title: typeof title === "string" ? title : null, meta });
          }
        } catch {
          /* not JSON: skip */
        }
      }
    }
    idx = text.indexOf(marker, idx + marker.length);
  }
  return out;
}

type Card = Record<string, unknown>;

/** Every distinct `ListableProperty` card (originId "listing:<id>") in the transport text. */
function cardsOf(text: string): Card[] {
  const out: Card[] = [];
  const seen = new Set<string>();
  const marker = '"__typename":"ListableProperty"';
  let idx = text.indexOf(marker);
  while (idx >= 0) {
    const start = text.lastIndexOf("{", idx);
    const literal = start >= 0 ? objectFrom(text, start) : null;
    if (literal) {
      try {
        const o = JSON.parse(literal) as Card;
        const id = String(o.listingId ?? "");
        if (id && String(o.originId ?? "").startsWith("listing:") && !seen.has(id)) {
          seen.add(id);
          out.push(o);
        }
      } catch {
        /* skip */
      }
    }
    idx = text.indexOf(marker, idx + marker.length);
  }
  return out;
}

const priceOf = (card: Card): number | null => {
  const m = String(card.displayPrice ?? "")
    .replace(/ /g, " ")
    .match(/\d[\d ]*/);
  return m ? Number(m[0].replace(/ /g, "")) : null;
};
const statusKeyOf = (card: Card): string | null => {
  const s = card.primaryStatus as { key?: unknown } | null | undefined;
  return typeof s?.key === "string" ? s.key : null;
};

/** Builds a till-salu URL for the capture path (URLSearchParams only, T-05-11). */
function captureUrl(a: SearchArgs, page = 1): string {
  const params = new URLSearchParams({ areaIds: a.area, objectType: "Lägenhet" });
  if (a.minArea !== null) params.set("minLivingArea", String(a.minArea));
  if (a.maxPrice !== null) params.set("maxListPrice", String(a.maxPrice));
  if (a.priceDecrease) params.set("priceDecrease", "1");
  params.set("sort", "listSqmPrice");
  params.set("ascending", "true");
  if (page > 1) params.set("page", String(page));
  return `https://www.booli.se/sok/till-salu?${params.toString()}`;
}

/** Whether a count object is Booli's own till-salu total (not Nyproduktion, not Slutpriser). */
const isTillSaluCount = (c: CountObject): boolean =>
  c.title !== null && /till salu/i.test(c.title) && !/^nyproduktion/i.test(c.title);

/** Renders `url` with the capture page function and returns the joined transport text. */
async function captureTransport(url: string): Promise<string> {
  const { runPlaywrightRender } = await import("@/lib/booli/transport");
  const items = await runPlaywrightRender(url, CAPTURE_PAGE_FUNCTION);
  const state = (items[0] as { __APOLLO_STATE__?: Record<string, { transport?: unknown }> }).__APOLLO_STATE__;
  const text = state?.["Capture:0"]?.transport;
  if (typeof text !== "string" || text === "") throw new Error("Ingen Apollo-transporttext i sidan");
  return text;
}

/**
 * The sanitized meta fixture: the till-salu, Nyproduktion and Slutpriser result
 * objects (each with its totalCount and meta) plus up to three cards, each
 * wrapped as an ApolloSSRDataTransport push script. Cards carry no person or
 * contact keys (sanitize); the presenter keeps its company name only.
 */
function buildMetaFixture(counts: CountObject[], cards: Card[]): string {
  const withBidding = cards.find((c) => statusKeyOf(c) === "biddingOpen");
  const withLetters = cards.find((c) => /[åäöÅÄÖ]/.test(String(c.title ?? "")) && c !== withBidding);
  const chosen = [withBidding, withLetters, ...cards].filter((c, i, all): c is Card => !!c && all.indexOf(c) === i).slice(0, 3);
  const cleanCards = chosen.map((c) => {
    const copy = sanitize(c) as Card;
    const presenter = c.presenter as { name?: unknown } | null | undefined;
    copy.presenter = presenter && typeof presenter.name === "string" ? { __typename: "Presenter", name: presenter.name } : null;
    return copy;
  });
  const scripts: string[] = [];
  const tillSalu = counts.find(isTillSaluCount);
  const others = counts.filter((c) => c !== tillSalu && c.title !== null && (/^nyproduktion/i.test(c.title) || /^slutpriser/i.test(c.title)));
  const wrap = (result: unknown): string =>
    `(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(${JSON.stringify({ rehydrate: { [String(scripts.length + 1)]: { data: { searchForSale: result } } } })})`;
  const slim = (c: CountObject, items: Card[]) => ({
    __typename: "SearchResult",
    items,
    totalCount: c.totalCount,
    meta: { __typename: "SearchResultMeta", tilesQuery: (c.meta.tilesQuery as string | undefined) ?? null, title: c.meta.title ?? null },
  });
  if (tillSalu) scripts.push(wrap(slim(tillSalu, cleanCards)));
  for (const c of others) scripts.push(wrap(slim(c, [])));
  return `${scripts.join("\n")}\n`;
}

async function runSearchCapture(a: SearchArgs): Promise<void> {
  const url = captureUrl(a);
  console.log(`Område: ${areaName(a.area)} (${a.area})`);
  console.log(`Sök-URL: ${url}`);
  const text = await captureTransport(url);
  const counts = countObjectsOf(text);
  const cards = cardsOf(text);
  console.log(`Booli-antal (${counts.length}):`);
  for (const c of counts) console.log(`  totalCount ${c.totalCount} | ${c.title ?? "(ingen titel)"} | tilesQuery ${String(c.meta.tilesQuery ?? "-")}`);
  const tillSalu = counts.find(isTillSaluCount);
  console.log(`Eget antal (till salu): ${tillSalu ? tillSalu.totalCount : "okänt"}`);
  const byStatus = new Map<string, number>();
  for (const c of cards) byStatus.set(statusKeyOf(c) ?? "(ingen)", (byStatus.get(statusKeyOf(c) ?? "(ingen)") ?? 0) + 1);
  console.log(`Kort på sidan: ${cards.length} (${[...byStatus].map(([k, n]) => `${k}: ${n}`).join(", ")})`);
  const withDate = cards.filter((c) => typeof c.displayDate === "string" && c.displayDate !== "").length;
  console.log(`Kort med visningsdatum (A14): ${withDate} av ${cards.length}`);
  if (a.maxPrice !== null) {
    const above = cards.filter((c) => (priceOf(c) ?? 0) > a.maxPrice!).length;
    console.log(`Kort över ${kr(a.maxPrice)} kr trots maxListPrice (A6): ${above}`);
  }
  for (const c of cards.slice(0, 8)) {
    console.log(
      `  ${String(c.title ?? "-")} | ${String(c.displayPrice ?? "-")} | ${String(c.displayDate ?? "-")} | ${statusKeyOf(c) ?? "-"} | ${String(c.url ?? "-")}`,
    );
  }
  // Cards that hint at a price change: a non-empty `labels` list or a `priceRemark` (A3 candidates).
  const hinted = cards.filter((c) => (Array.isArray(c.labels) && c.labels.length > 0) || c.priceRemark);
  console.log(`Kort med etikett eller prisanmärkning: ${hinted.length}`);
  for (const c of hinted.slice(0, 10)) {
    console.log(
      `  ${String(c.title ?? "-")} | ${String(c.displayPrice ?? "-")} | labels ${JSON.stringify(c.labels)} | priceRemark ${JSON.stringify(c.priceRemark)} | ${String(c.url ?? "-")}`,
    );
  }
  if (a.saveMeta !== null) {
    const abs = guardedSavePath(a.saveMeta);
    if (abs === null) throw new Error("Sparsökvägen måste ligga under src/lib/booli/__fixtures__/ eller .planning/calibration/data/");
    if (!tillSalu) throw new Error("Hittade inget till-salu-antal att spara");
    if (cards.length < 3) throw new Error(`Bara ${cards.length} kort på sidan, fixturen behöver minst 3`);
    const fixture = buildMetaFixture(counts, cards);
    const hits = piiValuePaths(fixture.split("\n").filter(Boolean));
    if (hits.length > 0) throw new Error(`Möjliga personuppgifter kvar i fixturen: ${hits.join(", ")}`);
    writeText(abs, fixture);
    console.log(`Sparade sanerad fixtur: ${a.saveMeta}`);
  }
}

/**
 * The completeness run (Phase 14.2, R-04): the same `fetchAreaListings` the weekly run uses,
 * paging until Booli's own till-salu count is reached (at most HEADLESS_MAX_AREA_PAGES pages).
 * An unknown count is reported as incomplete, never as complete.
 */
async function runSearchComplete(a: SearchArgs): Promise<void> {
  const { fetchAreaListings, HEADLESS_MAX_AREA_PAGES } = await import("@/lib/booli/client");
  const result = await fetchAreaListings(a.area, "Lägenhet", {
    maxPages: HEADLESS_MAX_AREA_PAGES,
    ...(a.minArea !== null ? { minLivingArea: a.minArea } : {}),
  });
  const collected = result.listings.length;
  console.log(`Område: ${areaName(a.area)} (${a.area})${a.minArea !== null ? `, minst ${a.minArea} kvm` : ""}`);
  console.log(
    `Fullständighet: ${collected} av ${result.totalCount ?? "okänt"} annonser (${result.pagesFetched} sidor, ${result.complete === true ? "komplett" : "ofullständig"})`,
  );
  if (result.newConstructionCount !== null) {
    console.log(
      `Nyproduktion: Booli räknar ${result.newConstructionCount}, visar ${result.newConstructionCount - result.unlistedProjects} som kort, ${result.unlistedProjects} saknar kort och räknas som hämtade`,
    );
  }
  const withoutPrice = result.listings.map((raw) => toCandidate(raw)).filter((c) => c.price === null).length;
  console.log(`Varav utan pris (snart till salu): ${withoutPrice}`);
}

async function runSearchPlain(a: SearchArgs): Promise<void> {
  const { fetchAreaListings } = await import("@/lib/booli/client");
  const { listings } = await fetchAreaListings(a.area, "Lägenhet", { maxPages: a.pages });
  const candidates = listings.map((raw) => toCandidate(raw));
  console.log(`Område: ${areaName(a.area)} (${a.area})`);
  console.log(`Kandidater: ${candidates.length} från ${a.pages} ${a.pages === 1 ? "sida" : "sidor"}`);
  for (const c of candidates.slice(0, 5)) {
    console.log(`  ${c.address ?? "-"} | ${kr(c.price)} kr | ${c.livingArea ?? "-"} kvm | ${c.sourceListingUrl ?? "-"}`);
  }
}

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

const rawNum = (v: unknown): unknown => (v && typeof v === "object" && "raw" in v ? (v as { raw: unknown }).raw : v);

async function runDetail(a: DetailArgs): Promise<void> {
  const { runPlaywrightRender } = await import("@/lib/booli/transport");
  const items = await runPlaywrightRender(a.url, APOLLO_PAGE_FUNCTION);
  let entity: Record<string, unknown> | null = null;
  for (const item of items) {
    const state = (item as { __APOLLO_STATE__?: Record<string, unknown> }).__APOLLO_STATE__;
    for (const [key, value] of Object.entries(state ?? {})) {
      if (key.startsWith("Listing:") && value && typeof value === "object") {
        entity = value as Record<string, unknown>;
        break;
      }
    }
    if (entity) break;
  }
  if (!entity) throw new Error("Ingen Listing-post i sidan");
  const e = entity;
  const priceInfo = e.priceInfo as { displayPriceChange?: unknown; positivePriceChange?: unknown; label?: unknown } | undefined;
  const crumbs = Array.isArray(e.breadcrumbs) ? (e.breadcrumbs as { url?: string }[]) : [];
  const brfCrumb = crumbs.find((c) => typeof c?.url === "string" && c.url.includes("/bostadsrattsforening/"));
  const sections = Array.isArray(e.infoSections) ? (e.infoSections as { key?: string; content?: { infoPoints?: unknown[] } }[]) : [];
  const coopSection = sections.find((s) => /housingcoop/i.test(String(s?.key ?? "")));
  console.log(`Annons: ${a.url}`);
  console.log(`Nycklar (${Object.keys(e).length}): ${Object.keys(e).sort().join(", ")}`);
  console.log(`tenureForm: ${JSON.stringify(e.tenureForm ?? null)}`);
  console.log(`published: ${JSON.stringify(e.published ?? null)}`);
  console.log(
    `listPriceChange raw: ${JSON.stringify(rawNum(e.listPriceChange) ?? null)} | listPricePercentageDiff raw: ${JSON.stringify(rawNum(e.listPricePercentageDiff) ?? null)} | displayPriceChange: ${JSON.stringify(priceInfo?.displayPriceChange ?? null)} | positivePriceChange: ${JSON.stringify(priceInfo?.positivePriceChange ?? null)} | priceInfo.label: ${JSON.stringify(priceInfo?.label ?? null)}`,
  );
  console.log(`listPrice raw: ${JSON.stringify(rawNum(e.listPrice) ?? null)}`);
  console.log(`biddingOpen: ${JSON.stringify(e.biddingOpen ?? null)}`);
  console.log(`description: ${typeof e.description === "string" && e.description !== "" ? "ja" : "nej"}`);
  console.log(`housingCoopInfo infoPoints: ${coopSection?.content?.infoPoints?.length ?? "ingen sektion"}`);
  console.log(`BRF-länk: ${brfCrumb?.url ?? "ingen"}`);
  if (a.save !== null) {
    const abs = guardedSavePath(a.save);
    if (abs === null) throw new Error("Sparsökvägen måste ligga under src/lib/booli/__fixtures__/ eller .planning/calibration/data/");
    const clean = sanitize(e);
    const hits = piiValuePaths(clean);
    if (hits.length > 0) throw new Error(`Möjliga personuppgifter kvar i fixturen: ${hits.join(", ")}`);
    writeText(abs, `${JSON.stringify(clean, null, 2)}\n`);
    console.log(`Sparade sanerad fixtur: ${a.save}`);
  }
}


// ---------------------------------------------------------------------------
// brf (Phase 14.2, WATCH-03, R-07)
// ---------------------------------------------------------------------------

/** Lines that may name a person or carry a contact detail; never kept. */
const PERSON_LINE = /ordförande|ledamot|suppleant|revisor|styrelse|kontakt|telefon|e-?post|@|\b0\d{1,2}[-\s]?\d{5,}/i;
/** The labels whose value (the next non-empty line) is kept: the economy section only. */
const ECONOMY_LABEL = /^(?:Byggår|Antal bostadsrätter|Antal hyresrätter|Boarea bostadsrätter|Lån|Belåning per kvm|Årsavgift per kvm)$/i;
/** The report-year sentence; only its first sentence is kept. */
const REPORT_YEAR_SENTENCE = /årsredovisning(?:en)?\s+för\s+(?:19|20)\d{2}/i;

/**
 * The page text cut to the economy lines (T-14.2-09): each economy label with the lines up to and
 * including its value, and the first sentence that names the annual-report year. Everything else
 * (menus, explanations, the list of flats, anything that may name a person) is dropped, and a
 * line that looks like a person or a contact detail is never kept.
 */
function economyText(text: string): string {
  const lines = text.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The report-year line also holds a Booli e-mail address further on, so only its first sentence is cut out.
    const sentence = line.match(/^.*?årsredovisning(?:en)?\s+för\s+(?:19|20)\d{2}\.?/i);
    if (sentence && REPORT_YEAR_SENTENCE.test(sentence[0]) && !PERSON_LINE.test(sentence[0])) {
      out.push(sentence[0]);
      continue;
    }
    if (PERSON_LINE.test(line)) continue;
    if (ECONOMY_LABEL.test(line.trim())) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && !PERSON_LINE.test(lines[j]) && !ECONOMY_LABEL.test(lines[j].trim())) {
        out.push(...lines.slice(i, j + 1));
      } else {
        out.push(line); // a label with no value below it (login-gated) stays, as the page shows it
      }
      i = j < lines.length && out[out.length - 1] === lines[j] ? j : i;
    }
  }
  return `${out.join("\n")}\n`;
}

async function runBrf(a: BrfArgs): Promise<void> {
  const { fetchBrfText, parseBrfPage, brfPageUrl } = await import("@/lib/booli/brf-page");
  const text = await fetchBrfText(a.id);
  const f = parseBrfPage(text);
  const missing = [f.loanSek === null ? "Lån" : null, f.areaSqm === null ? "Boarea bostadsrätter" : null].filter(Boolean);
  const k = (n: number | null, unit: string) => (n === null ? "-" : `${kr(n)} ${unit}`);
  console.log(
    `BRF ${a.id}: lån ${k(f.loanSek, "kr")}, boarea ${k(f.areaSqm, "m²")}, skuld/kvm ${k(f.debtPerSqm, "kr")} (årsredovisning ${f.reportYear ?? "-"})${missing.length > 0 ? ` | saknas: ${missing.join(", ")}` : ""}`,
  );
  console.log(`BRF-sida: ${brfPageUrl(a.id)} (${text.length} tecken)`);
  if (a.raw) console.log(text);
  if (a.save !== null) {
    const abs = guardedSavePath(a.save);
    if (abs === null) throw new Error("Sparsökvägen måste ligga under src/lib/booli/__fixtures__/ eller .planning/calibration/data/");
    const trimmed = economyText(text);
    const hits = piiValuePaths(trimmed.split("\n").filter(Boolean));
    if (hits.length > 0) throw new Error(`Möjliga personuppgifter kvar i fixturen: ${hits.join(", ")}`);
    writeText(abs, trimmed);
    console.log(`Sparade kortad sidtext (${trimmed.split("\n").filter(Boolean).length} rader): ${a.save}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.log(USAGE);
    return 1;
  }
  // Dynamic imports keep the browser toolchain out of module load (and out of any other importer).
  const { installLocalRenderer } = await import("@/lib/booli/local-browser");

  const handle = installLocalRenderer(args.mode === "detail" ? { mode: args.browserMode } : {});
  let exitCode = 0;
  try {
    if (args.mode === "brf") {
      await runBrf(args);
    } else if (args.mode === "detail") {
      await runDetail(args);
    } else if (args.complete) {
      await runSearchComplete(args);
    } else if (args.minArea !== null || args.priceDecrease || args.maxPrice !== null || args.saveMeta !== null) {
      await runSearchCapture(args);
    } else {
      await runSearchPlain(args);
    }
  } catch (e) {
    console.error("FEL:", e instanceof Error ? e.message : e);
    exitCode = 1;
  } finally {
    await handle.close();
    const s = handle.stats();
    console.log(
      `Lokal webbläsare: ${s.pages} sidor (${s.challenged} utmaningar från Booli, ${s.challengedBroker} från mäklarsidor, ${s.retried} omförsök, ${s.failed} misslyckade, ${s.refused} vägrade), 0,00 USD`,
    );
    console.log(`Apify-reserv: ${s.apifyFallbacks} renderingar`);
  }
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error("FEL:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  },
);
