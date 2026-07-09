"use client";

import { Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SunPathExposure } from "@/components/sun-path-exposure";
import type { VisionConditionClaim, VisionResult } from "@/lib/discovery/vision-schema";
import type { Facade } from "@/lib/discovery/sun-path";

interface GalleryConditionVisionProps {
  /** Persisted per-candidate vision result — `null` when vision has not run
   *  (see `visionSkippedReason` for WHY) or has not yet been wired up. */
  vision: VisionResult | null;
  /** WHY vision did not run — distinct from `vision === null` due to
   *  suppression (see the "vision ran but claims empty" branch below).
   *  CR-02 (11-REVIEW.md): "vision_error" is a per-candidate Claude call
   *  failure that degrades ONLY this candidate — the job's other candidates
   *  and its scraped results are unaffected. */
  visionSkippedReason: "no_images" | "cost_cap" | "vision_error" | null;
  /** Sun-path inputs (DISC-06) — deliberately NOT vision-derived; passed
   *  through to the embedded `SunPathExposure` sub-block ONLY. Never fed
   *  into `computeNicheScore`/`ReportFlags` (structural-separation
   *  invariant, extended alongside vision in niche-score.test.ts). */
  latitude: number | null;
  longitude: number | null;
  floor: number | null;
  orientation: { facades: Facade[]; confidence: number } | null;
}

/**
 * Attribute label per UI-SPEC Component Inventory §2 ("KÖK"/"BADRUM"/
 * "ALLMÄNT SKICK"/"PLANLÖSNING"). `remodelPotential` (floor-plan claims)
 * renders in the SAME flat claims list via this label, same row shell, same
 * Eye/terracotta identity, same citation pattern (cited image is the
 * floor-plan image, already ordered first by `extractImageUrls`) — no
 * visual fork (DISC-05, Plan 04/12-04).
 */
const ATTRIBUTE_LABELS: Record<VisionConditionClaim["attribute"], string> = {
  kitchen: "KÖK",
  bathroom: "BADRUM",
  overall: "ALLMÄNT SKICK",
  remodelPotential: "PLANLÖSNING",
};

/**
 * `GalleryConditionVision` — the read-only "AI-bedömning av bilder" section
 * (DISC-04, 11-UI-SPEC.md). Renders its OWN Eye-icon/terracotta-identity
 * `Card`, deliberately distinct from `ReportFlags`' severity-chip/sage
 * vocabulary (see UI-SPEC Color rationale) — a buyer must be able to tell
 * "image-interpreted" from "verified" at a glance.
 *
 * Reads `DiscoveryCandidate.vision`/`visionSkippedReason` DIRECTLY (mirrors
 * `ReportFlags`' direct-props-read simplicity) — no transform layer.
 *
 * Five distinct content states (never a silently absent section):
 *   1. `visionSkippedReason === "no_images"` — no gallery existed.
 *   2. `visionSkippedReason === "cost_cap"` — vision was skipped (spend cap).
 *   3. `visionSkippedReason === "vision_error"` — the Claude call for THIS
 *      candidate failed (CR-02, 11-REVIEW.md); other candidates are unaffected.
 *   4. `vision` has claims — one row per claim, image-cited + hedged. When
 *      ≥1 claim is `remodelPotential`, an ADDITIONAL section-level
 *      reinforcement disclaimer renders once below the claims list
 *      (DISC-05, UI-SPEC Copywriting Contract) — distinct from and in
 *      addition to the general "Kan vara fel" closing disclaimer below.
 *   5. `vision` ran but every claim was suppressed (empty claims array) —
 *      "too uncertain to show."
 *
 * Also ALWAYS embeds `SunPathExposure` (DISC-06) inside this SAME
 * `CardContent`, after the claims list/disclaimers — a `Compass`/warm-gray
 * COMPUTED sub-block, deliberately distinct from the Eye/terracotta vision
 * identity above (sun-path is exact `suncalc` trigonometry, not an AI
 * interpretation of a photo). Renders independently of `visionSkippedReason`
 * (sun-path is NOT a vision output) — degrades to "ej tillgänglig" on its
 * own missing-floor/orientation precondition, never gated by vision state.
 *
 * NEVER passed into `computeNicheScore`/`ReportFlags` — neither the vision
 * claims NOR the sun-path inputs. This component's output is purely
 * presentational and structurally separate from the deterministic scorer
 * (see `niche-score.test.ts`'s structural-separation invariant test, which
 * forbids a `vision`/`vision-schema`/`sun-path` import in `niche-score.ts`/
 * `flags.ts`).
 */
export function GalleryConditionVision({
  vision,
  visionSkippedReason,
  latitude,
  longitude,
  floor,
  orientation,
}: GalleryConditionVisionProps) {
  const claims = vision?.claims ?? [];
  const hasClaims = claims.length > 0;
  const visionRanButEmpty = vision !== null && !hasClaims;
  const hasRemodelPotentialClaim = claims.some(
    (claim) => claim.attribute === "remodelPotential",
  );

  return (
    <Card className="border-warm-gray-200 bg-warm-white">
      <CardHeader className="gap-2 pb-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-terracotta-50">
            <Eye className="h-4 w-4 text-terracotta-600" />
          </div>
          <CardTitle className="text-base font-semibold text-warm-gray-900">
            AI-bedömning av bilder — kan vara fel
          </CardTitle>
        </div>
        <p className="text-sm text-warm-gray-500">
          Tolkat från bilder i annonsen — inte en verifierad uppgift. Kontrollera
          själv innan du drar slutsatser.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {visionSkippedReason === "no_images" && (
          <p className="text-sm italic text-warm-gray-500">
            Inga bilder tillgängliga för den här annonsen — ingen bildbedömning
            kunde göras.
          </p>
        )}

        {visionSkippedReason === "cost_cap" && (
          <p className="text-sm italic text-warm-gray-500">
            Bildbedömning kördes inte för den här annonsen (sökgränsen för
            bildanalys nåddes).
          </p>
        )}

        {visionSkippedReason === "vision_error" && (
          <p className="text-sm italic text-warm-gray-500">
            Bildbedömning kunde inte genomföras för den här annonsen just nu.
          </p>
        )}

        {visionSkippedReason === null && visionRanButEmpty && (
          <p className="text-sm italic text-warm-gray-500">
            För osäkert för att visa — inga bildbaserade slutsatser kunde dras
            med rimlig säkerhet.
          </p>
        )}

        {visionSkippedReason === null && hasClaims && (
          <>
            <ul className="space-y-2">
              {claims.map((claim) => {
                // WR-04 (shard-5 review): a claim's citation index must be a
                // positive integer to render "Bild N" at all — the sentinel 0
                // (or a fractional/negative value) would otherwise render a
                // nonsensical "Bild 0" citation, so omit the citation column
                // entirely for those. A valid index whose thumbnail URL can't be
                // resolved (out of the read-path-filtered imageUrlsUsed array)
                // still shows the "Bild N" TEXT label — never a broken <img>.
                const usedCount = vision?.imageUrlsUsed.length ?? 0;
                const validCitation =
                  Number.isInteger(claim.imageIndex) && claim.imageIndex >= 1;
                const thumbnailUrl =
                  validCitation && claim.imageIndex <= usedCount
                    ? vision?.imageUrlsUsed[claim.imageIndex - 1]
                    : undefined;
                return (
                  <li
                    key={`${claim.attribute}-${claim.imageIndex}`}
                    className="flex items-start gap-3 rounded-lg border border-warm-gray-100 bg-warm-white p-3"
                  >
                    {validCitation && (
                      <div className="flex shrink-0 flex-col items-center gap-1">
                        {thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={thumbnailUrl}
                            alt={`Bild ${claim.imageIndex}`}
                            className="h-12 w-12 rounded-md object-cover"
                          />
                        ) : (
                          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-warm-gray-50">
                            <span className="text-xs text-warm-gray-500">
                              Bild {claim.imageIndex}
                            </span>
                          </div>
                        )}
                        {thumbnailUrl && (
                          <span className="text-xs text-warm-gray-500">
                            Bild {claim.imageIndex}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="space-y-1">
                      <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
                        {ATTRIBUTE_LABELS[claim.attribute]}
                      </p>
                      <p className="text-sm text-warm-gray-700">{claim.claim}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
            {hasRemodelPotentialClaim && (
              <p className="text-xs text-warm-gray-500">
                Observationerna ovan är AI:ns tolkning av en 2D-planritning —
                inte en bedömning av bärande konstruktion. Kontakta alltid en
                konstruktör innan du river eller flyttar en vägg.
              </p>
            )}
            <p className="text-xs text-warm-gray-500">
              Kan vara fel — dessa bedömningar är AI:ns tolkning av bilder, inte
              en besiktning.
            </p>
          </>
        )}

        <SunPathExposure
          latitude={latitude}
          longitude={longitude}
          floor={floor}
          orientation={orientation}
        />
      </CardContent>
    </Card>
  );
}
