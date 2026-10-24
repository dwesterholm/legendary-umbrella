// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { apifyClientMockFactory } from "@/lib/booli/__mocks__/apify-client";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import { candidateFactsSchema } from "@/lib/discovery/listing-facts";
import { parseFitSnapshot } from "@/lib/discovery/fit-score";
import { booliChallengeStop, enrichAllCandidates, type WatchEnrichDeps } from "@/lib/discovery/watch-enrich";

vi.mock("apify-client", () => apifyClientMockFactory());

/**
 * watch-enrich.test.ts - the headless "read every candidate" loop, with injected
 * fakes for the three network edges (no module mocks beyond the Apify client
 * constructor, which is never called). Proves the enrichCandidateImages contract
 * that fit-pipeline relies on: input order, identity on failure, card-versus-
 * detail precedence, never throws, deadline, concurrency, and the PII rule.
 */

const AS_OF = "2026-10-13";
const base = parseFitSnapshot(snapshotJson).rows[0].candidate;

function candidate(id: number, patch: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    ...base,
    sourceListingUrl: `https://www.booli.se/bostad/${id}`,
    address: `Testgatan ${id}`,
    imageUrls: null,
    floor: null,
    constructionYear: null,
    orientation: null,
    balcony: null,
    vision: null,
    visionSkippedReason: null,
    ...patch,
  };
}

const idOf = (url: string): number => Number(url.split("/").pop());

/** A detail entity as `fetchListing` returns it (reshaped), with the keys the facts builder reads. */
function rawDetail(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageUrls: ["https://bcdn.se/images/cache/detail_1440x0.webp"],
    floor: 2,
    constructionYear: 1932,
    balcony: false,
    amenities: [{ key: "elevator" }],
    rent: 4100,
    tenureForm: "Bostadsrätt",
    published: "2026-09-01 10:00:00",
    ...patch,
  };
}

/** What the BRF page of the test association says (the numbers of the real fixture 2, BRF 81611). */
const BRF_FACTS = { loanSek: 164_160_600, areaSqm: 12_897, reportYear: 2024, debtPerSqm: 12_729 };

interface Fakes {
  deps: WatchEnrichDeps;
  fetchListing: ReturnType<typeof vi.fn>;
  fetchBrokerListingPage: ReturnType<typeof vi.fn>;
  fetchBrokerImageBytes: ReturnType<typeof vi.fn>;
  fetchBrfFacts: ReturnType<typeof vi.fn>;
}

function fakes(overrides: Partial<Fakes> = {}): Fakes {
  const fetchListing = overrides.fetchListing ?? vi.fn(async () => rawDetail());
  const fetchBrokerListingPage = overrides.fetchBrokerListingPage ?? vi.fn(async () => null);
  const fetchBrokerImageBytes = overrides.fetchBrokerImageBytes ?? vi.fn(async () => []);
  const fetchBrfFacts = overrides.fetchBrfFacts ?? vi.fn(async () => BRF_FACTS);
  return {
    deps: {
      fetchListing: fetchListing as unknown as WatchEnrichDeps["fetchListing"],
      fetchBrokerListingPage: fetchBrokerListingPage as unknown as WatchEnrichDeps["fetchBrokerListingPage"],
      fetchBrokerImageBytes: fetchBrokerImageBytes as unknown as WatchEnrichDeps["fetchBrokerImageBytes"],
      fetchBrfFacts: fetchBrfFacts as unknown as WatchEnrichDeps["fetchBrfFacts"],
    },
    fetchListing,
    fetchBrokerListingPage,
    fetchBrokerImageBytes,
    fetchBrfFacts,
  };
}

const opts = (deps: WatchEnrichDeps, extra: object = {}) => ({
  deadlineMs: 60_000,
  concurrency: 2,
  asOf: AS_OF,
  deps,
  ...extra,
});

describe("enrichAllCandidates: every candidate is read", () => {
  it("5 candidates, all fetches succeed: 5 fetches, every entry replaced, facts say detailFetched", async () => {
    const input = [1, 2, 3, 4, 5].map((n) => candidate(n));
    const f = fakes();
    const result = await enrichAllCandidates(input, input.length, opts(f.deps));

    expect(f.fetchListing).toHaveBeenCalledTimes(5);
    expect(result.candidates).toHaveLength(5);
    result.candidates.forEach((c, i) => {
      expect(c).not.toBe(input[i]);
      expect(c.sourceListingUrl).toBe(input[i].sourceListingUrl);
      expect(result.facts.get(i)?.detailFetched).toBe(true);
    });
    expect(input[0].imageUrls).toBeNull();
  });

  it("limit caps the number of reads, in input order; candidates without a URL are never read", async () => {
    const input = [candidate(1), candidate(2, { sourceListingUrl: null }), candidate(3), candidate(4)];
    const f = fakes();
    const result = await enrichAllCandidates(input, 2, opts(f.deps));

    expect(f.fetchListing).toHaveBeenCalledTimes(2);
    expect(result.candidates[0]).not.toBe(input[0]);
    expect(result.candidates[1]).toBe(input[1]);
    expect(result.candidates[2]).not.toBe(input[2]);
    expect(result.candidates[3]).toBe(input[3]);
    expect(result.facts.has(1)).toBe(false);
    expect(result.facts.has(3)).toBe(false);
  });

  it("uses the bounded detail envelope, never the unbounded default", async () => {
    const f = fakes();
    await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    const o = f.fetchListing.mock.calls[0][1] as { waitSecs: number; maxRequestRetries: number };
    expect(o.waitSecs).toBeLessThan(240);
    expect(o.maxRequestRetries).toBeLessThan(3);
  });
});

describe("failure keeps identity (the pipeline's detailFetched test)", () => {
  it("a detail fetch that throws leaves that entry the very same object, no detail facts, others fine, no throw", async () => {
    const input = [1, 2, 3].map((n) => candidate(n));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fakes({
      fetchListing: vi.fn(async (url: string) => {
        if (idOf(url) === 2) throw new Error("blocked https://www.booli.se/bostad/2 secret-token-123");
        return rawDetail();
      }),
    });
    const result = await enrichAllCandidates(input, 3, opts(f.deps));

    expect(result.candidates[1]).toBe(input[1]);
    expect(result.facts.has(1)).toBe(false);
    expect(result.candidates[0]).not.toBe(input[0]);
    expect(result.candidates[2]).not.toBe(input[2]);
    // One log line per failure, by error name only: the message (a URL, a token) is never printed.
    expect(err).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret-token-123");
    expect(JSON.stringify(err.mock.calls)).not.toContain("booli.se");
    err.mockRestore();
  });

  it("a thrown broker leg does not undo a good detail read", async () => {
    const f = fakes({
      fetchListing: vi.fn(async () => rawDetail({ agencyListingUrl: "https://maklare.example/objekt/1" })),
      fetchBrokerListingPage: vi.fn(async () => {
        throw new Error("dns");
      }),
    });
    const input = [candidate(1)];
    const result = await enrichAllCandidates(input, 1, opts(f.deps));
    expect(result.candidates[0]).not.toBe(input[0]);
    expect(result.facts.get(0)?.detailFetched).toBe(true);
    expect(result.facts.get(0)?.descriptionRead).toBe(false);
  });

  it("a detail entity toCandidate cannot read still never throws", async () => {
    const f = fakes({ fetchListing: vi.fn(async () => null as unknown as Record<string, unknown>) });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const input = [candidate(1)];
    const result = await enrichAllCandidates(input, 1, opts(f.deps));
    expect(result.candidates[0]).toBe(input[0]);
    err.mockRestore();
  });
});

describe("card-versus-detail precedence (job.ts rules)", () => {
  it("card floor 3 beats detail floor 4; card year beats detail year", async () => {
    const f = fakes({ fetchListing: vi.fn(async () => rawDetail({ floor: 4, constructionYear: 1900 })) });
    const result = await enrichAllCandidates([candidate(1, { floor: 3, constructionYear: 1950 })], 1, opts(f.deps));
    expect(result.candidates[0].floor).toBe(3);
    expect(result.candidates[0].constructionYear).toBe(1950);
  });

  it("detail fills a null card floor and year", async () => {
    const f = fakes({ fetchListing: vi.fn(async () => rawDetail({ floor: 4, constructionYear: 1900 })) });
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    expect(result.candidates[0].floor).toBe(4);
    expect(result.candidates[0].constructionYear).toBe(1900);
  });

  it("card balcony false and detail balcony true gives true (R-04b); a detail false keeps the card value", async () => {
    const yes = fakes({ fetchListing: vi.fn(async () => rawDetail({ balcony: true })) });
    const a = await enrichAllCandidates([candidate(1, { balcony: false })], 1, opts(yes.deps));
    expect(a.candidates[0].balcony).toBe(true);

    const no = fakes({ fetchListing: vi.fn(async () => rawDetail({ balcony: false })) });
    const b = await enrichAllCandidates([candidate(1, { balcony: true })], 1, opts(no.deps));
    expect(b.candidates[0].balcony).toBe(true);
    const c = await enrichAllCandidates([candidate(1, { balcony: null })], 1, opts(no.deps));
    expect(c.candidates[0].balcony).toBe(false);
  });

  it("card orientation null and broker text 'balkong i söderläge' derives the orientation; a card orientation wins", async () => {
    const f = fakes({
      fetchListing: vi.fn(async () => rawDetail({ agencyListingUrl: "https://maklare.example/objekt/1" })),
      fetchBrokerListingPage: vi.fn(async () => ({
        renovationStatus: null,
        description: "Ljus lägenhet med balkong i söderläge.",
        images: [],
      })),
    });
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    expect(result.candidates[0].orientation?.facades).toContain("south");
    expect(result.facts.get(0)?.orientationFacades).toContain("south");

    const fromCard = await enrichAllCandidates(
      [candidate(1, { orientation: { facades: ["north"], confidence: 0.9 } })],
      1,
      opts(f.deps),
    );
    expect(fromCard.candidates[0].orientation?.facades).toEqual(["north"]);
  });
});

describe("facts from the description", () => {
  const brokerFakes = (description: string | null, images: string[] = []) =>
    fakes({
      fetchListing: vi.fn(async () => rawDetail({ agencyListingUrl: "https://maklare.example/objekt/1" })),
      fetchBrokerListingPage: vi.fn(async () => ({ renovationStatus: null, description, images })),
    });

  it("'Balkong med kvällssol. Föreningen äger marken.' gives sunPhrases [kvällssol], landLease false, descriptionRead true", async () => {
    const f = brokerFakes("Balkong med kvällssol. Föreningen äger marken.");
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    const facts = result.facts.get(0);
    expect(facts?.sunPhrases).toEqual(["kvällssol"]);
    expect(facts?.landLease).toBe(false);
    expect(facts?.descriptionRead).toBe(true);
    expect(result.sunPhrases.get(0)).toEqual({ allDaySun: false, throughFlat: false });
  });

  it("no description text is stored in the facts, the candidate or anywhere that is persisted", async () => {
    const secret =
      "Kontakta mäklare Svensson på 070-123 45 67 eller svensson@maklare.example. Balkong med kvällssol. Takhöjd 3,2 m i vardagsrummet.";
    const f = brokerFakes(secret);
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    const stored = JSON.stringify({
      facts: [...result.facts.values()],
      candidates: result.candidates,
      sun: [...result.sunPhrases.values()],
    });
    expect(stored).not.toContain("Svensson");
    expect(stored).not.toContain("070-123");
    expect(stored).not.toContain("maklare.example");
    expect(stored).not.toContain("Kontakta");
    expect(stored).not.toContain("vardagsrummet");
    expect(stored).not.toContain("Takhöjd"); // the number is stored, the sentence is not
    expect(result.facts.get(0)?.ceilingHeightM).toBe(3.2);
    // The facts record survives its own schema (unknown keys would be stripped).
    expect(candidateFactsSchema.parse(result.facts.get(0))).toEqual(result.facts.get(0));
  });

  it("'Takhöjd 3,2 m. Balkong mot gården.' stores ceilingHeightM 3,2, source 'angiven' and no tall phrase (CEIL-01)", async () => {
    const f = brokerFakes("Takhöjd 3,2 m. Balkong mot gården.");
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    const facts = result.facts.get(0);
    expect(facts?.ceilingHeightM).toBe(3.2);
    expect(facts?.ceilingSource).toBe("angiven");
    expect(facts?.tallCeilingPhrase).toBe(false);
  });

  it("'Högt i tak i hela lägenheten.' stores no number and the flag: { null, null, true }", async () => {
    const f = brokerFakes("Högt i tak i hela lägenheten.");
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    const facts = result.facts.get(0);
    expect(facts?.ceilingHeightM).toBeNull();
    expect(facts?.ceilingSource).toBeNull();
    expect(facts?.tallCeilingPhrase).toBe(true);
  });

  it("a description that states no height is read: ceilingHeightM null, tallCeilingPhrase false", async () => {
    const f = brokerFakes("Ljus etta med balkong.");
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    const facts = result.facts.get(0);
    expect(facts?.ceilingHeightM).toBeNull();
    expect(facts?.ceilingSource).toBeNull();
    expect(facts?.tallCeilingPhrase).toBe(false);
  });

  it("Phase 14.6: stambyte, area source and fastighetsbeteckning are read from the text and the sentence is dropped", async () => {
    const f = brokerFakes(
      "Stambyte planeras 2027. Areauppgift enligt föreningen. Fastighetsbeteckning: Stockholm Droskhästen 8. Ring Anna Svensson 070-123 45 67.",
    );
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    const facts = result.facts.get(0);
    expect(facts?.textStambyte).toEqual({ lastYear: null, plannedYear: 2027, ongoing: false, relining: false });
    expect(facts?.plannedStambyteYear).toBe(2027);
    expect(facts?.stambyteStatus).toBe("planerat");
    expect(facts?.stambyteSource).toBe("maklartext");
    expect(facts?.areaSource).toBe("forening");
    expect(facts?.fastighetsbeteckning).toBe("Droskhästen 8");
    expect(facts?.beteckningRung).toBe("a");
    const stored = JSON.stringify([...result.facts.values()]);
    for (const piece of ["Svensson", "070-123", "Stambyte planeras", "Areauppgift"]) expect(stored).not.toContain(piece);
    expect(candidateFactsSchema.parse(facts)).toEqual(facts);
  });

  it("Phase 14.6: a description that says nothing about the building is read (false), not 'not read' (null)", async () => {
    const f = brokerFakes("Ljus etta med balkong.");
    const facts = (await enrichAllCandidates([candidate(1)], 1, opts(f.deps))).facts.get(0);
    expect(facts?.textStambyte).toEqual({ lastYear: null, plannedYear: null, ongoing: false, relining: false });
    expect(facts?.stambyteStatus).toBeNull();
    expect(facts?.stambyteSource).toBeNull();
    expect(facts?.areaSource).toBeNull();
    expect(facts?.fastighetsbeteckning).toBeNull();
    expect(facts?.beteckningRung).toBeNull();
  });

  it("Phase 14.6: with no description at all every stambyte, area and beteckning fact is null", async () => {
    const facts = (await enrichAllCandidates([candidate(1)], 1, opts(fakes().deps))).facts.get(0);
    for (const key of [
      "textStambyte",
      "lastStambyteYear",
      "plannedStambyteYear",
      "stambyteOngoing",
      "stambyteSource",
      "stambyteStatus",
      "reliningMentioned",
      "areaSource",
      "areaMeasuredYear",
      "areaMeasuredFirm",
      "fastighetsbeteckning",
      "beteckningRung",
    ] as const) {
      expect(facts?.[key], key).toBeNull();
    }
  });

  it("no broker URL and no Booli description: the three ceiling facts are null (not read)", async () => {
    const f = fakes();
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    const facts = result.facts.get(0);
    expect(facts?.ceilingHeightM).toBeNull();
    expect(facts?.ceilingSource).toBeNull();
    expect(facts?.tallCeilingPhrase).toBeNull();
  });

  it("falls back to the Booli detail description when there is no broker URL", async () => {
    const f = fakes({ fetchListing: vi.fn(async () => rawDetail({ description: "Sol hela dagen i vardagsrummet." })) });
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    expect(f.fetchBrokerListingPage).not.toHaveBeenCalled();
    expect(result.facts.get(0)?.descriptionRead).toBe(true);
    expect(result.facts.get(0)?.sunPhrases).toEqual(["sol hela dagen"]);
    expect(result.sunPhrases.get(0)).toEqual({ allDaySun: true, throughFlat: false });
  });

  it("the broker description beats the Booli description", async () => {
    const f = fakes({
      fetchListing: vi.fn(async () =>
        rawDetail({ description: "Tomträtt.", agencyListingUrl: "https://maklare.example/objekt/1" }),
      ),
      fetchBrokerListingPage: vi.fn(async () => ({ renovationStatus: null, description: "Friköpt tomt, morgonsol.", images: [] })),
    });
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    expect(result.facts.get(0)?.landLease).toBe(false);
    expect(result.facts.get(0)?.sunPhrases).toEqual(["morgonsol"]);
  });

  it("no broker URL and no Booli description: descriptionRead false, sunPhrases null, landLease null", async () => {
    const f = fakes();
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    const facts = result.facts.get(0);
    expect(facts?.descriptionRead).toBe(false);
    expect(facts?.sunPhrases).toBeNull();
    expect(facts?.landLease).toBeNull();
    expect(result.sunPhrases.has(0)).toBe(false);
  });

  it("detail facts carry tenure, avgift and listing age from the detail page", async () => {
    const f = fakes();
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    const facts = result.facts.get(0);
    expect(facts?.tenureForm).toBe("Bostadsrätt");
    expect(facts?.avgiftMonthlySek).toBe(4100);
    expect(facts?.daysOnMarket).toBe(42);
    expect(facts?.balcony).toBe(false);
  });
});

describe("areaAudit: the opt-in terminal hook (Phase 14.6, FLAG-02)", () => {
  const brokerFakes = (description: string | null) =>
    fakes({
      fetchListing: vi.fn(async () => rawDetail({ agencyListingUrl: "https://maklare.example/objekt/1" })),
      fetchBrokerListingPage: vi.fn(async () => ({ renovationStatus: null, description, images: [] })),
    });
  const TEXT = "Boarean är uppmätt av Svensk Areamätning 2019. Kontakta Anna Svensson på 070-123 45 67 eller anna@maklare.example.";

  it("is called once per read description with masked clauses and the parsed area facts, before the text is dropped", async () => {
    const areaAudit = vi.fn();
    const f = brokerFakes(TEXT);
    const result = await enrichAllCandidates([candidate(1), candidate(2)], 2, opts(f.deps, { areaAudit, concurrency: 1 }));
    expect(areaAudit).toHaveBeenCalledTimes(2);
    const [lines, areaFacts] = areaAudit.mock.calls[0] as [string[], Record<string, unknown>];
    expect(lines.length).toBeGreaterThan(0);
    const printed = lines.join("\n");
    expect(printed).toContain("▒");
    for (const name of ["Svensk", "Areamätning", "Anna", "Svensson", "070-123", "maklare.example"]) expect(printed).not.toContain(name);
    expect(areaFacts).toEqual({ areaSource: "uppmatt", areaMeasuredYear: 2019, areaMeasuredFirm: true });
    // The callback is for the terminal: what the run keeps carries none of it.
    const stored = JSON.stringify({ facts: [...result.facts.values()], candidates: result.candidates });
    for (const piece of ["Svensk", "Areamätning", "Anna", "Svensson", "070-123", "▒"]) expect(stored).not.toContain(piece);
  });

  it("is never called when the option is absent, and not for a candidate whose description was not read", async () => {
    const withText = await enrichAllCandidates([candidate(1)], 1, opts(brokerFakes(TEXT).deps));
    expect(withText.facts.get(0)?.areaSource).toBe("uppmatt");

    const areaAudit = vi.fn();
    await enrichAllCandidates([candidate(1)], 1, opts(fakes().deps, { areaAudit }));
    expect(areaAudit).not.toHaveBeenCalled();
  });

  it("a callback that throws costs nothing: the candidate is still enriched", async () => {
    const areaAudit = vi.fn(() => {
      throw new Error("terminal closed");
    });
    const result = await enrichAllCandidates([candidate(1)], 1, opts(brokerFakes(TEXT).deps, { areaAudit }));
    expect(areaAudit).toHaveBeenCalledTimes(1);
    expect(result.facts.get(0)?.areaSource).toBe("uppmatt");
    expect(result.facts.get(0)?.detailFetched).toBe(true);
  });
});

describe("broker photos", () => {
  const photoFakes = () =>
    fakes({
      fetchListing: vi.fn(async () => rawDetail({ agencyListingUrl: "https://maklare.example/objekt/1" })),
      fetchBrokerListingPage: vi.fn(async () => ({
        renovationStatus: null,
        description: null,
        images: ["https://cdn.maklare.example/1.jpg", "https://cdn.maklare.example/2.jpg"],
      })),
      fetchBrokerImageBytes: vi.fn(async (urls: string[]) => urls.map((u) => ({ mediaType: "image/jpeg", data: u }))),
    });

  it("up to 4 photos per candidate, with the job.ts broker bounds", async () => {
    const f = photoFakes();
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    expect(result.brokerImages.get(0)).toHaveLength(2);
    expect(f.fetchBrokerImageBytes.mock.calls[0][1]).toBe(4);
    expect((f.fetchBrokerImageBytes.mock.calls[0][2] as { timeoutMs: number }).timeoutMs).toBe(10_000);
    const page = f.fetchBrokerListingPage.mock.calls[0][1] as {
      directTimeoutMs: number;
      render: { waitSecs: number; maxRequestRetries: number };
    };
    expect(page.directTimeoutMs).toBe(15_000);
    expect(page.render).toEqual({ waitSecs: 45, maxRequestRetries: 1 });
  });

  it("fetchBrokerImages false reads the broker text but fetches no photo bytes", async () => {
    const f = photoFakes();
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps, { fetchBrokerImages: false }));
    expect(f.fetchBrokerListingPage).toHaveBeenCalledTimes(1);
    expect(f.fetchBrokerImageBytes).not.toHaveBeenCalled();
    expect(result.brokerImages.size).toBe(0);
  });

  it("keeps each map index aligned with the input index under concurrency", async () => {
    const f = fakes({
      fetchListing: vi.fn(async (url: string) => rawDetail({ agencyListingUrl: `https://maklare.example/objekt/${idOf(url)}` })),
      fetchBrokerListingPage: vi.fn(async (url: string) => ({
        renovationStatus: null,
        description: null,
        images: [`https://cdn.maklare.example/${idOf(url)}.jpg`],
      })),
      fetchBrokerImageBytes: vi.fn(async (urls: string[]) => [{ mediaType: "image/jpeg", data: urls[0] }]),
    });
    const input = [10, 11, 12, 13, 14].map((n) => candidate(n));
    const result = await enrichAllCandidates(input, 5, opts(f.deps, { concurrency: 3 }));
    input.forEach((c, i) => {
      expect(result.candidates[i].sourceListingUrl).toBe(c.sourceListingUrl);
      expect(result.brokerImages.get(i)).toEqual([{ mediaType: "image/jpeg", data: `https://cdn.maklare.example/${10 + i}.jpg` }]);
    });
  });
});

describe("deadline and concurrency", () => {
  it("after 2 reads the injected clock is past the deadline: the rest are untouched and never fetched", async () => {
    let clock = 0;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fakes({
      fetchListing: vi.fn(async () => {
        clock += 30_000;
        return rawDetail();
      }),
    });
    const input = [1, 2, 3, 4, 5].map((n) => candidate(n));
    const result = await enrichAllCandidates(input, 5, {
      deadlineMs: 60_000,
      concurrency: 1,
      asOf: AS_OF,
      deps: f.deps,
      now: () => clock,
    });

    expect(f.fetchListing).toHaveBeenCalledTimes(2);
    expect(result.candidates[0]).not.toBe(input[0]);
    expect(result.candidates[1]).not.toBe(input[1]);
    for (const i of [2, 3, 4]) {
      expect(result.candidates[i]).toBe(input[i]);
      expect(result.facts.has(i)).toBe(false);
    }
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("never has more reads in flight than opts.concurrency, and does use the allowance", async () => {
    let inFlight = 0;
    let peak = 0;
    const f = fakes({
      fetchListing: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return rawDetail();
      }),
    });
    const input = Array.from({ length: 9 }, (_, i) => candidate(i + 1));
    await enrichAllCandidates(input, 9, opts(f.deps, { concurrency: 3 }));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("BRF stage (R-07)", () => {
  /** A detail whose breadcrumb names association `brf`; reshapeListingEntity would set brfId the same way. */
  const detailOf = (brfByListing: Record<number, string | undefined>) =>
    vi.fn(async (url: string) => rawDetail({ brfId: brfByListing[idOf(url)] }));

  it("two rows of one association fetch its page once and both rows get the numbers", async () => {
    const input = [1, 2, 3].map((n) => candidate(n));
    const f = fakes({ fetchListing: detailOf({ 1: "81611", 2: "81611", 3: "79301" }) });
    const result = await enrichAllCandidates(input, 3, opts(f.deps));

    expect(f.fetchBrfFacts).toHaveBeenCalledTimes(2);
    expect(f.fetchBrfFacts.mock.calls.map((c) => c[0]).sort()).toEqual(["79301", "81611"]);
    expect(result.facts.get(0)?.brf).toEqual(BRF_FACTS);
    expect(result.facts.get(1)?.brf).toEqual(BRF_FACTS);
    expect(result.facts.get(2)?.brf).toEqual(BRF_FACTS);
    expect(result.brfStats).toEqual({ distinct: 2, fetched: 2, failed: 0 });
  });

  it("a failing association leaves brf null on its rows, counts failed, and the others still get theirs", async () => {
    const input = [1, 2, 3].map((n) => candidate(n));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fakes({
      fetchListing: detailOf({ 1: "81611", 2: "81611", 3: "79301" }),
      fetchBrfFacts: vi.fn(async (id: string) => {
        if (id === "81611") throw new Error("blocked https://www.booli.se/bostadsrattsforening/81611 secret-token-123");
        return BRF_FACTS;
      }),
    });
    const result = await enrichAllCandidates(input, 3, opts(f.deps));

    expect(result.facts.get(0)?.brf).toBeNull();
    expect(result.facts.get(1)?.brf).toBeNull();
    expect(result.facts.get(2)?.brf).toEqual(BRF_FACTS);
    expect(result.brfStats).toEqual({ distinct: 2, fetched: 1, failed: 1 });
    // The log carries the error name only, never its message.
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret-token-123");
    err.mockRestore();
  });

  it("rows without a brfId trigger no fetch", async () => {
    const f = fakes({ fetchListing: detailOf({}) });
    const result = await enrichAllCandidates([candidate(1), candidate(2)], 2, opts(f.deps));
    expect(f.fetchBrfFacts).not.toHaveBeenCalled();
    expect(result.brfStats).toEqual({ distinct: 0, fetched: 0, failed: 0 });
    expect(result.facts.get(0)?.brf).toBeNull();
  });

  it("a failed detail read has no facts, so its association is not fetched for it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fakes({
      fetchListing: vi.fn(async (url: string) => {
        if (idOf(url) === 1) throw new Error("blocked");
        return rawDetail({ brfId: "81611" });
      }),
    });
    const result = await enrichAllCandidates([candidate(1), candidate(2)], 2, opts(f.deps));
    expect(f.fetchBrfFacts).toHaveBeenCalledTimes(1);
    expect(result.facts.has(0)).toBe(false);
    expect(result.facts.get(1)?.brf).toEqual(BRF_FACTS);
    err.mockRestore();
  });

  it("a page that rendered without the labels is read (brf object with null fields), not failed", async () => {
    const empty = { loanSek: null, areaSqm: null, reportYear: null, debtPerSqm: null };
    const f = fakes({ fetchListing: detailOf({ 1: "81611" }), fetchBrfFacts: vi.fn(async () => empty) });
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps));
    expect(result.facts.get(0)?.brf).toEqual(empty);
    expect(result.brfStats).toEqual({ distinct: 1, fetched: 1, failed: 0 });
  });

  it("never runs more BRF pages at the same time than opts.concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const input = Array.from({ length: 6 }, (_, i) => candidate(i + 1));
    const f = fakes({
      fetchListing: vi.fn(async (url: string) => rawDetail({ brfId: String(100 + idOf(url)) })),
      fetchBrfFacts: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return BRF_FACTS;
      }),
    });
    await enrichAllCandidates(input, 6, opts(f.deps, { concurrency: 2 }));
    expect(f.fetchBrfFacts).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });

  it("an association not reached before the deadline counts as failed and is not fetched", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let clock = 0;
    const f = fakes({
      fetchListing: vi.fn(async (url: string) => {
        clock += 10;
        return rawDetail({ brfId: String(100 + idOf(url)) });
      }),
    });
    // Both reads start inside the 15 ms budget (clock 0 and 10); by the BRF stage the clock stands at 20.
    const result = await enrichAllCandidates([candidate(1), candidate(2)], 2, {
      ...opts(f.deps, { deadlineMs: 15, concurrency: 1 }),
      now: () => clock,
    });
    expect(result.facts.size).toBe(2);
    expect(f.fetchBrfFacts).not.toHaveBeenCalled();
    expect(result.brfStats).toEqual({ distinct: 2, fetched: 0, failed: 2 });
    err.mockRestore();
  });
});

describe("shouldStop: Booli's first refusal ends the stage (CR-01)", () => {
  it("never set: stoppedBy is null and everything is read", async () => {
    const f = fakes();
    const result = await enrichAllCandidates([candidate(1), candidate(2)], 2, opts(f.deps));
    expect(result.stoppedBy).toBeNull();
    expect(f.fetchListing).toHaveBeenCalledTimes(2);
  });

  it("once the hook says stop, no further detail page is requested and the rest keep their identity", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let challenged = 0;
    const f = fakes({
      fetchListing: vi.fn(async (url: string) => {
        if (idOf(url) === 3) {
          challenged += 1; // Booli refuses the third page
          throw new Error("Kunde inte hamta data fran Booli");
        }
        return rawDetail();
      }),
    });
    const input = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => candidate(n));
    const result = await enrichAllCandidates(input, 8, opts(f.deps, { concurrency: 1, shouldStop: () => challenged > 0 }));

    expect(f.fetchListing).toHaveBeenCalledTimes(3); // pages 4 to 8 were never asked for
    expect(result.stoppedBy).toBe("utmaning");
    for (const i of [2, 3, 4, 5, 6, 7]) expect(result.candidates[i]).toBe(input[i]);
    expect(result.candidates[0]).not.toBe(input[0]);
    expect(result.facts.size).toBe(2);
    err.mockRestore();
  });

  it("a stop already in force before the stage starts reads nothing at all, BRF stage included", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fakes();
    const result = await enrichAllCandidates([candidate(1), candidate(2)], 2, opts(f.deps, { shouldStop: () => true }));
    expect(f.fetchListing).not.toHaveBeenCalled();
    expect(f.fetchBrfFacts).not.toHaveBeenCalled();
    expect(result.stoppedBy).toBe("utmaning");
    err.mockRestore();
  });

  it("the BRF stage sends no Booli page after the stop, and counts the associations it did not reach as failed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let blocked = false;
    const f = fakes({
      fetchListing: vi.fn(async (url: string) => rawDetail({ brfId: String(100 + idOf(url)) })),
      fetchBrfFacts: vi.fn(async () => {
        blocked = true; // the first association page is the one Booli refuses
        throw new Error("Kunde inte hamta data fran Booli");
      }),
    });
    const input = [1, 2, 3, 4].map((n) => candidate(n));
    const result = await enrichAllCandidates(input, 4, opts(f.deps, { concurrency: 1, shouldStop: () => blocked }));
    expect(f.fetchListing).toHaveBeenCalledTimes(4);
    expect(f.fetchBrfFacts).toHaveBeenCalledTimes(1);
    expect(result.brfStats).toEqual({ distinct: 4, fetched: 0, failed: 4 });
    expect(result.stoppedBy).toBe("utmaning");
    err.mockRestore();
  });

  it("a refusal that arrives during the last page is still reported, although nothing was left to skip", async () => {
    let blocked = false;
    const f = fakes({
      fetchListing: vi.fn(async () => {
        blocked = true;
        return rawDetail();
      }),
    });
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps, { shouldStop: () => blocked }));
    expect(result.stoppedBy).toBe("utmaning");
    expect(result.facts.size).toBe(1);
  });

  it("a block seen while a page was in flight keeps that page but skips its broker leg", async () => {
    let blocked = false;
    const f = fakes({
      fetchListing: vi.fn(async () => {
        blocked = true;
        return rawDetail({ agencyListingUrl: "https://www.erikolsson.se/objekt/1" });
      }),
    });
    const result = await enrichAllCandidates([candidate(1)], 1, opts(f.deps, { shouldStop: () => blocked }));
    expect(f.fetchBrokerListingPage).not.toHaveBeenCalled();
    expect(result.candidates[0]).not.toBe(undefined);
    expect(result.facts.get(0)?.detailFetched).toBe(true);
  });

  it("a hook that throws counts as keep going", async () => {
    const f = fakes();
    const result = await enrichAllCandidates([candidate(1), candidate(2)], 2, opts(f.deps, {
      shouldStop: () => {
        throw new Error("hook broke");
      },
    }));
    expect(f.fetchListing).toHaveBeenCalledTimes(2);
    expect(result.stoppedBy).toBeNull();
  });

  it("a stop that was once true stays true even if the hook's counter later reads false", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const answers = [false, true, false, false, false, false, false];
    const f = fakes();
    const result = await enrichAllCandidates([1, 2, 3, 4].map((n) => candidate(n)), 4, opts(f.deps, {
      concurrency: 1,
      shouldStop: () => answers.shift() ?? false,
    }));
    expect(f.fetchListing).toHaveBeenCalledTimes(1);
    expect(result.stoppedBy).toBe("utmaning");
    err.mockRestore();
  });
});

describe("booliChallengeStop: the stop hook of the live run (CR-01, WR-01)", () => {
  it("stops at the first Booli challenge, and not before", () => {
    let challenged = 0;
    const stop = booliChallengeStop(() => ({ challenged }));
    expect(stop()).toBe(false);
    challenged = 1;
    expect(stop()).toBe(true);
  });

  it("without a local browser (Apify mode) it never stops", () => {
    expect(booliChallengeStop(() => null)()).toBe(false);
  });

  it("reads the Booli number only: a counter that also carries broker challenges does not stop the run", () => {
    const stop = booliChallengeStop(() => ({ challenged: 0, challengedBroker: 7 }) as { challenged: number });
    expect(stop()).toBe(false);
  });
});

describe("module hygiene (D-02)", () => {
  it("watch-enrich.ts does not import job.ts at run time, and job.ts does not import watch-enrich", () => {
    const watch = readFileSync(join(process.cwd(), "src/lib/discovery/watch-enrich.ts"), "utf-8");
    const job = readFileSync(join(process.cwd(), "src/lib/discovery/job.ts"), "utf-8");
    expect(watch).not.toMatch(/from "@\/lib\/discovery\/job"/);
    expect(job).not.toContain("watch-enrich");
  });
});
