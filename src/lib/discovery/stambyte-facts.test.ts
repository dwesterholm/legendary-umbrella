import { describe, expect, it } from "vitest";
import { areaFactsFromText } from "@/lib/discovery/area-source";
import {
  STAMBYTE_SOURCES,
  STAMBYTE_STATUSES,
  mergeStambyte,
  stambyteFromAnnualReport,
  type CityStambyteReading,
} from "@/lib/discovery/stambyte-facts";
import { stambyteFromText, type StambyteTextFacts } from "@/lib/discovery/stambyte-text";

const RUN = { runYear: 2026 };

const city = (over: Partial<CityStambyteReading> = {}): CityStambyteReading => ({
  lastStambyteYear: null,
  lastStambyteBasis: null,
  stambyteOngoing: false,
  reliningCase: false,
  ...over,
});

const text = (over: Partial<StambyteTextFacts> = {}): StambyteTextFacts => ({
  lastYear: null,
  plannedYear: null,
  ongoing: false,
  relining: false,
  ...over,
});

describe("constants", () => {
  it("the sources run strongest first and the statuses are the three the column shows", () => {
    expect([...STAMBYTE_SOURCES]).toEqual(["bygglov_stockholm", "arsredovisning", "maklartext"]);
    expect([...STAMBYTE_STATUSES]).toEqual(["genomfort", "pagar", "planerat"]);
  });
});

describe("tracer: one broker text, two readers", () => {
  const TRACER = "Stambyte genomfört 2018. Areauppgift enligt föreningen.";

  it("the stambyte reader finds 2018 and nothing else", () => {
    expect(stambyteFromText(TRACER, RUN)).toEqual({ lastYear: 2018, plannedYear: null, ongoing: false, relining: false });
  });

  it("the area reader finds the association as the source and no measurement", () => {
    expect(areaFactsFromText(TRACER, RUN)).toEqual({
      areaSource: "forening",
      areaMeasuredYear: null,
      areaMeasuredFirm: null,
    });
  });

  it("null text is not read: all null from both readers", () => {
    expect(stambyteFromText(null, RUN)).toEqual({ lastYear: null, plannedYear: null, ongoing: null, relining: null });
    expect(areaFactsFromText(null, RUN)).toEqual({ areaSource: null, areaMeasuredYear: null, areaMeasuredFirm: null });
  });

  it("an empty text is not read either", () => {
    expect(stambyteFromText("", RUN)).toEqual({ lastYear: null, plannedYear: null, ongoing: null, relining: null });
    expect(areaFactsFromText("", RUN)).toEqual({ areaSource: null, areaMeasuredYear: null, areaMeasuredFirm: null });
  });

  it("a text with nothing relevant is read and says nothing", () => {
    const nothing = "Ljus och fräsch tvåa med öppen planlösning. Hiss i huset.";
    expect(stambyteFromText(nothing, RUN)).toEqual({ lastYear: null, plannedYear: null, ongoing: false, relining: false });
    expect(areaFactsFromText(nothing, RUN)).toEqual({ areaSource: null, areaMeasuredYear: null, areaMeasuredFirm: null });
  });

  it("the text reading feeds the merge as the weakest source", () => {
    const merged = mergeStambyte({ city: null, report: null, text: stambyteFromText(TRACER, RUN) });
    expect(merged.lastStambyteYear).toBe(2018);
    expect(merged.stambyteSource).toBe("maklartext");
    expect(merged.stambyteStatus).toBe("genomfort");
  });
});

describe("mergeStambyte: the city wins per D-07", () => {
  it("a city year beats a text year: 2006 from bygglov_stockholm, status genomfort", () => {
    const merged = mergeStambyte({
      city: city({ lastStambyteYear: 2006, lastStambyteBasis: "start" }),
      report: null,
      text: text({ lastYear: 2018 }),
    });
    expect(merged).toEqual({
      lastStambyteYear: 2006,
      plannedStambyteYear: null,
      stambyteOngoing: false,
      stambyteSource: "bygglov_stockholm",
      stambyteStatus: "genomfort",
      reliningMentioned: false,
    });
  });

  it("a planned year in the text makes the status planerat from maklartext and keeps the city's last year", () => {
    const merged = mergeStambyte({
      city: city({ lastStambyteYear: 2006, lastStambyteBasis: "start" }),
      report: null,
      text: text({ lastYear: 2018, plannedYear: 2027 }),
    });
    expect(merged.stambyteStatus).toBe("planerat");
    expect(merged.plannedStambyteYear).toBe(2027);
    expect(merged.stambyteSource).toBe("maklartext");
    expect(merged.lastStambyteYear).toBe(2006);
  });

  it("a city stambyte under way is pagar from bygglov_stockholm, even over a text plan", () => {
    const merged = mergeStambyte({
      city: city({ stambyteOngoing: true }),
      report: null,
      text: text({ plannedYear: 2027 }),
    });
    expect(merged.stambyteStatus).toBe("pagar");
    expect(merged.stambyteSource).toBe("bygglov_stockholm");
    expect(merged.stambyteOngoing).toBe(true);
  });

  it("a text 'pågår' alone is pagar from maklartext", () => {
    const merged = mergeStambyte({ city: null, report: null, text: text({ ongoing: true }) });
    expect(merged.stambyteStatus).toBe("pagar");
    expect(merged.stambyteSource).toBe("maklartext");
    expect(merged.stambyteOngoing).toBe(true);
  });
});

describe("mergeStambyte: the annual report (arsredovisning)", () => {
  it("'planerat' alone is planerat with no year, from arsredovisning", () => {
    const merged = mergeStambyte({ city: null, report: "planerat", text: null });
    expect(merged.stambyteStatus).toBe("planerat");
    expect(merged.plannedStambyteYear).toBeNull();
    expect(merged.stambyteSource).toBe("arsredovisning");
    expect(merged.lastStambyteYear).toBeNull();
  });

  it("'nyligen_genomfort' alone is genomfort with no year, from arsredovisning", () => {
    const merged = mergeStambyte({ city: null, report: "nyligen_genomfort", text: null });
    expect(merged.stambyteStatus).toBe("genomfort");
    expect(merged.lastStambyteYear).toBeNull();
    expect(merged.stambyteSource).toBe("arsredovisning");
  });

  it("'ej_nämnt' alone gives nothing at all", () => {
    expect(mergeStambyte({ city: null, report: "ej_nämnt", text: null })).toEqual({
      lastStambyteYear: null,
      plannedStambyteYear: null,
      stambyteOngoing: null,
      stambyteSource: null,
      stambyteStatus: null,
      reliningMentioned: null,
    });
  });

  it("the report beats the text for the source of a status, and the city beats the report", () => {
    const withText = mergeStambyte({ city: null, report: "nyligen_genomfort", text: text({ lastYear: 2018 }) });
    expect(withText.stambyteSource).toBe("arsredovisning");
    expect(withText.lastStambyteYear).toBe(2018);
    const withCity = mergeStambyte({
      city: city({ lastStambyteYear: 2015, lastStambyteBasis: "slutbesked" }),
      report: "nyligen_genomfort",
      text: null,
    });
    expect(withCity.stambyteSource).toBe("bygglov_stockholm");
    expect(withCity.lastStambyteYear).toBe(2015);
  });

  it("the report's 'planerat' wins the source over a text plan", () => {
    const merged = mergeStambyte({ city: null, report: "planerat", text: text({ plannedYear: 2028 }) });
    expect(merged.stambyteSource).toBe("arsredovisning");
    expect(merged.plannedStambyteYear).toBe(2028);
  });
});

describe("mergeStambyte: a source wins only with a positive finding", () => {
  it("a city record with no year and nothing ongoing never erases a text year", () => {
    const merged = mergeStambyte({ city: city(), report: null, text: text({ lastYear: 2018 }) });
    expect(merged.lastStambyteYear).toBe(2018);
    expect(merged.stambyteSource).toBe("maklartext");
    expect(merged.stambyteStatus).toBe("genomfort");
  });

  it("a city 'not ongoing' never cancels a text 'pågår'", () => {
    const merged = mergeStambyte({ city: city({ stambyteOngoing: false }), report: null, text: text({ ongoing: true }) });
    expect(merged.stambyteOngoing).toBe(true);
    expect(merged.stambyteStatus).toBe("pagar");
  });

  it("a city that was read and found nothing says ongoing false and no relining, not null", () => {
    const merged = mergeStambyte({ city: city(), report: null, text: null });
    expect(merged.stambyteOngoing).toBe(false);
    expect(merged.reliningMentioned).toBe(false);
    expect(merged.stambyteStatus).toBeNull();
  });

  it("nothing read at all is all null", () => {
    expect(mergeStambyte({ city: null, report: null, text: null })).toEqual({
      lastStambyteYear: null,
      plannedStambyteYear: null,
      stambyteOngoing: null,
      stambyteSource: null,
      stambyteStatus: null,
      reliningMentioned: null,
    });
  });

  it("relining is carried from the text or the city and never becomes a year or a status", () => {
    const fromText = mergeStambyte({ city: null, report: null, text: text({ relining: true }) });
    expect(fromText.reliningMentioned).toBe(true);
    expect(fromText.lastStambyteYear).toBeNull();
    expect(fromText.stambyteStatus).toBeNull();
    const fromCity = mergeStambyte({ city: city({ reliningCase: true }), report: null, text: null });
    expect(fromCity.reliningMentioned).toBe(true);
    expect(fromCity.stambyteStatus).toBeNull();
  });
});

describe("stambyteFromAnnualReport: a Map lookup, no prototype chain", () => {
  it("maps the three enum values", () => {
    expect(stambyteFromAnnualReport("planerat")).toBe("planerat");
    expect(stambyteFromAnnualReport("nyligen_genomfort")).toBe("genomfort");
    expect(stambyteFromAnnualReport("ej_nämnt")).toBeNull();
  });

  it("'toString' and other object members are nothing", () => {
    for (const bad of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(stambyteFromAnnualReport(bad), bad).toBeNull();
      expect(mergeStambyte({ city: null, report: bad, text: null }).stambyteStatus, bad).toBeNull();
    }
  });

  it("a non-enum string, the old spelling with ö, and non-strings are nothing", () => {
    for (const bad of ["", "genomfört", "nyligen_genomfört", "PLANERAT", " planerat", null, undefined, 3, {}, []]) {
      expect(stambyteFromAnnualReport(bad)).toBeNull();
    }
  });
});
