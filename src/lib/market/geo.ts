import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";

/**
 * AREA-01 deterministic geo resolution (D-06).
 *
 * `resolveGeo` maps a listing's lat/lng to SCB geography via point-in-polygon
 * against the build-time-converted SCB DeSO_2025 polygons (src/data/deso.geojson,
 * sourced once from geodata.scb.se WFS, reprojected to WGS84 and simplified —
 * see 03-03-SUMMARY.md). It is a PURE function (mirrors src/lib/brf/score.ts):
 * no fetch, no Date, no Math.random — same input → same output, so geo.test.ts
 * can exercise it offline against the committed artifact.
 *
 * Geo level achieved this phase: **DeSO (neighborhood)** — the D-06 upgrade,
 * not the kommun-only fallback. kommunCode is always derivable as the first 4
 * chars of a resolved DeSO code (RESEARCH Pitfall 2: DeSO shape is
 * `{4-digit kommun}{letter}{4-digit}`, e.g. "0180C1010" → kommun "0180").
 */

// Each DeSO feature carries `desokod` (full DeSO code) + `kommunkod` (4-digit).
interface DesoProperties {
  desokod: string;
  kommunkod: string;
}

type DesoFeature = Feature<Polygon | MultiPolygon, DesoProperties>;

// The committed SCB DeSO polygons. Read once at module init via fs (not a
// bundler JSON import) — the artifact is ~5 MB, server-side only, and reading
// it as a file keeps it out of any client bundle while staying deterministic.
// __dirname is unavailable under ESM, so derive the module dir defensively and
// resolve the repo-root-relative artifact path from it.
function loadDeso(): DesoFeature[] {
  // Resolve the artifact robustly across runtimes. Under `next dev`/`next start`
  // the server module is bundled, so `import.meta.url` is NOT the source path and
  // the module-relative resolve points at a non-existent bundle path → throws →
  // an empty DeSO set → every point resolves to null (the AREA-null bug). The
  // process CWD is the project root under Next (dev + start), so resolve from
  // there FIRST, then fall back to the module-relative path (which is correct
  // under vitest/tsx running straight from source).
  const candidates: string[] = [path.join(process.cwd(), "src/data/deso.geojson")];
  try {
    // ESM
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(moduleDir, "../../data/deso.geojson"));
  } catch {
    // CJS / transpiled fallback
    candidates.push(path.resolve(__dirname, "../../data/deso.geojson"));
  }

  let lastError: unknown = null;
  for (const artifactPath of candidates) {
    try {
      const raw = readFileSync(artifactPath, "utf8");
      const fc = JSON.parse(raw) as FeatureCollection<
        Polygon | MultiPolygon,
        DesoProperties
      >;
      return fc.features;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("deso.geojson not found in any candidate path");
}

let desoFeatures: DesoFeature[] | null = null;
function getDesoFeatures(): DesoFeature[] {
  if (desoFeatures === null) {
    try {
      desoFeatures = loadDeso();
    } catch {
      // If the artifact cannot be read, degrade to an empty set rather than
      // crashing — resolveGeo then returns the documented null result (D-06).
      desoFeatures = [];
    }
  }
  return desoFeatures;
}

export interface ResolvedGeo {
  /** 4-digit SCB kommun code (e.g. "0180"); null only when no polygon matched. */
  kommunCode: string | null;
  /** Full SCB DeSO code (e.g. "0180C1010"); null when the point is outside all polygons. */
  desoCode: string | null;
}

/**
 * Resolve a WGS84 lat/lng to its SCB DeSO + kommun codes.
 *
 * - Inside a DeSO polygon → that polygon's `desokod`; kommunCode = first 4 chars
 *   (RESEARCH Pitfall 2). kommunkod from the feature is used as a cross-check.
 * - Outside all polygons (e.g. mid-ocean) → desoCode null, kommunCode null.
 *   Never throws (D-06/D-08: "kommun-correct beats neighborhood-wrong" — the
 *   caller decides the degrade; this pure resolver just reports what it found).
 */
export function resolveGeo(lat: number, lng: number): ResolvedGeo {
  // GeoJSON coordinate order is [lng, lat].
  const pt = point([lng, lat]);
  const features = getDesoFeatures();

  for (const feature of features) {
    try {
      if (booleanPointInPolygon(pt, feature)) {
        const desoCode = feature.properties.desokod ?? null;
        if (typeof desoCode === "string" && desoCode.length >= 4) {
          return { desoCode, kommunCode: desoCode.slice(0, 4) };
        }
        // Polygon hit but malformed code — fall back to the feature's kommunkod.
        const kommunCode = feature.properties.kommunkod ?? null;
        return { desoCode: null, kommunCode: kommunCode ?? null };
      }
    } catch {
      // A single malformed polygon must not abort the scan.
    }
  }

  // No polygon contained the point — no SCB geography derivable from coords alone.
  return { desoCode: null, kommunCode: null };
}
