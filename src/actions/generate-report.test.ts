import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Deterministic test for the `generateReport` server action (Plan 04-04).
 *
 * NO live Anthropic key and NO real Supabase: both the Supabase client
 * (`@/lib/supabase/server`) and the single Sonnet synthesis call
 * (`@/lib/report/synthesize`) are mocked. The deterministic flag/fact-sheet
 * primitives (`flags.ts`, `fact-sheet.ts`) run for real — they are pure.
 *
 * Covers the Task-1 behaviors: D-09 login gate, IDOR ownership, the
 * 'generating'→'done'/'failed' status flow + in-flight lock, the Sonnet-rated
 * cost cap, partial-data (ej_tillgänglig) assembly, and the sha256
 * report_data_fingerprint persist.
 */

// ---- Mock the Anthropic-backed synthesis call (no live key) ----------------
const synthesizeReport = vi.fn();
vi.mock("@/lib/report/synthesize", () => ({
  synthesizeReport: (...args: unknown[]) => synthesizeReport(...args),
}));

// ---- Mock the Supabase server client ---------------------------------------
// A tiny chainable fake: createClient() → { auth.getUser, from().select().eq().single, from().update().eq }
let mockUser: { id: string } | null;
let mockRow: Record<string, unknown> | null;
let mockRowError: { code: string } | null;
/** Every `.update({...}).eq(...)` payload, in order — the status-flow probe. */
let updates: Array<Record<string, unknown>>;
/** Forces the next persist `.update().eq()` to report a DB error. */
let persistError: { code: string } | null;
/** Forces the atomic lock-acquire CAS (`.select().maybeSingle()`) to error. */
let lockError: { code: string } | null;

/**
 * Builds a chainable, awaitable fake for `.update(payload)...`. WR-01 made the
 * lock acquire an atomic CAS: `update().eq().neq().select().maybeSingle()`. The
 * chain mirrors that — every `eq`/`neq`/`select` returns the same chainable; the
 * chain is thenable (resolves to `{ error }` for the directly-awaited terminal
 * writes), and `maybeSingle()` resolves the CAS result (a row when the lock is
 * free, null when a fresh `generating` lock is held — the no-double-spend path).
 */
function updateChain(payload: Record<string, unknown>) {
  updates.push(payload);
  // Resolved value for a directly-awaited chain (writeFailedStatus / persist).
  const awaited = {
    error:
      payload.report_status === "done"
        ? persistError
        : null,
  };
  const chain: Record<string, unknown> = {
    eq: () => chain,
    neq: () => chain,
    or: () => chain,
    is: () => chain,
    select: () => chain,
    maybeSingle: async () => {
      // The CAS acquire (status -> generating WITH a started_at timestamp).
      // It fails closed on lockError; otherwise the acquire succeeds (returns a
      // row). A FRESH concurrent lock is refused by the action's up-front guard
      // BEFORE the CAS is ever reached, so this acquire is only reached when the
      // row is genuinely acquirable (not-generating or a reclaimed stale lock).
      if (
        payload.report_status === "generating" &&
        "report_generating_started_at" in payload
      ) {
        if (lockError) return { data: null, error: lockError };
        return { data: { id: "a1" }, error: null };
      }
      return { data: null, error: null };
    },
    then: (resolve: (v: typeof awaited) => unknown) => resolve(awaited),
  };
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: mockRow, error: mockRowError }),
        }),
      }),
      update: (payload: Record<string, unknown>) => updateChain(payload),
    }),
  }),
}));

import { generateReport } from "@/actions/generate-report";

/** A minimally-valid AiReport the mocked synthesis returns. */
function fakeReport() {
  return {
    leadSynthesis: "Syntes.",
    ekonomi: { status: "bedömd" as const, claims: [] },
    pris: { status: "ej_tillgänglig" as const, claims: [] },
    omrade: { status: "ej_tillgänglig" as const, claims: [] },
    prioritizedFlagIds: [],
  };
}

/** A small usage that costs well under the 5 SEK cap at Sonnet rates. */
const CHEAP_USAGE = { input_tokens: 2000, output_tokens: 800 };
/** A usage whose Sonnet cost exceeds 5 SEK (output dominates at $15/MTok). */
const EXPENSIVE_USAGE = { input_tokens: 500_000, output_tokens: 100_000 };

/** A valid persisted brf_data row shape (drives a real flag). */
function brfDataRow() {
  const field = (value: unknown) => ({
    value,
    confidence: 0.9,
    sourceQuote: "citat",
    pageRef: 1,
  });
  return {
    extraction: {
      skuldPerKvm: field(20000), // > weakMax → high-debt red flag
      avgiftsniva: field(600),
      kassaflode: field(300),
      underhallsplanStatus: field("finns_aktuell"),
      stambytePlanerat: field("ej_nämnt"),
      storreRenoveringar: field(null),
      ovrigaAnmarkningar: field(null),
    },
    normalized: {
      skuldPerKvm: 20000,
      avgiftsniva: 600,
      kassaflode: 300,
      underhallsplanStatus: "finns_aktuell",
      stambytePlanerat: "ej_nämnt",
      storreRenoveringar: null,
      ovrigaAnmarkningar: null,
    },
    grade: { grade: "C", breakdown: [] },
    perFieldConfidence: { skuldPerKvm: 0.9 },
    citations: [],
  };
}

beforeEach(() => {
  synthesizeReport.mockReset();
  mockUser = { id: "user-1" };
  mockRow = { id: "a1", user_id: "user-1", listing_data: null, brf_data: null, price_data: null, area_data: null };
  mockRowError = null;
  updates = [];
  persistError = null;
  lockError = null;
});

describe("generateReport — module surface", () => {
  it("exports the generateReport server action", () => {
    expect(typeof generateReport).toBe("function");
  });
});

describe("generateReport — auth gate (D-09)", () => {
  it("returns the Swedish login error for an unauthenticated user and never calls Sonnet", async () => {
    mockUser = null;
    const result = await generateReport("a1");
    expect(result).toEqual({ ok: false, error: "Logga in för AI-rapport" });
    expect(synthesizeReport).not.toHaveBeenCalled();
  });
});

describe("generateReport — ownership / IDOR (T-04-13)", () => {
  it("returns 'hittades inte' when the row belongs to another user and never calls Sonnet", async () => {
    mockRow = { id: "a1", user_id: "someone-else" };
    const result = await generateReport("a1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/hittades inte/i);
    expect(synthesizeReport).not.toHaveBeenCalled();
  });

  it("returns 'hittades inte' when the row is missing", async () => {
    mockRow = null;
    mockRowError = { code: "PGRST116" };
    const result = await generateReport("a1");
    expect(result.ok).toBe(false);
    expect(synthesizeReport).not.toHaveBeenCalled();
  });
});

describe("generateReport — status flow + in-flight lock (T-04-14)", () => {
  it("writes 'generating' BEFORE synthesize and 'done' AFTER success", async () => {
    synthesizeReport.mockResolvedValue({ parsed: fakeReport(), usage: CHEAP_USAGE });
    const result = await generateReport("a1");
    expect(result.ok).toBe(true);

    // generating must be the first status write, before the synthesize call,
    // and done must come after.
    const statuses = updates
      .map((u) => u.report_status)
      .filter((s): s is string => typeof s === "string");
    expect(statuses[0]).toBe("generating");
    expect(statuses).toContain("done");
    expect(synthesizeReport).toHaveBeenCalledTimes(1);
  });

  it("short-circuits without a second Sonnet call when the row is already 'generating' (no double-spend, WR-01)", async () => {
    // A FRESH lock (timestamp = now) → a live concurrent run holds it.
    mockRow = {
      ...(mockRow as object),
      report_status: "generating",
      report_generating_started_at: new Date().toISOString(),
    };
    const result = await generateReport("a1");
    expect(result.ok).toBe(false);
    expect(synthesizeReport).not.toHaveBeenCalled();
  });

  it("fails closed (never spends on Sonnet) when the atomic lock-acquire write errors (WR-01)", async () => {
    lockError = { code: "XX000" };
    const result = await generateReport("a1");
    expect(result.ok).toBe(false);
    expect(synthesizeReport).not.toHaveBeenCalled();
  });

  it("reclaims a STALE 'generating' lock and re-generates (WR-05)", async () => {
    // A 'generating' row whose lock is older than the stale window → presumed
    // dead. The CAS acquire must succeed and the report regenerate to 'done'.
    synthesizeReport.mockResolvedValue({ parsed: fakeReport(), usage: CHEAP_USAGE });
    mockRow = {
      ...(mockRow as object),
      report_status: "generating",
      report_generating_started_at: new Date(
        Date.now() - 60 * 60 * 1000,
      ).toISOString(),
    };
    const result = await generateReport("a1");
    expect(result.ok).toBe(true);
    expect(synthesizeReport).toHaveBeenCalledTimes(1);
    const statuses = updates.map((u) => u.report_status);
    expect(statuses).toContain("done");
  });

  it("reclaims a wedged 'generating' lock with a NULL start-time and re-generates", async () => {
    // A row pinned at 'generating' with report_generating_started_at = null (e.g.
    // set before migration 005 added the column) is otherwise PERMANENTLY wedged:
    // the reclaim must use `.is(null)`, not `.eq(null)`, or it never clears and
    // every call returns "genereras redan" (survives reloads / elapsed time).
    // NOTE: this mock cannot simulate PostgREST's null-matching semantics (both
    // .eq and .is just return the chain), so this guards the null BRANCH + happy
    // path; the .eq-vs-.is correctness itself rests on PostgREST behaviour.
    synthesizeReport.mockResolvedValue({ parsed: fakeReport(), usage: CHEAP_USAGE });
    mockRow = {
      ...(mockRow as object),
      report_status: "generating",
      report_generating_started_at: null,
    };
    const result = await generateReport("a1");
    expect(result.ok).toBe(true);
    expect(synthesizeReport).toHaveBeenCalledTimes(1);
    expect(updates.map((u) => u.report_status)).toContain("done");
  });

  it("writes 'failed' (not 'done') when synthesize throws a coded error", async () => {
    synthesizeReport.mockRejectedValue(new Error("CLAUDE_REFUSAL"));
    const result = await generateReport("a1");
    expect(result.ok).toBe(false);
    const statuses = updates.map((u) => u.report_status);
    expect(statuses).toContain("failed");
    expect(statuses).not.toContain("done");
  });
});

describe("generateReport — Sonnet cost cap (T-04-16)", () => {
  it("aborts and writes 'failed' WITHOUT persisting report_data when Sonnet cost > 5 SEK", async () => {
    synthesizeReport.mockResolvedValue({ parsed: fakeReport(), usage: EXPENSIVE_USAGE });
    const result = await generateReport("a1");
    expect(result.ok).toBe(false);

    const statuses = updates.map((u) => u.report_status);
    expect(statuses).toContain("failed");
    expect(statuses).not.toContain("done");
    // No persist write carried report_data.
    expect(updates.every((u) => !("report_data" in u))).toBe(true);
  });
});

describe("generateReport — partial data (D-07)", () => {
  it("assembles and synthesizes even when a source (brf) is null — does not throw", async () => {
    synthesizeReport.mockResolvedValue({ parsed: fakeReport(), usage: CHEAP_USAGE });
    mockRow = { id: "a1", user_id: "user-1", listing_data: null, brf_data: null, price_data: null, area_data: null };
    const result = await generateReport("a1");
    expect(result.ok).toBe(true);
    expect(synthesizeReport).toHaveBeenCalledTimes(1);
    // The fact sheet handed to synthesize marks the missing source honestly.
    const factSheet = synthesizeReport.mock.calls[0][0].factSheet as string;
    expect(factSheet).toContain("ej_tillgänglig");
  });
});

describe("generateReport — fingerprint persist (D-08)", () => {
  it("persists a sha256 report_data_fingerprint over the fact sheet on success", async () => {
    synthesizeReport.mockResolvedValue({ parsed: fakeReport(), usage: CHEAP_USAGE });
    mockRow = { ...(mockRow as object), brf_data: brfDataRow() };
    const result = await generateReport("a1");
    expect(result.ok).toBe(true);

    const persist = updates.find((u) => u.report_status === "done");
    expect(persist).toBeDefined();
    const fp = persist?.report_data_fingerprint;
    // 64 hex chars = sha256 digest.
    expect(typeof fp).toBe("string");
    expect(fp as string).toMatch(/^[0-9a-f]{64}$/);
    // Cost + prompt version + report_data are all persisted.
    expect(persist?.report_data).toBeDefined();
    expect(typeof persist?.report_cost_sek).toBe("number");
    expect(typeof persist?.report_prompt_version).toBe("string");
  });
});

describe("generateReport — persist failure", () => {
  it("returns a Swedish error when the terminal persist write fails", async () => {
    synthesizeReport.mockResolvedValue({ parsed: fakeReport(), usage: CHEAP_USAGE });
    persistError = { code: "XX000" };
    const result = await generateReport("a1");
    expect(result.ok).toBe(false);
  });
});
