import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(__dirname, "__fixtures__");
const jsonLdHtml = readFileSync(join(FIXTURES_DIR, "broker-jsonld.html"), "utf-8");
const domHtml = readFileSync(join(FIXTURES_DIR, "broker-dom.html"), "utf-8");

import { parseBrokerPage } from "@/lib/broker/parse-broker-page";

/** Deep-search: recursively scans any JSON-serializable value for a needle string. */
function deepContains(value: unknown, needle: string): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => deepContains(v, needle));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => deepContains(v, needle));
  }
  return false;
}

describe("parseBrokerPage", () => {
  it("extracts description from JSON-LD and never leaks agent PII (name/phone/email)", () => {
    const result = parseBrokerPage(jsonLdHtml);

    expect(result.description).toBe(
      "Ljus och fin trea med balkong i lugnt läge. Nyrenoverat kök 2020 och badrum 2019. Nära till kommunikationer och service.",
    );

    // Deep-search PII assertion (Pitfall 4, T-06-05 mandatory regression test).
    expect(deepContains(result, "Anna Andersson")).toBe(false);
    expect(deepContains(result, "+46701234567")).toBe(false);
    expect(deepContains(result, "070-123 45 67")).toBe(false);
    expect(deepContains(result, "anna.andersson@maklarhuset.example")).toBe(false);
  });

  it("falls back to DOM selectors when no JSON-LD is present", () => {
    const result = parseBrokerPage(domHtml);

    expect(result.description).toContain("rymlig tvåa med öppen planlösning");
    expect(result.renovationStatus).toContain("Stambyte genomfört 2018");
  });

  it("never throws on empty HTML, malformed JSON-LD, or HTML with no recognizable content", () => {
    expect(() => parseBrokerPage("")).not.toThrow();
    expect(parseBrokerPage("")).toEqual({ renovationStatus: null, description: null, images: [] });

    const malformed = `<html><head><script type="application/ld+json">{"@type":"RealEstateListing","description":"x",}</script></head><body></body></html>`;
    expect(() => parseBrokerPage(malformed)).not.toThrow();

    const noContent = "<html><head></head><body><div>nothing here</div></body></html>";
    const result = parseBrokerPage(noContent);
    expect(result.renovationStatus).toBeNull();
  });

  it("does not fabricate renovationStatus from description prose when no dedicated field/section exists", () => {
    // The JSON-LD fixture's description mentions "Nyrenoverat kök 2020" in
    // prose, but there is no dedicated renovation field/section in that
    // fixture's JSON-LD or DOM — renovationStatus must stay null, not be
    // inferred/paraphrased from the description text (Pitfall 5).
    const result = parseBrokerPage(jsonLdHtml);
    expect(result.renovationStatus).toBeNull();
  });

  it("WR-03: reads renovationStatus from a <dt>Skick</dt><dd> definition-list layout", () => {
    const html = `<html><body><dl>
      <dt>Boarea</dt><dd>72 m²</dd>
      <dt>Skick</dt><dd>Totalrenoverat 2021, nytt kök och badrum.</dd>
    </dl></body></html>`;
    const result = parseBrokerPage(html);
    expect(result.renovationStatus).toBe("Totalrenoverat 2021, nytt kök och badrum.");
  });

  it("WR-03: reads renovationStatus from a wrapper-div layout (heading + sibling child, no direct next sibling)", () => {
    const html = `<html><body><div class="fact"><h3>Skick</h3><p>Välhållet, målat 2022.</p></div></body></html>`;
    const result = parseBrokerPage(html);
    expect(result.renovationStatus).toBe("Välhållet, målat 2022.");
  });

  it("WR-04: does NOT select a cookie/footer/agent-contact block as the description", () => {
    const html = `<html><body>
      <main>
        <p>En ljus och rymlig trea på översta våningen med öppen planlösning, balkong i söderläge och nyrenoverat kök från 2020.</p>
      </main>
      <footer>
        <p>Denna webbplats använder cookies för att förbättra din upplevelse. Genom att fortsätta godkänner du vår användning av cookies enligt vår integritetspolicy och villkor.</p>
      </footer>
      <div class="agent"><p>Kontakta mäklare Anna Andersson på 070-123 45 67 eller anna@maklare.se för visning.</p></div>
    </body></html>`;
    const result = parseBrokerPage(html);
    expect(result.description).toContain("nyrenoverat kök från 2020");
    expect(result.description).not.toContain("cookies");
    expect(result.description).not.toContain("Anna");
  });

  it("extracts the gallery image URLs from a JSON-LD image[] (string[] and ImageObject[])", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "RealEstateListing",
      image: [
        "https://cdn.maklare.example/kok.jpg",
        { "@type": "ImageObject", url: "https://cdn.maklare.example/badrum.jpg" },
        "http://cdn.maklare.example/insecure.jpg", // dropped — not https
      ],
    })}</script></head><body></body></html>`;
    const result = parseBrokerPage(html);
    expect(result.images).toEqual([
      "https://cdn.maklare.example/kok.jpg",
      "https://cdn.maklare.example/badrum.jpg",
    ]);
  });

  it("falls back to main/article <img> when no JSON-LD image[] exists, skipping logos/avatars", () => {
    const html = `<html><body><main>
      <img src="https://cdn.maklare.example/logo.svg" />
      <img src="https://cdn.maklare.example/gallery-1.jpg" />
      <img src="https://cdn.maklare.example/maklare-avatar.jpg" />
      <img src="http://cdn.maklare.example/insecure.jpg" />
    </main></body></html>`;
    const result = parseBrokerPage(html);
    expect(result.images).toEqual(["https://cdn.maklare.example/gallery-1.jpg"]);
  });

  it("returns images:[] when the page has no gallery", () => {
    expect(parseBrokerPage("<html><body><p>Ingen bildgalleri här.</p></body></html>").images).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// fetchBrokerListingPage — behavior 5 (guard-gated, never throws)
// ---------------------------------------------------------------------------

// CR-01: fetch-broker-page.ts now resolves via resolveSafeExternalUrl (which
// returns the validated address to pin, not a bare boolean) and pins the
// connection through an undici Agent — mock the resolver accordingly.
const resolveSafeExternalUrl = vi.fn();
vi.mock("@/lib/broker/url-guard", () => ({
  resolveSafeExternalUrl: (...args: unknown[]) => resolveSafeExternalUrl(...args),
}));

const globalFetch = vi.fn();
vi.stubGlobal("fetch", globalFetch);

// Imported AFTER mocks are registered.
import { fetchBrokerListingPage } from "@/lib/broker/fetch-broker-page";

const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 as const };

beforeEach(() => {
  resolveSafeExternalUrl.mockReset();
  globalFetch.mockReset();
});

describe("fetchBrokerListingPage", () => {
  it("returns null without ever calling fetch when resolveSafeExternalUrl rejects the URL", async () => {
    resolveSafeExternalUrl.mockResolvedValue(null);

    const result = await fetchBrokerListingPage("https://internal.example/");

    expect(result).toBeNull();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("returns the parsed fields when the guard passes and the fetch succeeds", async () => {
    resolveSafeExternalUrl.mockResolvedValue(PUBLIC_ADDRESS);
    globalFetch.mockResolvedValue({
      ok: true,
      status: 200,
      type: "basic",
      text: () => Promise.resolve(domHtml),
    });

    const result = await fetchBrokerListingPage("https://broker.example/listing/1");

    expect(result).not.toBeNull();
    expect(result?.description).toContain("rymlig tvåa");
  });

  it("pins the fetch to the resolved address via a dispatcher — the resolved IP is passed to fetch, not re-resolved (CR-01)", async () => {
    resolveSafeExternalUrl.mockResolvedValue(PUBLIC_ADDRESS);
    globalFetch.mockResolvedValue({
      ok: true,
      status: 200,
      type: "basic",
      text: () => Promise.resolve(domHtml),
    });

    await fetchBrokerListingPage("https://broker.example/listing/1");

    expect(globalFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = globalFetch.mock.calls[0];
    expect(calledUrl).toBe("https://broker.example/listing/1");
    expect(calledOptions).toMatchObject({ redirect: "manual" });
    // A dispatcher must be present so undici does not perform its own,
    // independent DNS resolution for the actual TCP connection.
    expect(calledOptions.dispatcher).toBeDefined();
  });

  it("returns null (never throws) on a non-2xx response", async () => {
    resolveSafeExternalUrl.mockResolvedValue(PUBLIC_ADDRESS);
    globalFetch.mockResolvedValue({ ok: false, status: 404, type: "basic" });

    await expect(fetchBrokerListingPage("https://broker.example/gone")).resolves.toBeNull();
  });

  it("returns null (never throws) on a redirect response", async () => {
    resolveSafeExternalUrl.mockResolvedValue(PUBLIC_ADDRESS);
    globalFetch.mockResolvedValue({ ok: false, status: 302, type: "basic" });

    await expect(fetchBrokerListingPage("https://broker.example/redirect")).resolves.toBeNull();
  });

  it("returns null (never throws) when fetch itself rejects", async () => {
    resolveSafeExternalUrl.mockResolvedValue(PUBLIC_ADDRESS);
    globalFetch.mockRejectedValue(new Error("network error"));

    await expect(fetchBrokerListingPage("https://broker.example/boom")).resolves.toBeNull();
  });

  it("returns null (never throws) when resolveSafeExternalUrl itself rejects", async () => {
    resolveSafeExternalUrl.mockRejectedValue(new Error("dns lookup exploded"));

    await expect(fetchBrokerListingPage("https://broker.example/boom")).resolves.toBeNull();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
