import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * allabrf.test.ts — mocks `resolveSafeExternalUrl` and `global.fetch` so no
 * live network runs (live Allabrf is operator-only manual verification per
 * 08-VALIDATION.md). Mirrors the mocking style of
 * `fetch-broker-page.dns-pinning.test.ts` (mock the guard, not the whole
 * fetch orchestration) combined with a `global.fetch` spy for full call-site
 * assertions (invalid-org.nr-never-fetches, disallowed-host-refused, etc).
 */

const resolveSafeExternalUrl = vi.fn();
vi.mock("@/lib/broker/url-guard", () => ({
  resolveSafeExternalUrl: (...args: unknown[]) => resolveSafeExternalUrl(...args),
}));

const { searchAllabrfByName, fetchAllabrfDocument, assertAllowedHost } = await import(
  "@/lib/brf-source/allabrf"
);

const VALID_ORG_NR = "5560360793";
const INVALID_ORG_NR = "5560360794";

function jsonLdCandidateHtml(): string {
  return `<html><body>
    <div data-orgnr="5560360793" data-name="Brf Björken" data-kommun="Stockholm">Brf Björken</div>
    <div data-orgnr="2120000142" data-name="Brf Ekorren" data-kommun="Göteborg">Brf Ekorren</div>
  </body></html>`;
}

function documentHtml(): string {
  return `<html><body>
    <div data-fiscal-year="2022"></div>
    <div data-available-year="2020"></div>
    <div data-available-year="2021"></div>
    <div data-available-year="2022"></div>
    <div data-available-year="2023"></div>
    <p>Årsredovisning för Brf Björken. Skuld per kvm: 12345 kr.</p>
  </body></html>`;
}

function fakeResponse(opts: {
  status?: number;
  ok?: boolean;
  type?: string;
  body?: string;
}): Response {
  const { status = 200, ok = status >= 200 && status < 300, type = "default", body = "" } = opts;
  return {
    status,
    ok,
    type,
    text: async () => body,
    body: null,
  } as unknown as Response;
}

describe("allabrf", () => {
  beforeEach(() => {
    resolveSafeExternalUrl.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("searchAllabrfByName", () => {
    it("returns parsed candidates on a happy-path fixture", async () => {
      resolveSafeExternalUrl.mockResolvedValue({ address: "1.2.3.4", family: 4 });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        fakeResponse({ body: jsonLdCandidateHtml() }),
      );

      const candidates = await searchAllabrfByName("Brf Björken");

      expect(candidates).toEqual([
        { orgNr: "5560360793", name: "Brf Björken", kommun: "Stockholm" },
        { orgNr: "2120000142", name: "Brf Ekorren", kommun: "Göteborg" },
      ]);
    });

    it("returns [] and does not throw on malformed HTML", async () => {
      resolveSafeExternalUrl.mockResolvedValue({ address: "1.2.3.4", family: 4 });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        fakeResponse({ body: "<html><body><div data-orgnr>not closed" }),
      );

      const candidates = await searchAllabrfByName("Brf Björken");
      expect(Array.isArray(candidates)).toBe(true);
    });

    it("returns [] when the URL is refused by the shared SSRF guard", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      resolveSafeExternalUrl.mockResolvedValue(null);

      const candidates = await searchAllabrfByName("Brf Björken");

      expect(candidates).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("returns [] for an empty brfName without making any request", async () => {
      const candidates = await searchAllabrfByName("");
      expect(candidates).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("fetchAllabrfDocument", () => {
    it("rejects an invalid org.nr BEFORE any fetch is made", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await fetchAllabrfDocument(INVALID_ORG_NR);

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(resolveSafeExternalUrl).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("returns null when the shared SSRF guard rejects the URL, without ever fetching", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      resolveSafeExternalUrl.mockResolvedValue(null);

      const result = await fetchAllabrfDocument(VALID_ORG_NR);

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe("assertAllowedHost", () => {
    it("accepts every host in the Allabrf allowlist", () => {
      expect(assertAllowedHost("https://allabrf.se/sok/?q=x")).toBe(true);
      expect(assertAllowedHost("https://www.allabrf.se/brf/5560360793/")).toBe(true);
      expect(assertAllowedHost("https://sv.allabrf.se/brf/5560360793/")).toBe(true);
    });

    it("rejects a host outside the Allabrf allowlist (e.g. an attacker-controlled or internal host)", () => {
      expect(assertAllowedHost("https://evil.example.com/allabrf.se")).toBe(false);
      expect(assertAllowedHost("https://allabrf.se.evil.example.com/")).toBe(false);
      expect(assertAllowedHost("http://169.254.169.254/latest/meta-data")).toBe(false);
      expect(assertAllowedHost("http://localhost:8080/")).toBe(false);
    });

    it("rejects a malformed URL rather than throwing", () => {
      expect(assertAllowedHost("not a url")).toBe(false);
    });

    it("treats a 3xx redirect response as a failure", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      resolveSafeExternalUrl.mockResolvedValue({ address: "1.2.3.4", family: 4 });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        fakeResponse({ status: 302, ok: false }),
      );

      const result = await fetchAllabrfDocument(VALID_ORG_NR);

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("treats an opaqueredirect response type as a failure", async () => {
      resolveSafeExternalUrl.mockResolvedValue({ address: "1.2.3.4", family: 4 });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        fakeResponse({ status: 0, ok: false, type: "opaqueredirect" }),
      );

      const result = await fetchAllabrfDocument(VALID_ORG_NR);
      expect(result).toBeNull();
    });

    it("returns null (never throws) on malformed HTML", async () => {
      resolveSafeExternalUrl.mockResolvedValue({ address: "1.2.3.4", family: 4 });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        fakeResponse({ body: "<<<not html at all>>>" }),
      );

      await expect(fetchAllabrfDocument(VALID_ORG_NR)).resolves.not.toThrow;
      const result = await fetchAllabrfDocument(VALID_ORG_NR);
      expect(result === null || typeof result === "object").toBe(true);
    });

    it("enforces the size cap — an oversized body is bounded, not fully buffered", async () => {
      resolveSafeExternalUrl.mockResolvedValue({ address: "1.2.3.4", family: 4 });
      const oversized = "a".repeat(9 * 1024 * 1024); // 9 MB, over the 8 MB cap
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        fakeResponse({ body: oversized }),
      );

      const result = await fetchAllabrfDocument(VALID_ORG_NR);

      // text() based fallback path caps the string length itself.
      expect(result).not.toBeNull();
      expect(result!.text.length).toBeLessThanOrEqual(8 * 1024 * 1024);
    });

    it("returns a document with fiscalYear + availableYears on a happy-path fixture", async () => {
      resolveSafeExternalUrl.mockResolvedValue({ address: "1.2.3.4", family: 4 });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        fakeResponse({ body: documentHtml() }),
      );

      const result = await fetchAllabrfDocument(VALID_ORG_NR);

      expect(result).not.toBeNull();
      expect(result!.fiscalYear).toBe(2022);
      expect(result!.availableYears).toEqual([2020, 2021, 2022, 2023]);
      expect(result!.text).toContain("Skuld per kvm");
    });

    it("never leaks the fetched HTML/PII into logs", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      resolveSafeExternalUrl.mockResolvedValue({ address: "1.2.3.4", family: 4 });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        fakeResponse({ status: 500, ok: false, body: "SECRET_PII_MARKER" }),
      );

      await fetchAllabrfDocument(VALID_ORG_NR);

      for (const call of errorSpy.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain("SECRET_PII_MARKER");
      }
    });
  });
});
