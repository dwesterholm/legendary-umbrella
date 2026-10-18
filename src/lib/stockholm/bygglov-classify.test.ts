import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BYGGLOV_RULES,
  BYGGLOV_RULES_VERSION,
  BYGGLOV_TEXT_MAX_CHARS,
  CASE_KINDS,
  type CaseKind,
  type StoredCase,
  applyDetail,
  buildingFactsOf,
  classifyDescription,
  decisionKind,
  isStambyteKinds,
  needsDetail,
  toStoredCase,
} from "@/lib/stockholm/bygglov-classify";
import { type CaseListRow, parseCaseDetail, parseCaseList } from "@/lib/stockholm/bygglov-parse";

const fixture = (name: string): string => readFileSync(join(__dirname, "__fixtures__", `${name}.fixture.html`), "utf8");

const rowsOf = (name: string): CaseListRow[] => {
  const parsed = parseCaseList(fixture(name));
  if (!parsed.ok) throw new Error(`parse failed: ${name}`);
  return [...parsed.rows, ...parsed.otherRows];
};

const AS_OF = "2026-10-18";

/** A stored case built by hand for the fact tests; every field has a quiet default. */
function stored(over: Partial<Omit<StoredCase, "kinds">> & { startDate: string; kinds: readonly CaseKind[] }): StoredCase {
  return {
    rec: "1",
    diarie: "2025-00001",
    primary: over.kinds[0],
    tillsyn: false,
    archived: false,
    detailRead: false,
    latest: null,
    startbeskedDate: null,
    slutbeskedDate: null,
    closedDate: null,
    ...over,
  };
}

describe("constants", () => {
  it("the rules version is 1 and the text is capped at 2 000 characters", () => {
    expect(BYGGLOV_RULES_VERSION).toBe(1);
    expect(BYGGLOV_TEXT_MAX_CHARS).toBe(2_000);
  });
});

describe("classifyDescription: the sweep pages", () => {
  const stambyteSweep = rowsOf("ext-sodermalm-stambyte-1985");
  const balkongSweep = rowsOf("ext-sodermalm-balkong-2025-06");

  it("every row of the 380-row stambyte sweep carries stambyte, and relining is never inferred from them", () => {
    expect(stambyteSweep).toHaveLength(380);
    for (const row of stambyteSweep) {
      const c = classifyDescription(row.description);
      expect(c.kinds, row.description ?? "").toContain("stambyte");
      expect(c.kinds).not.toContain("relining");
    }
  });

  it("balcony sweep: 'Inglasning av balkong...' rows are balkong_inglasning", () => {
    const glazing = balkongSweep.filter((r) => /^inglasning av balkong/i.test(r.description ?? ""));
    expect(glazing.length).toBeGreaterThanOrEqual(20);
    for (const row of glazing) expect(classifyDescription(row.description).kinds).toContain("balkong_inglasning");
  });

  it("balcony sweep: 'Uppförande av balkong...' rows are balkong_ny", () => {
    const built = balkongSweep.filter((r) => /^uppförande av (en )?balkong/i.test(r.description ?? ""));
    expect(built.length).toBeGreaterThanOrEqual(20);
    for (const row of built) expect(classifyDescription(row.description).kinds).toContain("balkong_ny");
  });

  it("renovation and repair of a balcony is balkong_renovering and never balkong_ny", () => {
    for (const text of [
      "Ändring/renovering av balkonger",
      "Skrivelse/anmälan om balkong med reparationsbehov",
      "Renovering av takterasser och balkonger",
      "Yttre ändring, renovering av balkonger och terrasser",
      "Tillsynsanmälan, balkong som rasat",
      "Nya balkongplattor, stambyte, total renovering av våtrum",
    ]) {
      const c = classifyDescription(text);
      expect(c.kinds, text).toContain("balkong_renovering");
      expect(c.kinds, text).not.toContain("balkong_ny");
      expect(c.kinds, text).not.toContain("balkong_inglasning");
    }
  });

  it("'Tillsynsanmälan, olovligt byte av balkongdörrar' has tillsyn true and the tag balkongdorr, not a new balcony", () => {
    const c = classifyDescription("Tillsynsanmälan, olovligt byte av balkongdörrar");
    expect(c.tillsyn).toBe(true);
    expect(c.kinds).toEqual(["balkongdorr"]);
  });

  it("'olovligt' anywhere makes tillsyn, and an ordinary description is not tillsyn", () => {
    expect(classifyDescription("(Anmälan om olovligt stambyte och ingrepp i bärande konstruktion)")).toMatchObject({
      tillsyn: true,
      kinds: ["stambyte"],
    });
    expect(classifyDescription("Anmaning att låta åtgärda hiss").tillsyn).toBe(true);
    expect(classifyDescription("Uppförande av balkong på flerbostadshus").tillsyn).toBe(false);
  });
});

describe("classifyDescription: tag sets and the primary kind", () => {
  it("a multi-work text carries every tag and the primary is stambyte", () => {
    const c = classifyDescription(
      "Fasadändring, takomläggning, renovering av fasad, inredning av ytterligare bostad på vind, stambyte",
    );
    expect(c.kinds).toEqual(["stambyte", "vind_inredning", "fasad", "tak"]);
    expect(c.primary).toBe("stambyte");
  });

  it("the priority is relining, stambyte, balkong_inglasning, balkong_ny, balkongdorr, balkong_renovering, hiss, vind, fasad, tak", () => {
    const c = classifyDescription(
      "Relining av stammar, stambyte, inglasning av balkong, nya balkonger, byte av balkongdörrar, renovering av balkong, ny hiss, inredning av vind, fasadrenovering, takbyte",
    );
    expect(c.kinds).toEqual([
      "relining",
      "stambyte",
      "balkong_inglasning",
      "balkong_ny",
      "balkongdorr",
      "balkong_renovering",
      "hiss",
      "vind_inredning",
      "fasad",
      "tak",
    ]);
    expect(c.primary).toBe("relining");
  });

  it("relining is its own tag and not a stambyte", () => {
    for (const text of ["Relining av avloppsstammar", "Avloppsstammar relinade"]) {
      const c = classifyDescription(text);
      expect(c.kinds, text).toContain("relining");
      expect(c.kinds, text).not.toContain("stambyte");
    }
  });

  it("'Ändring 1 tr 3 tr' and 'Skylt, Lådskylt' are annat", () => {
    for (const text of ["Ändring 1 tr 3 tr", "Skylt, Lådskylt", "", "  "]) {
      expect(classifyDescription(text)).toMatchObject({ kinds: ["annat"], primary: "annat", tillsyn: false });
    }
    expect(classifyDescription(null).primary).toBe("annat");
  });

  it("stambyte spellings seen in the city data", () => {
    for (const text of [
      "Stambyte i flerbostadshus, anmälningsärende",
      "VA-stambyte",
      "Stambyten med renovering av WC och kök",
      "Stambyte av lägenheter, med nya stamlägen",
      "utbyte av vatten och avloppsstammar",
      "Byte av stammar",
      "Stamrenovering av flerbostadshus",
    ]) {
      expect(classifyDescription(text).kinds, text).toContain("stambyte");
    }
  });

  it("words that only look like the keywords are not tagged", () => {
    expect(classifyDescription("Ändring av vindfång").kinds).toEqual(["annat"]);
    expect(classifyDescription("Montering av balkongräcke").kinds).not.toContain("balkong_ny");
    expect(classifyDescription("Uppsättning av fasadskylt").kinds).toEqual(["annat"]);
    expect(classifyDescription("Renovering av takterrass").kinds).not.toContain("vind_inredning");
    expect(classifyDescription("Uppförande av takterrass").kinds).toContain("vind_inredning");
    expect(classifyDescription("Besiktning av hissar").kinds).toContain("hiss");
  });

  it("text beyond the cap is not read", () => {
    const text = `${"x".repeat(BYGGLOV_TEXT_MAX_CHARS + 10)} stambyte`;
    expect(classifyDescription(text).kinds).toEqual(["annat"]);
  });
});

describe("classifyDescription: the 556 real descriptions (a regression guard, not a precision measure)", () => {
  // The samples were selected by keyword (the stambyte and balcony sweeps) plus the whole of Droskhästen 8,
  // so these counts show that a rule change moved something. They do not say how often a rule is right.
  const union = new Map<string, CaseListRow>();
  for (const name of ["list-droskhasten-8", "ext-sodermalm-stambyte-1985", "ext-sodermalm-balkong-2025-06"]) {
    for (const row of rowsOf(name)) union.set(row.rec, row);
  }
  const classified = [...union.values()].map((row) => classifyDescription(row.description));

  const PINNED_TAGS: Record<CaseKind, number> = {
    balkong_ny: 59,
    balkong_inglasning: 25,
    balkongdorr: 33,
    balkong_renovering: 14,
    stambyte: 380,
    relining: 0,
    hiss: 22,
    vind_inredning: 24,
    fasad: 42,
    tak: 6,
    annat: 57,
  };
  const PINNED_PRIMARY: Record<CaseKind, number> = {
    balkong_ny: 59,
    balkong_inglasning: 25,
    balkongdorr: 4,
    balkong_renovering: 12,
    stambyte: 380,
    relining: 0,
    hiss: 9,
    vind_inredning: 5,
    fasad: 4,
    tak: 1,
    annat: 57,
  };

  it("the union is 556 distinct cases", () => {
    expect(union.size).toBe(556);
  });

  for (const kind of CASE_KINDS) {
    it(`${kind}: tag count and primary count are pinned`, () => {
      expect(classified.filter((c) => c.kinds.includes(kind)).length).toBe(PINNED_TAGS[kind]);
      expect(classified.filter((c) => c.primary === kind).length).toBe(PINNED_PRIMARY[kind]);
    });
  }

  it("the primary counts add up to every case and 12 cases are tillsyn", () => {
    expect(Object.values(PINNED_PRIMARY).reduce((a, b) => a + b, 0)).toBe(556);
    expect(classified.filter((c) => c.tillsyn)).toHaveLength(12);
  });

  it("no tillsyn case carries balkong_ny or balkong_inglasning", () => {
    for (const c of classified.filter((x) => x.tillsyn)) {
      expect(c.kinds).not.toContain("balkong_ny");
      expect(c.kinds).not.toContain("balkong_inglasning");
    }
  });
});

describe("classifyDescription: bounded work (T-14.6-03)", () => {
  it("a 50 000-character input classifies in under 50 ms", () => {
    for (const text of ["balkong ".repeat(6_250), "a".repeat(50_000), "nya ".repeat(12_500), "stam ".repeat(10_000), "inredning av ".repeat(3_850)]) {
      const started = performance.now();
      classifyDescription(text);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it("no rule pattern has an unbounded quantifier", () => {
    for (const rule of BYGGLOV_RULES) {
      // drop escapes (\p{L}, \s, \d ...) first, then look for * + or an open-ended {n,}
      const bare = rule.pattern.source.replace(/\\./g, "").replace(/\\p\{[A-Za-z]+\}/g, "");
      expect(bare, rule.pattern.source).not.toMatch(/[*+]|\{\d+,\}/);
    }
  });

  it("the module source has no .* .+ or {n,} outside comments", () => {
    const source = readFileSync(join(__dirname, "bygglov-classify.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/\.\*|\.\+|\{\d+,\}/);
  });
});

describe("decisionKind", () => {
  it("maps the known types", () => {
    expect(decisionKind("Startbesked", "Bifall")).toBe("startbesked");
    expect(decisionKind("Lov med startbesked", "Bifall")).toBe("lov");
    expect(decisionKind("Lovbeslut", "Bifall")).toBe("lov");
    expect(decisionKind("Slutbesked / slutbevis", "Bifall")).toBe("slutbesked");
    expect(decisionKind("Slutbesked / slutbevis", null)).toBe("slutbesked");
    expect(decisionKind("Interimistiskt slutbesked", "Bifall")).toBe("slutbesked");
    expect(decisionKind("Beslut", "Bifall")).toBe("beslut");
  });

  it("the code wins for Avskrivet and Avslag, whatever the type", () => {
    expect(decisionKind("Beslut", "Avskrivet")).toBe("avskrivet");
    expect(decisionKind("Startbesked", "Avskrivet")).toBe("avskrivet");
    expect(decisionKind("Lovbeslut", "Avslag")).toBe("avslag");
  });

  it("anything else is okand, never guessed", () => {
    expect(decisionKind("Beslut", null)).toBe("okand");
    expect(decisionKind("Tillsynsbeslut", "Bifall")).toBe("okand");
    expect(decisionKind("Föreläggande", null)).toBe("okand");
    expect(decisionKind(null, null)).toBe("okand");
  });

  it("is case and spacing tolerant", () => {
    expect(decisionKind("  SLUTBESKED  /  slutbevis ", "bifall")).toBe("slutbesked");
  });
});

describe("applyDetail and needsDetail on real detail pages", () => {
  const base = (rec: string, startDate: string, kinds: CaseKind[]): StoredCase => stored({ rec, startDate, kinds, diarie: "2020-14734" });

  it("the 2020 stambyte gets startbesked, slutbesked and closing dates and detailRead", () => {
    const parsed = parseCaseDetail(fixture("case-stambyte-2020-startbesked-slutbesked"));
    if (!parsed.ok) throw new Error("parse failed");
    const filled = applyDetail(base("1208902", "2020-10-28", ["stambyte"]), parsed.detail);
    expect(filled).toMatchObject({
      detailRead: true,
      startbeskedDate: "2020-12-08",
      slutbeskedDate: "2023-03-15",
      closedDate: "2023-03-16",
      latest: { type: "Slutbesked / slutbevis", code: "Bifall", date: "2023-03-15" },
    });
  });

  it("the 2017 balcony renovation is closed as Avskrivet and has no startbesked", () => {
    const parsed = parseCaseDetail(fixture("case-balkong-2017-avskrivet"));
    if (!parsed.ok) throw new Error("parse failed");
    const filled = applyDetail(base("1150705", "2017-09-07", ["balkong_renovering"]), parsed.detail);
    expect(filled.latest).toEqual({ type: "Beslut", code: "Avskrivet", date: "2018-04-12" });
    expect(filled.startbeskedDate).toBeNull();
    expect(filled.slutbeskedDate).toBeNull();
  });

  it("the archived 2006 case: a Beslut with no code, nothing granted, nothing finished", () => {
    const parsed = parseCaseDetail(fixture("case-stambyte-2006-archived"));
    if (!parsed.ok) throw new Error("parse failed");
    const filled = applyDetail(base("15347864", "2006-04-24", ["stambyte"]), parsed.detail);
    expect(filled.latest).toEqual({ type: "Beslut", code: null, date: "2006-06-15" });
    expect(filled.startbeskedDate).toBeNull();
    expect(filled.closedDate).toBe("2008-12-22");
  });

  it("a detail page for another case is refused", () => {
    const parsed = parseCaseDetail(fixture("case-stambyte-2020-startbesked-slutbesked"));
    if (!parsed.ok) throw new Error("parse failed");
    expect(() => applyDetail(base("999", "2020-10-28", ["stambyte"]), parsed.detail)).toThrow();
  });

  it("words from the city are cleaned to plain text before they are stored", () => {
    const detail = {
      rec: null,
      diarie: "x",
      startDate: null,
      closedDate: null,
      estates: [],
      decisions: [{ date: "2025-01-01", type: "Beslut <b>x</b>\n", code: "Bifall; drop table" }],
    };
    const filled = applyDetail(base("1", "2025-01-01", ["hiss"]), detail);
    expect(filled.latest?.type).toBe("Beslut bx/b");
    expect(filled.latest?.code).toBe("Bifall drop table");
  });

  it("needsDetail: an interesting kind started within five years and not read yet", () => {
    expect(needsDetail(base("1", "2023-10-05", ["vind_inredning"]), AS_OF)).toBe(true);
    expect(needsDetail(base("1", "2021-12-27", ["hiss"]), AS_OF)).toBe(true);
    expect(needsDetail(base("1", "2020-12-02", ["hiss"]), AS_OF)).toBe(false);
    expect(needsDetail(base("1", "2025-03-02", ["fasad"]), AS_OF)).toBe(false);
    expect(needsDetail(base("1", "2025-03-02", ["annat"]), AS_OF)).toBe(false);
    expect(needsDetail(base("1", "2025-03-02", ["balkong_renovering"]), AS_OF)).toBe(false);
    expect(needsDetail(base("1", "2025-03-02", ["stambyte"]), AS_OF)).toBe(true);
    expect(needsDetail(base("1", "2027-01-01", ["stambyte"]), AS_OF)).toBe(false);
    expect(needsDetail({ ...base("1", "2025-03-02", ["stambyte"]), detailRead: true }, AS_OF)).toBe(false);
    expect(needsDetail({ ...base("1", "2025-03-02", ["stambyte"]), tillsyn: true }, AS_OF)).toBe(false);
  });

  it("Droskhästen 8: exactly the vind 2023-10 and hiss 2021-12 cases want a detail page", () => {
    const stores = rowsOf("list-droskhasten-8")
      .filter((r) => r.caseType === "Byggärende")
      .map((r) => toStoredCase(r, classifyDescription(r.description)));
    const wanted = stores.filter((c) => needsDetail(c, AS_OF)).map((c) => [c.primary, c.startDate]);
    expect(wanted).toEqual([
      ["vind_inredning", "2023-10-05"],
      ["hiss", "2021-12-27"],
    ]);
  });
});

describe("buildingFactsOf: the balcony flags", () => {
  const granted = (over: Partial<StoredCase> = {}) =>
    stored({
      startDate: "2025-03-02",
      kinds: ["balkong_ny"],
      detailRead: true,
      latest: { type: "Startbesked", code: "Bifall", date: "2025-03-20" },
      startbeskedDate: "2025-03-20",
      ...over,
    });

  it("a new balcony with a startbesked and no slutbesked is granted but not built, month 2025-03", () => {
    const facts = buildingFactsOf([granted()], AS_OF);
    expect(facts.balkongBeviljadEjByggd).toBe(true);
    expect(facts.balkongBeviljadMonth).toBe("2025-03");
  });

  it("a slutbesked makes it false", () => {
    const facts = buildingFactsOf(
      [granted({ slutbeskedDate: "2026-02-10", latest: { type: "Slutbesked / slutbevis", code: "Bifall", date: "2026-02-10" } })],
      AS_OF,
    );
    expect(facts.balkongBeviljadEjByggd).toBe(false);
    expect(facts.balkongBeviljadMonth).toBeNull();
  });

  it("Avskrivet or Avslag makes it false", () => {
    for (const code of ["Avskrivet", "Avslag"]) {
      const facts = buildingFactsOf([granted({ latest: { type: "Beslut", code, date: "2025-06-01" } })], AS_OF);
      expect(facts.balkongBeviljadEjByggd, code).toBe(false);
    }
  });

  it("tillsyn makes it false", () => {
    expect(buildingFactsOf([granted({ tillsyn: true })], AS_OF).balkongBeviljadEjByggd).toBe(false);
  });

  it("balkong_renovering alone and balkongdorr alone never set it", () => {
    for (const kinds of [["balkong_renovering"], ["balkongdorr"]] as CaseKind[][]) {
      expect(buildingFactsOf([granted({ kinds })], AS_OF).balkongBeviljadEjByggd, kinds[0]).toBe(false);
    }
  });

  it("a qualifying case whose decisions were not read gives null, never false", () => {
    const unread = stored({ startDate: "2025-03-02", kinds: ["balkong_ny"] });
    const facts = buildingFactsOf([unread], AS_OF);
    expect(facts.balkongBeviljadEjByggd).toBeNull();
    expect(facts.balkongInglasningAnsokt).toBe(false);
    expect(buildingFactsOf([unread, granted({ rec: "2" })], AS_OF).balkongBeviljadEjByggd).toBe(true);
  });

  it("a balcony case older than five years does not count", () => {
    expect(buildingFactsOf([granted({ startDate: "2016-03-31", startbeskedDate: "2016-05-01" })], AS_OF).balkongBeviljadEjByggd).toBe(false);
    expect(buildingFactsOf([stored({ startDate: "2016-03-31", kinds: ["balkong_ny"] })], AS_OF).balkongBeviljadEjByggd).toBe(false);
  });

  it("a glazing application started 2026-09-10 with no decision is on file (month 2026-09)", () => {
    const facts = buildingFactsOf(
      [stored({ startDate: "2026-09-10", kinds: ["balkong_inglasning"], detailRead: true })],
      AS_OF,
    );
    expect(facts.balkongInglasningAnsokt).toBe(true);
    expect(facts.inglasningMonth).toBe("2026-09");
    expect(facts.balkongBeviljadEjByggd).toBe(false);
  });

  it("a glazing application whose decisions were not read gives null", () => {
    const facts = buildingFactsOf([stored({ startDate: "2026-09-10", kinds: ["balkong_inglasning"] })], AS_OF);
    expect(facts.balkongInglasningAnsokt).toBeNull();
    expect(facts.inglasningMonth).toBeNull();
  });

  it("a granted glazing is granted-not-built and no longer an open application", () => {
    const facts = buildingFactsOf([granted({ kinds: ["balkong_inglasning"] })], AS_OF);
    expect(facts.balkongBeviljadEjByggd).toBe(true);
    expect(facts.balkongInglasningAnsokt).toBe(false);
  });
});

describe("buildingFactsOf: stambyte", () => {
  it("a stambyte with a startbesked 2025-05 and no slutbesked is under way", () => {
    const facts = buildingFactsOf(
      [
        stored({
          startDate: "2025-04-01",
          kinds: ["stambyte"],
          detailRead: true,
          latest: { type: "Startbesked", code: "Bifall", date: "2025-05-12" },
          startbeskedDate: "2025-05-12",
        }),
      ],
      AS_OF,
    );
    expect(facts.stambyteOngoing).toBe(true);
    expect(facts.lastStambyteYear).toBeNull();
  });

  it("the 2020 to 2023 stambyte gives 2023 on the slutbesked, and is not ongoing", () => {
    const facts = buildingFactsOf(
      [
        stored({
          startDate: "2020-10-28",
          kinds: ["stambyte"],
          detailRead: true,
          latest: { type: "Slutbesked / slutbevis", code: "Bifall", date: "2023-03-15" },
          startbeskedDate: "2020-12-08",
          slutbeskedDate: "2023-03-15",
          closedDate: "2023-03-16",
        }),
      ],
      AS_OF,
    );
    expect(facts.lastStambyteYear).toBe(2023);
    expect(facts.lastStambyteBasis).toBe("slutbesked");
    expect(facts.stambyteOngoing).toBe(false);
  });

  it("the slutbesked year wins over a newer start-only case", () => {
    const facts = buildingFactsOf(
      [
        stored({ rec: "1", startDate: "2012-01-01", kinds: ["stambyte"], detailRead: true, slutbeskedDate: "2014-06-01" }),
        stored({ rec: "2", startDate: "2019-01-01", kinds: ["stambyte"] }),
      ],
      AS_OF,
    );
    expect(facts.lastStambyteYear).toBe(2014);
    expect(facts.lastStambyteBasis).toBe("slutbesked");
  });

  it("without a slutbesked the start year counts only when the case started more than three years ago", () => {
    const old = buildingFactsOf([stored({ startDate: "2019-02-02", kinds: ["stambyte"] })], AS_OF);
    expect(old).toMatchObject({ lastStambyteYear: 2019, lastStambyteBasis: "start" });
    const young = buildingFactsOf([stored({ startDate: "2024-02-02", kinds: ["stambyte"], detailRead: true })], AS_OF);
    expect(young.lastStambyteYear).toBeNull();
    expect(young.lastStambyteBasis).toBeNull();
  });

  it("a stambyte closed as Avskrivet counts for nothing", () => {
    const facts = buildingFactsOf(
      [stored({ startDate: "2018-02-02", kinds: ["stambyte"], detailRead: true, latest: { type: "Beslut", code: "Avskrivet", date: "2018-09-01" } })],
      AS_OF,
    );
    expect(facts.lastStambyteYear).toBeNull();
  });

  it("a recent stambyte whose decisions were not read gives stambyteOngoing null", () => {
    expect(buildingFactsOf([stored({ startDate: "2025-04-01", kinds: ["stambyte"] })], AS_OF).stambyteOngoing).toBeNull();
    expect(buildingFactsOf([], AS_OF).stambyteOngoing).toBe(false);
  });

  it("a relining-only case gives reliningCase true and lastStambyteYear null", () => {
    const facts = buildingFactsOf([stored({ startDate: "2015-01-01", kinds: ["relining"] })], AS_OF);
    expect(facts.reliningCase).toBe(true);
    expect(facts.lastStambyteYear).toBeNull();
  });

  it("WR-03: a case tagged both relining and stambyte is a relining: no stambyte year, reliningCase true", () => {
    for (const text of ["Stambyte genom relining", "Stambyte med relining av stammar", "Ej stambyte, enbart relining"]) {
      const c = classifyDescription(text);
      expect([...c.kinds].sort(), text).toEqual(["relining", "stambyte"]);
      expect(isStambyteKinds(c.kinds), text).toBe(false);
      const facts = buildingFactsOf(
        [stored({ startDate: "2015-01-01", kinds: c.kinds, detailRead: true, slutbeskedDate: "2016-05-05" })],
        AS_OF,
      );
      expect(facts.lastStambyteYear, text).toBeNull();
      expect(facts.lastStambyteBasis, text).toBeNull();
      expect(facts.reliningCase, text).toBe(true);
    }
    expect(isStambyteKinds(classifyDescription("Stambyte i flerbostadshus").kinds)).toBe(true);
  });

  it("a stambyte tillsyn case is not a recorded stambyte", () => {
    const facts = buildingFactsOf([stored({ startDate: "2015-01-01", kinds: ["stambyte"], tillsyn: true })], AS_OF);
    expect(facts.lastStambyteYear).toBeNull();
  });
});

describe("buildingFactsOf: time, the short list and unknown decisions", () => {
  it("a case that starts after asOf changes nothing", () => {
    const before = buildingFactsOf([stored({ startDate: "2019-02-02", kinds: ["stambyte"] })], AS_OF);
    const withFuture = buildingFactsOf(
      [
        stored({ rec: "1", startDate: "2019-02-02", kinds: ["stambyte"] }),
        stored({ rec: "2", startDate: "2026-11-01", kinds: ["stambyte", "balkong_ny"], detailRead: true, startbeskedDate: "2026-11-05", slutbeskedDate: "2026-12-01" }),
      ],
      AS_OF,
    );
    expect(withFuture).toEqual(before);
  });

  it("the short list is newest first, at most six, interesting kinds only, no enforcement cases", () => {
    const cases: StoredCase[] = [];
    for (let i = 0; i < 8; i += 1) cases.push(stored({ rec: String(100 + i), startDate: `2024-0${i + 1}-10`, kinds: ["hiss"] }));
    cases.push(stored({ rec: "200", startDate: "2025-09-01", kinds: ["fasad"] }));
    cases.push(stored({ rec: "201", startDate: "2025-09-02", kinds: ["hiss"], tillsyn: true }));
    const facts = buildingFactsOf(cases, AS_OF);
    expect(facts.recent).toHaveLength(6);
    expect(facts.recent[0]).toEqual({ kind: "hiss", month: "2024-08", decision: null });
    expect(facts.recent.map((r) => r.month)).toEqual(["2024-08", "2024-07", "2024-06", "2024-05", "2024-04", "2024-03"]);
  });

  it("a decision label shows in the short list once the detail is read", () => {
    const facts = buildingFactsOf(
      [stored({ startDate: "2025-03-02", kinds: ["balkong_ny"], detailRead: true, latest: { type: "Startbesked", code: "Bifall", date: "2025-03-20" }, startbeskedDate: "2025-03-20" })],
      AS_OF,
    );
    expect(facts.recent).toEqual([{ kind: "balkong_ny", month: "2025-03", decision: "startbesked" }]);
  });

  it("decision types the table does not know are counted", () => {
    const facts = buildingFactsOf(
      [
        stored({ rec: "1", startDate: "2024-01-01", kinds: ["hiss"], detailRead: true, latest: { type: "Tillsynsbeslut", code: "Bifall", date: "2024-02-01" } }),
        stored({ rec: "2", startDate: "2024-03-01", kinds: ["hiss"], detailRead: true, latest: { type: "Startbesked", code: "Bifall", date: "2024-04-01" } }),
      ],
      AS_OF,
    );
    expect(facts.unknownDecisionTypes).toBe(1);
  });
});

describe("no personal data in stored cases", () => {
  it("the keys of a stored case are fixed, and a sentence cannot be put in one", () => {
    const row = rowsOf("list-droskhasten-8")[0];
    const c = toStoredCase(row, classifyDescription(row.description));
    expect(Object.keys(c).sort()).toEqual(
      [
        "archived",
        "closedDate",
        "detailRead",
        "diarie",
        "kinds",
        "latest",
        "primary",
        "rec",
        "slutbeskedDate",
        "startDate",
        "startbeskedDate",
        "tillsyn",
      ].sort(),
    );
  });
});
