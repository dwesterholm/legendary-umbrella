"use server";

import { createClient } from "@/lib/supabase/server";
import { parseIntent } from "@/lib/discovery/parse-intent";
import {
  CAP_CANDIDATES_MAX,
  CAP_SEK_MAX,
  intentFilterSchema,
  type DiscoveryFilter,
} from "@/lib/discovery/filter-schema";

/**
 * Per-user-per-day discovery job cap (DISC-07 / T-09-09 cost-exhaustion
 * mitigation). A rapid-job-creation loop is the OTHER dimension of the cost
 * DoS surface beyond the per-slice incremental caps enforced in `job.ts` —
 * this bounds how many NEW jobs (each with its own Haiku parse + up to
 * CAP_SEK_MAX SEK of scrape spend) one user can spin up in 24h.
 */
const JOBS_PER_DAY_CAP = 5;

/** Discriminated result returned to the client. */
export type StartDiscoveryResult =
  | { ok: true; jobId: string }
  | { ok: false; error: string; needsConfirmation?: true; filter?: DiscoveryFilter };

/**
 * `startDiscovery` — the flag-first (DISC-07 / T-09-08), auth-gated,
 * per-day-capped (T-09-09) Server Action that turns a free-text search into a
 * pending `discovery_jobs` row.
 *
 * ORDER IS LOAD-BEARING (09-RESEARCH.md Pitfall 5): the feature-flag check is
 * the LITERAL FIRST LINE, before auth/parse/insert are ever reached — a
 * direct curl/devtools call must fail closed even with the UI hidden. Only
 * `process.env.DISCOVERY_ENABLED` (server-only, never `NEXT_PUBLIC_`) is
 * read; the client can never influence this check.
 *
 * @param formData - `free_text` (required) plus optional hard-filter overrides
 */
export async function startDiscovery(
  formData: FormData,
): Promise<StartDiscoveryResult> {
  // LITERAL FIRST LINE — fail closed before auth, parse, or any DB access
  // (T-09-08). This is the legal "OFF by default" gate; the UI hiding the
  // entry point is a UX nicety, NOT the security boundary.
  if (process.env.DISCOVERY_ENABLED !== "true") {
    return { ok: false, error: "Funktionen är inte tillgänglig." };
  }

  const freeTextRaw = formData.get("free_text");
  const freeText = typeof freeTextRaw === "string" ? freeTextRaw.trim() : "";
  if (!freeText) {
    return { ok: false, error: "Beskriv vad du letar efter." };
  }

  // Auth gate (mirrors generate-report.ts / analyze-brf.ts — no guest path).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Logga in för att söka." };
  }

  // The Haiku free-text→filter parse (DISC-01). Free text is sent as
  // user-message content only inside parseIntent — never re-concatenated here.
  let parseResult;
  try {
    parseResult = await parseIntent(freeText);
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";
    console.error("[startDiscovery] parseIntent failed", { userId: user.id, code });
    return { ok: false, error: "Vi kunde inte tolka din sökning. Försök igen." };
  }

  if (!parseResult.ok) {
    // Low-confidence fail-safe: surface the parse for a "stämmer detta?"
    // confirmation — NO job is created yet.
    return {
      ok: false,
      error: "Vi är inte säkra på att vi tolkade sökningen rätt.",
      needsConfirmation: true,
      filter: parseResult.filter,
    };
  }

  // Merge explicit hard-filter FormData overrides on top of the parsed
  // filter — explicit user filters win over the Haiku-inferred defaults.
  const mergedFilter: DiscoveryFilter = { ...parseResult.filter };
  const areaQueryOverride = formData.get("areaQuery");
  if (typeof areaQueryOverride === "string" && areaQueryOverride.trim() !== "") {
    // The UI's "Område" <Select> is seeded exactly from AREA_SEED's keys —
    // the one input in the whole UI guaranteed resolvable via seedResolve.
    // An explicit dropdown pick must win over whatever (possibly wrong or
    // empty) areaQuery Haiku inferred from the free text (CR-03).
    mergedFilter.areaQuery = areaQueryOverride.trim();
  }
  // WR-05 (shard-1 review): these are untrusted client inputs (form/curl), so
  // a bare `Number.isFinite` accepts a negative/zero priceMax — which makes
  // `filterCandidates` reject every candidate (`price > -1` is always true),
  // silently yielding an empty, undiagnosable result set. Require positive
  // values, mirroring the Zod-validated discipline applied to `objectType`.
  const priceMaxOverride = formData.get("priceMax");
  if (typeof priceMaxOverride === "string" && priceMaxOverride.trim() !== "") {
    const n = Number(priceMaxOverride);
    if (Number.isFinite(n) && n > 0) mergedFilter.priceMax = n;
  }
  const roomsMinOverride = formData.get("roomsMin");
  if (typeof roomsMinOverride === "string" && roomsMinOverride.trim() !== "") {
    const n = Number(roomsMinOverride);
    if (Number.isFinite(n) && n > 0) mergedFilter.roomsMin = n;
  }
  const sizeMinOverride = formData.get("sizeMin");
  if (typeof sizeMinOverride === "string" && sizeMinOverride.trim() !== "") {
    const n = Number(sizeMinOverride);
    if (Number.isFinite(n) && n > 0) mergedFilter.sizeMin = n;
  }
  const objectTypeOverride = formData.get("objectType");
  if (typeof objectTypeOverride === "string" && objectTypeOverride.trim() !== "") {
    // Validate through the actual Zod enum instead of a bare `as` assertion
    // (WR-02) — an invalid override is silently ignored (falls back to the
    // Haiku-parsed value) rather than persisting an out-of-enum string.
    const parsed = intentFilterSchema.shape.objectType.safeParse(
      objectTypeOverride.trim(),
    );
    if (parsed.success) {
      mergedFilter.objectType = parsed.data;
    }
  }

  // Per-user-per-day job cap (T-09-09) + the insert itself, folded into ONE
  // atomic RPC (WR-01) — replaces the old count-then-insert, which raced
  // under concurrent calls (two tabs / a double-click / a scripted burst
  // could both read `count < 5` before either had inserted). The RPC
  // serializes concurrent callers for the SAME user via an advisory lock
  // and always derives the owner from auth.uid() server-side, never from a
  // caller-supplied value (see 011_claim_slice_ownership.sql).
  const { data: rpcRows, error: rpcError } = await supabase.rpc(
    "insert_discovery_job_if_under_cap",
    {
      p_free_text: freeText,
      p_filters: mergedFilter,
      p_cap_candidates: CAP_CANDIDATES_MAX,
      p_cap_sek: CAP_SEK_MAX,
      p_jobs_per_day_cap: JOBS_PER_DAY_CAP,
    },
  );

  if (rpcError) {
    console.error("[startDiscovery] insert_discovery_job_if_under_cap failed", {
      userId: user.id,
      code: rpcError.code,
    });
    return { ok: false, error: "Kunde inte starta sökningen just nu. Försök igen senare." };
  }

  const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  if (!result) {
    console.error("[startDiscovery] insert_discovery_job_if_under_cap returned no row", {
      userId: user.id,
    });
    return { ok: false, error: "Kunde inte starta sökningen. Försök igen." };
  }
  if (result.capped) {
    return {
      ok: false,
      error: "Du har nått dagens gräns för nya sökningar. Försök igen imorgon.",
    };
  }
  if (!result.id) {
    console.error("[startDiscovery] insert_discovery_job_if_under_cap returned no id", {
      userId: user.id,
    });
    return { ok: false, error: "Kunde inte starta sökningen. Försök igen." };
  }

  return { ok: true, jobId: result.id as string };
}
