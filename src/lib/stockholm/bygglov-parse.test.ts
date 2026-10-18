import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildingFactsOf, classifyDescription, toStoredCase } from "@/lib/stockholm/bygglov-classify";
import { exactMatchRows, parseCaseList } from "@/lib/stockholm/bygglov-parse";

const fixture = (name: string): string => readFileSync(join(__dirname, "__fixtures__", `${name}.fixture.html`), "utf8");

const AS_OF = "2026-10-18";

describe("Droskhästen 8 / Folkungagatan 61: the saved list page end to end (tracer)", () => {
  const html = fixture("list-droskhasten-8");
  const parsed = parseCaseList(html);

  it("parses into 53 build cases and 27 other cases, every row exact-matched on the beteckning", () => {
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.reason}`);
    expect(parsed.rows).toHaveLength(53);
    expect(parsed.otherRows).toHaveLength(27);
    expect(parsed.headingCount).toBe(53);
    expect(exactMatchRows(parsed.rows, "Droskhästen 8")).toHaveLength(53);
    expect(exactMatchRows(parsed.rows, " droskhästen   8 ")).toHaveLength(53);
    expect(exactMatchRows(parsed.rows, "Droskhästen 80")).toHaveLength(0);
    for (const row of [...parsed.rows, ...parsed.otherRows]) {
      expect(row.beteckning).toBe("Droskhästen 8");
      expect(row.rec).toMatch(/^\d{1,12}$/);
      expect(row.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("splits the two-street addresses on the escaped comma", () => {
    if (!parsed.ok) throw new Error("parse failed");
    const both = parsed.rows.filter((r) => r.addresses.length === 2);
    expect(both.length).toBeGreaterThan(0);
    expect(both[0].addresses).toEqual(["Folkungagatan 61", "Östgötagatan 33"]);
  });

  it("stored cases carry no description key and none of the fixture's sentences", () => {
    if (!parsed.ok) throw new Error("parse failed");
    const stored = parsed.rows.map((row) => toStoredCase(row, classifyDescription(row.description)));
    for (const c of stored) {
      expect(Object.keys(c).map((k) => k.toLowerCase())).not.toContain("description");
    }
    const json = JSON.stringify(stored);
    for (const row of parsed.rows) {
      // every sentence of the page (the longest are the most telling) must be absent from the stored form
      expect(json).not.toContain(row.description as string);
    }
    expect(json).not.toContain("takfönster");
    expect(json).not.toContain("stoltrapphiss");
  });

  it("Folkungagatan 61's building: stambyte 2006 from the start year, no balcony flag, vind 2023-10 then hiss 2021-12", () => {
    if (!parsed.ok) throw new Error("parse failed");
    const stored = parsed.rows.map((row) => toStoredCase(row, classifyDescription(row.description)));
    const facts = buildingFactsOf(stored, AS_OF);

    expect(facts.lastStambyteYear).toBe(2006);
    expect(facts.lastStambyteBasis).toBe("start");
    expect(facts.stambyteOngoing).toBe(false);
    expect(facts.reliningCase).toBe(false);
    expect(facts.balkongBeviljadEjByggd).toBe(false);
    expect(facts.balkongBeviljadMonth).toBeNull();
    expect(facts.balkongInglasningAnsokt).toBe(false);
    expect(facts.inglasningMonth).toBeNull();
    expect(facts.recent.map((r) => [r.kind, r.month])).toEqual([
      ["vind_inredning", "2023-10"],
      ["hiss", "2021-12"],
    ]);
  });
});
