/**
 * Free local probe for the local browser rung (Phase 14.2, WATCH-01).
 *
 *   npx tsx scripts/probe-local-booli.ts search --area <areaId> [--pages N]
 *
 * Opens a headed Chromium on this Mac (parked off-screen unless
 * BOOLI_LOCAL_WINDOW=visible), renders N till-salu pages for the area through
 * the SAME `fetchAreaListings` and `toCandidate` the weekly run uses, and prints
 * what it parsed. It never calls Apify and costs nothing: the ledger lines say
 * so, and the Apify fallback is off (no `allowApify`).
 *
 * Later plans extend this CLI with `detail` and `brf` modes.
 *
 * Secret posture: prints no environment values at all.
 */
import { AREA_SEED } from "@/lib/discovery/area-seed";
import { toCandidate } from "@/lib/discovery/candidate";

const USAGE = `Användning:
  npx tsx scripts/probe-local-booli.ts search --area <områdes-id> [--pages N]

  --area <id>   Booli-områdes-id, till exempel 115341 (Södermalm)
  --pages <n>   antal sökresultatsidor, standard 1 (1-5)

Gratis: använder bara den lokala webbläsaren, aldrig Apify.`;

interface Args {
  mode: "search";
  area: string;
  pages: number;
}

function parseArgs(argv: string[]): Args | null {
  const [mode, ...rest] = argv;
  if (mode !== "search") return null;
  let area: string | null = null;
  let pages = 1;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--area" && value !== undefined && /^\d+$/.test(value)) {
      area = value;
      i++;
    } else if (flag === "--pages" && value !== undefined && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 5) {
      pages = Number(value);
      i++;
    } else {
      return null;
    }
  }
  return area === null ? null : { mode, area, pages };
}

function areaName(id: string): string {
  const hit = Object.entries(AREA_SEED).find(([, v]) => v === id);
  return hit ? hit[0].charAt(0).toUpperCase() + hit[0].slice(1) : id;
}

const kr = (n: number | null) => (n === null ? "-" : Math.round(n).toLocaleString("sv-SE"));

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.log(USAGE);
    return 1;
  }
  // Dynamic imports keep the browser toolchain out of module load (and out of any other importer).
  const { installLocalRenderer } = await import("@/lib/booli/local-browser");
  const { fetchAreaListings } = await import("@/lib/booli/client");

  const handle = installLocalRenderer();
  let exitCode = 0;
  try {
    const { listings } = await fetchAreaListings(args.area, "Lägenhet", { maxPages: args.pages });
    const candidates = listings.map((raw) => toCandidate(raw));
    console.log(`Område: ${areaName(args.area)} (${args.area})`);
    console.log(`Kandidater: ${candidates.length} från ${args.pages} ${args.pages === 1 ? "sida" : "sidor"}`);
    for (const c of candidates.slice(0, 5)) {
      console.log(`  ${c.address ?? "-"} | ${kr(c.price)} kr | ${c.livingArea ?? "-"} kvm | ${c.sourceListingUrl ?? "-"}`);
    }
  } catch (e) {
    console.error("FEL:", e instanceof Error ? e.message : e);
    exitCode = 1;
  } finally {
    await handle.close();
    const s = handle.stats();
    console.log(
      `Lokal webbläsare: ${s.pages} sidor (${s.challenged} utmaningar, ${s.retried} omförsök, ${s.failed} misslyckade, ${s.refused} vägrade), 0,00 USD`,
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
