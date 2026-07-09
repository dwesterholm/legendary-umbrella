import { describe, it, expect, vi, afterEach } from "vitest";

const fetchAllabrfDocument = vi.fn();
vi.mock("@/lib/brf-source/allabrf", () => ({
  fetchAllabrfDocument: (...args: unknown[]) => fetchAllabrfDocument(...args),
}));

const { fetchArsredovisning, walkBrfSources } = await import("@/lib/brf-source/fetch-document");

const ORG_NR = "5560360793";

describe("fetchArsredovisning", () => {
  afterEach(() => {
    fetchAllabrfDocument.mockReset();
    vi.restoreAllMocks();
  });

  it("returns a FetchedDocument with isMostRecent:false when a newer fiscal year is available", async () => {
    fetchAllabrfDocument.mockResolvedValue({
      text: "extracted text",
      fiscalYear: 2022,
      availableYears: [2020, 2021, 2022, 2023],
    });

    const result = await fetchArsredovisning(ORG_NR);

    expect(result).toEqual({
      source: "auto_allabrf",
      text: "extracted text",
      orgNr: ORG_NR,
      fiscalYear: 2022,
      isMostRecent: false,
    });
  });

  it("returns isMostRecent:true when the fetched year is the only/newest known year", async () => {
    fetchAllabrfDocument.mockResolvedValue({
      text: "extracted text",
      fiscalYear: 2022,
      availableYears: [2022],
    });

    const result = await fetchArsredovisning(ORG_NR);

    expect(result.isMostRecent).toBe(true);
  });

  it("returns isMostRecent:null (unknown, never fabricated true) when availableYears is empty", async () => {
    fetchAllabrfDocument.mockResolvedValue({
      text: "extracted text",
      fiscalYear: 2022,
      availableYears: [],
    });

    const result = await fetchArsredovisning(ORG_NR);

    expect(result.isMostRecent).toBeNull();
  });

  it("throws the distinguishable Swedish error and logs the failed rung when Allabrf returns null", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchAllabrfDocument.mockResolvedValue(null);

    await expect(fetchArsredovisning(ORG_NR)).rejects.toThrow(
      /Alla årsredovisningskällor misslyckades/,
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[brf-source] rung 1 (auto_allabrf) failed"),
    );
  });

  it("throws the distinguishable Swedish error and logs the failed rung when the rung throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchAllabrfDocument.mockRejectedValue(new Error("network exploded"));

    await expect(fetchArsredovisning(ORG_NR)).rejects.toThrow(
      /Alla årsredovisningskällor misslyckades/,
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[brf-source] rung 1 (auto_allabrf) failed"),
      expect.any(Error),
    );
  });

  it("never returns undefined/empty on failure — it always rejects", async () => {
    fetchAllabrfDocument.mockResolvedValue(null);
    let threw = false;
    try {
      await fetchArsredovisning(ORG_NR);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("walkBrfSources (local-walker discipline, tested directly)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not import walkFallbackTree (local-walker decision honored)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.join(process.cwd(), "src/lib/brf-source/fetch-document.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/walkFallbackTree/);
  });

  it("returns rung 1's result on success without trying later rungs", async () => {
    const rung1 = vi.fn().mockResolvedValue({
      source: "auto_allabrf" as const,
      text: "t",
      orgNr: ORG_NR,
      fiscalYear: 2022,
      isMostRecent: true,
    });
    const rung2 = vi.fn();

    const result = await walkBrfSources([
      { source: "auto_allabrf", attempt: rung1 },
      { source: "auto_bolagsverket", attempt: rung2 },
    ]);

    expect(result.source).toBe("auto_allabrf");
    expect(rung1).toHaveBeenCalledTimes(1);
    expect(rung2).not.toHaveBeenCalled();
  });

  it("falls through to rung 2 when rung 1 throws, logging the failed rung", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rung1 = vi.fn().mockRejectedValue(new Error("rung1 fail"));
    const rung2 = vi.fn().mockResolvedValue({
      source: "auto_bolagsverket" as const,
      text: "t2",
      orgNr: ORG_NR,
      fiscalYear: 2023,
      isMostRecent: true,
    });

    const result = await walkBrfSources([
      { source: "auto_allabrf", attempt: rung1 },
      { source: "auto_bolagsverket", attempt: rung2 },
    ]);

    expect(result.source).toBe("auto_bolagsverket");
    expect(errorSpy).toHaveBeenCalledWith(
      "[brf-source] rung 1 (auto_allabrf) failed",
      expect.any(Error),
    );
  });

  it("throws a loud, immediate error for a rung list longer than 3 (IN-04)", async () => {
    const rung = vi.fn().mockResolvedValue({
      source: "auto_allabrf" as const,
      text: "t",
      orgNr: ORG_NR,
      fiscalYear: 2022,
      isMostRecent: true,
    });

    await expect(
      walkBrfSources([
        { source: "auto_allabrf", attempt: rung },
        { source: "auto_bolagsverket", attempt: rung },
        { source: "auto_allabrf", attempt: rung },
        { source: "auto_bolagsverket", attempt: rung },
      ]),
    ).rejects.toThrow(/at most 3 rungs/);

    expect(rung).not.toHaveBeenCalled();
  });

  it("throws the Swedish exhaustion message when every rung fails or returns null", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rung1 = vi.fn().mockResolvedValue(null);
    const rung2 = vi.fn().mockRejectedValue(new Error("dead"));

    await expect(
      walkBrfSources([
        { source: "auto_allabrf", attempt: rung1 },
        { source: "auto_bolagsverket", attempt: rung2 },
      ]),
    ).rejects.toThrow(/Alla årsredovisningskällor misslyckades/);

    expect(errorSpy).toHaveBeenCalledWith("[brf-source] rung 1 (auto_allabrf) failed");
    expect(errorSpy).toHaveBeenCalledWith(
      "[brf-source] rung 2 (auto_bolagsverket) failed",
      expect.any(Error),
    );
  });
});
