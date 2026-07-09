import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration test for the `analyzeUrl` server action (Phase 6 Plan 03).
 *
 * NO real Next.js request context, NO real Supabase, NO real Booli/broker
 * network calls: `next/headers`, `next/navigation`, `@/lib/booli/client`,
 * `@/lib/broker/fetch-broker-page`, and `@/lib/supabase/server` are all
 * mocked. This is the first integration test for this action (Plan 03).
 *
 * Central contract under test (LSTG-04): the broker-enrichment step is
 * independent-degradation — a broker fetch failure must NEVER cause
 * `analyzeUrl` to return `{ error }`; the primary Booli-sourced analysis
 * always succeeds on its own. Gap-fill-only merge + no-PII-persistence are
 * also verified at this integration boundary (RESEARCH Pattern 4, T-06-08,
 * T-06-09, T-06-10).
 */

// ---- Mock next/headers (guest cookie) --------------------------------------
const cookieStore = {
  get: vi.fn(),
  set: vi.fn(),
};
vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
}));

// ---- Mock next/navigation (redirect) — never exercised in the guest path,
// but analyzeUrl imports it unconditionally so it must resolve.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("redirect() called — unexpected in guest-flow tests");
  }),
}));

// ---- Mock the Supabase server client -----------------------------------
// Mutable per-test state so both the guest flow (default: no user) and the
// authenticated-insert-failure flow (WR-03) can be exercised from the same
// mock module without re-registering vi.mock per test.
let mockUser: { id: string } | null = null;
let mockInsertResult: { data: { id: string } | null; error: unknown } = {
  data: null,
  error: null,
};
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser } }),
    },
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => mockInsertResult,
        }),
      }),
    }),
  }),
}));

// ---- Mock the Booli client (fetchListing) ----------------------------------
const fetchListing = vi.fn();
vi.mock("@/lib/booli/client", () => ({
  fetchListing: (...args: unknown[]) => fetchListing(...args),
  isBooliUrl: (url: string) => typeof url === "string" && url.includes("booli.se"),
}));

// ---- Mock the broker-enrichment module -------------------------------------
const fetchBrokerListingPage = vi.fn();
vi.mock("@/lib/broker/fetch-broker-page", () => ({
  fetchBrokerListingPage: (...args: unknown[]) => fetchBrokerListingPage(...args),
}));

import { analyzeUrl } from "@/actions/analyze";

const URL = "https://www.booli.se/bostad/305443";

function formDataFor(url: string): FormData {
  const fd = new FormData();
  fd.set("url", url);
  return fd;
}

/** A minimal Booli raw payload with the four required display fields + an agencyListingUrl. */
function baseRawData(overrides: Record<string, unknown> = {}) {
  return {
    streetAddress: "Testgatan 1",
    price: 3_000_000,
    livingArea: { raw: 50 },
    rooms: 2,
    agencyListingUrl: "https://maklarsajt.se/bostad/1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.get.mockReturnValue(undefined);
  mockUser = null;
  mockInsertResult = { data: null, error: null };
});

describe("analyzeUrl — broker enrichment (independent degradation, LSTG-04)", () => {
  it("returns {data, partial:false} even when fetchBrokerListingPage REJECTS — broker failure never fails the primary analysis", async () => {
    fetchListing.mockResolvedValue(baseRawData());
    fetchBrokerListingPage.mockRejectedValue(new Error("broker page down"));

    const result = await analyzeUrl(formDataFor(URL));

    expect(result.error).toBeUndefined();
    expect(result.data).toBeDefined();
    expect(result.partial).toBe(false);
    // Booli-sourced fields intact despite the broker rejection.
    expect(result.data?.address).toBe("Testgatan 1");
    expect(result.data?.price).toBe(3_000_000);
  });

  it("gap-fills renovationStatus/description from the broker when Booli lacks them, tagging source 'maklare'; never overwrites an existing Booli value (source stays 'booli')", async () => {
    fetchListing.mockResolvedValue(
      baseRawData({
        // Booli already has a description; renovationStatus is absent.
        description: "Booli-beskrivning",
      })
    );
    fetchBrokerListingPage.mockResolvedValue({
      renovationStatus: "Nyrenoverat kök 2020",
      description: "Mäklarens egen text — ska ignoreras",
    });

    const result = await analyzeUrl(formDataFor(URL));

    expect(result.data?.renovationStatus).toBe("Nyrenoverat kök 2020");
    // Booli's description value wins — broker value must be ignored.
    expect(result.data?.description).toBe("Booli-beskrivning");
  });

  it("populates floor/balcony/brfName from the Booli side regardless of broker-fetch outcome (Pitfall 1 — not gated on broker success)", async () => {
    fetchListing.mockResolvedValue(
      baseRawData({ floor: 3, balcony: true, brfName: "BRF Exempel" })
    );
    fetchBrokerListingPage.mockRejectedValue(new Error("network error"));

    const result = await analyzeUrl(formDataFor(URL));

    expect(result.data?.floor).toBe(3);
    expect(result.data?.balcony).toBe(true);
    expect(result.data?.brfName).toBe("BRF Exempel");
  });

  it("never persists mäklare PII (name/phone/email) anywhere in the assembled listingData, even when the broker mock resolves with PII-shaped keys", async () => {
    fetchListing.mockResolvedValue(baseRawData());
    fetchBrokerListingPage.mockResolvedValue({
      renovationStatus: "Helrenoverat 2021",
      description: "Fin lägenhet.",
      // Simulates a misbehaving/parsed-wrong broker module leaking PII-shaped
      // keys — mergeListingFields only reads the two allow-listed fields, so
      // these must never appear in the persisted listingData.
      agentName: "Anna Andersson",
      agentPhone: "070-1234567",
      agentEmail: "anna@maklare.se",
    });

    const result = await analyzeUrl(formDataFor(URL));

    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("Anna Andersson");
    expect(serialized).not.toContain("070-1234567");
    expect(serialized).not.toContain("anna@maklare.se");
    expect(serialized).not.toMatch(/agentName|agentPhone|agentEmail/);
  });

  it("sets a brokerFetchFailed signal when the broker fetch fails, without flipping the primary `partial` flag", async () => {
    fetchListing.mockResolvedValue(baseRawData());
    fetchBrokerListingPage.mockResolvedValue(null);

    const result = await analyzeUrl(formDataFor(URL));

    expect(result.partial).toBe(false);
    expect(
      (result as { brokerFetchFailed?: boolean }).brokerFetchFailed
    ).toBe(true);
  });

  it("does not set brokerFetchFailed when the broker fetch succeeds", async () => {
    fetchListing.mockResolvedValue(baseRawData());
    fetchBrokerListingPage.mockResolvedValue({
      renovationStatus: "Nyrenoverat",
      description: "Beskrivning",
    });

    const result = await analyzeUrl(formDataFor(URL));

    expect(
      (result as { brokerFetchFailed?: boolean }).brokerFetchFailed
    ).toBeFalsy();
  });

  it("skips the broker fetch entirely (no crash, no brokerFetchFailed) when no agencyListingUrl is present", async () => {
    fetchListing.mockResolvedValue(baseRawData({ agencyListingUrl: undefined }));

    const result = await analyzeUrl(formDataFor(URL));

    expect(fetchBrokerListingPage).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(
      (result as { brokerFetchFailed?: boolean }).brokerFetchFailed
    ).toBeFalsy();
  });

  it("rejects a non-http(s) agencyListingUrl (e.g. javascript:) at extraction time — never reaches fetchBrokerListingPage (WR-04)", async () => {
    fetchListing.mockResolvedValue(
      baseRawData({ agencyListingUrl: "javascript:alert(1)" })
    );

    const result = await analyzeUrl(formDataFor(URL));

    expect(fetchBrokerListingPage).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(
      (result as { brokerFetchFailed?: boolean }).brokerFetchFailed
    ).toBeFalsy();
  });

  it("rejects a malformed agencyListingUrl string at extraction time — never reaches fetchBrokerListingPage (WR-04)", async () => {
    fetchListing.mockResolvedValue(
      baseRawData({ agencyListingUrl: "not a url at all" })
    );

    const result = await analyzeUrl(formDataFor(URL));

    expect(fetchBrokerListingPage).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
  });
});

describe("analyzeUrl — authenticated insert-error handling (WR-03)", () => {
  it("surfaces an error and does NOT fall through to the guest-cookie path when the Supabase insert fails", async () => {
    mockUser = { id: "user-1" };
    mockInsertResult = { data: null, error: { message: "constraint violation" } };
    fetchListing.mockResolvedValue(baseRawData());
    fetchBrokerListingPage.mockResolvedValue(null);

    const result = await analyzeUrl(formDataFor(URL));

    expect(result.error).toBe("Kunde inte spara analysen. Forsok igen.");
    expect(result.data).toBeUndefined();
    // Must not silently fall through to the guest cookie path — an
    // authenticated user's failed save must not masquerade as a guest hit.
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("surfaces an error when insert returns no error but also no row (defensive null-data check)", async () => {
    mockUser = { id: "user-1" };
    mockInsertResult = { data: null, error: null };
    fetchListing.mockResolvedValue(baseRawData());
    fetchBrokerListingPage.mockResolvedValue(null);

    const result = await analyzeUrl(formDataFor(URL));

    expect(result.error).toBe("Kunde inte spara analysen. Forsok igen.");
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("redirects (never falls through) when the authenticated insert succeeds", async () => {
    mockUser = { id: "user-1" };
    mockInsertResult = { data: { id: "analysis-1" }, error: null };
    fetchListing.mockResolvedValue(baseRawData());
    fetchBrokerListingPage.mockResolvedValue(null);

    await expect(analyzeUrl(formDataFor(URL))).rejects.toThrow(
      "redirect() called"
    );
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});
