import { describe, it, expect } from "vitest";
import { isValidOrgNr, resolveOrgNr, type OrgNrCandidate } from "@/lib/brf-source/org-nr-resolver";

describe("isValidOrgNr", () => {
  it("accepts a valid Luhn 10-digit org.nr", () => {
    expect(isValidOrgNr("5560360793")).toBe(true);
  });

  it("rejects a bad-Luhn 10-digit org.nr", () => {
    expect(isValidOrgNr("5560360794")).toBe(false);
  });

  it("rejects a string of the wrong length", () => {
    expect(isValidOrgNr("55603607")).toBe(false);
  });

  it("rejects a non-numeric string", () => {
    expect(isValidOrgNr("abc")).toBe(false);
  });

  it("accepts the hyphenated NNNNNN-NNNN form of a valid org.nr", () => {
    expect(isValidOrgNr("556036-0793")).toBe(true);
  });

  it("rejects a string with more than one hyphen", () => {
    expect(isValidOrgNr("556-036-0793")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidOrgNr("")).toBe(false);
  });
});

describe("resolveOrgNr", () => {
  const validOrgNr = "5560360793";
  const anotherValidOrgNr = "2120000142"; // Luhn-valid, distinct candidate

  it("returns none when brfName is null", () => {
    const result = resolveOrgNr({ brfName: null, kommun: "Stockholm", candidates: [] });
    expect(result).toEqual({ confidence: "none" });
  });

  it("returns none when brfName is an empty string", () => {
    const result = resolveOrgNr({ brfName: "   ", kommun: "Stockholm", candidates: [] });
    expect(result).toEqual({ confidence: "none" });
  });

  it("returns none when there are zero name-matching candidates", () => {
    const candidates: OrgNrCandidate[] = [
      { orgNr: validOrgNr, name: "Brf Ekorren", kommun: "Stockholm" },
    ];
    const result = resolveOrgNr({ brfName: "Brf Björken", kommun: "Stockholm", candidates });
    expect(result).toEqual({ confidence: "none" });
  });

  it("returns high confidence for exactly one name+kommun match with a valid org.nr", () => {
    const candidates: OrgNrCandidate[] = [
      { orgNr: validOrgNr, name: "Bostadsrättsföreningen Björken", kommun: "Stockholm" },
    ];
    const result = resolveOrgNr({ brfName: "Brf Björken", kommun: "Stockholm", candidates });
    expect(result).toEqual({
      confidence: "high",
      orgNr: validOrgNr,
      matchedName: "Bostadsrättsföreningen Björken",
    });
  });

  it("treats 'Bostadsrättsföreningen Björken' and 'Brf Björken' as the same normalized name", () => {
    const candidates: OrgNrCandidate[] = [
      { orgNr: validOrgNr, name: "brf   björken", kommun: "Stockholm" },
    ];
    const result = resolveOrgNr({
      brfName: "  BOSTADSRÄTTSFÖRENINGEN BJÖRKEN  ",
      kommun: "stockholm",
      candidates,
    });
    expect(result.confidence).toBe("high");
  });

  it("returns low confidence when two candidates match the name (ambiguous, never auto-fetch)", () => {
    const candidates: OrgNrCandidate[] = [
      { orgNr: validOrgNr, name: "Brf Björken", kommun: "Stockholm" },
      { orgNr: anotherValidOrgNr, name: "Brf Björken", kommun: "Göteborg" },
    ];
    const result = resolveOrgNr({ brfName: "Brf Björken", kommun: "Stockholm", candidates });
    expect(result.confidence).toBe("low");
    if (result.confidence === "low") {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("returns low confidence on a kommun mismatch — the wrong-BRF guard (name-only is never high)", () => {
    const candidates: OrgNrCandidate[] = [
      { orgNr: validOrgNr, name: "Brf Björken", kommun: "Göteborg" },
    ];
    const result = resolveOrgNr({ brfName: "Brf Björken", kommun: "Stockholm", candidates });
    expect(result).toEqual({
      confidence: "low",
      candidates: [{ orgNr: validOrgNr, name: "Brf Björken" }],
    });
  });

  it("returns low confidence when no geographic signal is available (listing kommun is null)", () => {
    const candidates: OrgNrCandidate[] = [
      { orgNr: validOrgNr, name: "Brf Björken", kommun: "Stockholm" },
    ];
    const result = resolveOrgNr({ brfName: "Brf Björken", kommun: null, candidates });
    expect(result.confidence).toBe("low");
  });

  it("returns low confidence when the candidate's own kommun is unknown (null)", () => {
    const candidates: OrgNrCandidate[] = [
      { orgNr: validOrgNr, name: "Brf Björken", kommun: null },
    ];
    const result = resolveOrgNr({ brfName: "Brf Björken", kommun: "Stockholm", candidates });
    expect(result.confidence).toBe("low");
  });

  it("returns low confidence when the single matched candidate has a bad-Luhn org.nr", () => {
    const candidates: OrgNrCandidate[] = [
      { orgNr: "5560360794", name: "Brf Björken", kommun: "Stockholm" },
    ];
    const result = resolveOrgNr({ brfName: "Brf Björken", kommun: "Stockholm", candidates });
    expect(result.confidence).toBe("low");
  });
});

describe("resolveOrgNr — no network I/O", () => {
  it("the module imports no fetch/undici/http", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.join(process.cwd(), "src/lib/brf-source/org-nr-resolver.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from ["']undici["']/);
    expect(src).not.toMatch(/from ["']node:http["']/);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});
