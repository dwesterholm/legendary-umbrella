/**
 * Headless renovation-object search for Stockholm innerstan, using the app's
 * own pipeline modules directly (no login, no job row, no vision/BRF spend).
 */
import { createClient } from "@supabase/supabase-js";
import { splitAreaQuery, resolveArea } from "@/lib/discovery/resolve-area";
import { seedResolve } from "@/lib/discovery/area-seed";
import { fetchAreaListings } from "@/lib/booli/client";
import { toCandidate, filterCandidates, type DiscoveryCandidate } from "@/lib/discovery/candidate";
import { computeNicheScore } from "@/lib/discovery/niche-score";
import type { DiscoveryFilter } from "@/lib/discovery/filter-schema";

const PRICE_MAX = 4_000_000;
const SIZE_MIN = 30;
const SIZE_HIGHLIGHT_MAX = 45;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function dedupe(cs: DiscoveryCandidate[]): DiscoveryCandidate[] {
  const seen = new Set<string>();
  return cs.filter((c) => {
    const k = c.sourceListingUrl ?? `${c.address}|${c.price}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
const sek = (n: number) => Math.round(n).toLocaleString("sv-SE");

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );

  // 1. Expand the umbrella term exactly as the app does now.
  const names = splitAreaQuery("innerstan (innanför tullarna)");
  console.log(`Områden: ${names.join(", ")}`);

  // 2. Resolve — seed first (free), live probe only for what the seed lacks.
  const areas: { name: string; areaId: string; source: string }[] = [];
  for (const name of names) {
    const seeded = seedResolve(name);
    if (seeded) { areas.push({ name, areaId: seeded, source: "seed" }); continue; }
    const r = await resolveArea(name, supabase as never);
    if (r) areas.push({ name, areaId: r.areaId, source: r.source });
    else console.log(`  ✗ ${name}: kunde inte resolvas — hoppar över`);
  }
  for (const a of areas) console.log(`  ✓ ${a.name} → areaId ${a.areaId} (${a.source})`);

  // 3. Scrape each area (the app's own client: Apify Playwright, RESIDENTIAL/SE).
  let renders = 0;
  const raw: Record<string, unknown>[] = [];
  const results = await Promise.allSettled(areas.map((a) => fetchAreaListings(a.areaId, "Lägenhet")));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      renders += r.value.rendersUsed;
      raw.push(...r.value.listings);
      console.log(`  ${areas[i].name}: ${r.value.listings.length} annonser (${r.value.rendersUsed} renders)`);
    } else {
      console.log(`  ${areas[i].name}: MISSLYCKADES — ${(r.reason as Error)?.message ?? r.reason}`);
    }
  });

  // 4. Same deterministic filter the app applies.
  const all = dedupe(raw.map(toCandidate));
  const filter: DiscoveryFilter = {
    areaQuery: names.join(" och "),
    priceMax: PRICE_MAX,
    roomsMin: null,
    sizeMin: SIZE_MIN,
    objectType: "Lägenhet",
    confidence: 1,
  };
  const { shown } = filterCandidates(all, filter, 200);

  // 5. Rank by the app's renovation-upside niche (below-market kr/m² + age).
  const ppsqm = shown
    .map((c) => (c.price && c.livingArea ? c.price / c.livingArea : null))
    .filter((v): v is number => v !== null);
  const baseline = { medianPricePerSqm: median(ppsqm) };
  const ranked = shown
    .map((c) => ({ c, score: computeNicheScore(c, "renovation-upside", baseline) }))
    .sort((a, b) => b.score.score - a.score.score);

  console.log(`\nTotalt ${all.length} annonser → ${shown.length} matchar (≤${sek(PRICE_MAX)} kr, ≥${SIZE_MIN} kvm, lägenhet). Renders: ${renders}. Median kr/kvm: ${baseline.medianPricePerSqm ? sek(baseline.medianPricePerSqm) : "—"}\n`);
  console.log("#  | Adress | Område | Pris | kvm | kr/kvm | Byggår | Poäng | Signaler | Länk");
  ranked.slice(0, 30).forEach(({ c, score }, i) => {
    const pp = c.price && c.livingArea ? sek(c.price / c.livingArea) : "—";
    const small = c.livingArea && c.livingArea <= SIZE_HIGHLIGHT_MAX ? "★" : " ";
    const sig = score.breakdown.filter((b) => b.assessable).map((b) => b.key).join(",");
    console.log(`${String(i + 1).padStart(2)} | ${small}${c.address ?? "?"} | ${c.areaLabel ?? "?"} | ${c.price ? sek(c.price) : "?"} | ${c.livingArea ?? "?"} | ${pp} | ${c.constructionYear ?? "?"} | ${score.score.toFixed(2)} | ${sig} | ${c.sourceListingUrl ?? ""}`);
  });
  console.log(`\n★ = ≤${SIZE_HIGHLIGHT_MAX} kvm (din tidigare storleksram 30–45).`);
}
main().catch((e) => { console.error("FEL:", e?.message ?? e); process.exit(1); });
