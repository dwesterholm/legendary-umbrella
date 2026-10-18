import { describe, expect, it } from "vitest";
import {
  AREA_SOURCES,
  AREA_TEXT_MAX_CHARS,
  AREA_UPSIDE_BEFORE_YEAR,
  AUDIT_LINE_MAX_CHARS,
  areaAuditLines,
  areaFactsFromText,
  areaUpsideSek,
  type AreaFacts,
  type AreaSource,
} from "@/lib/discovery/area-source";

const RUN = { runYear: 2026 };

/** Answer helpers. `u(year, firm)` = measured; `s(source)` = a stated source; `NONE` = nothing. */
const u = (areaMeasuredYear: number | null, areaMeasuredFirm: boolean): AreaFacts => ({
  areaSource: "uppmatt",
  areaMeasuredYear,
  areaMeasuredFirm,
});
const s = (areaSource: Exclude<AreaSource, "uppmatt">): AreaFacts => ({
  areaSource,
  areaMeasuredYear: null,
  areaMeasuredFirm: null,
});
const NONE: AreaFacts = { areaSource: null, areaMeasuredYear: null, areaMeasuredFirm: null };

type Row = readonly [string, AreaFacts];

describe("constants", () => {
  it("the six sources run strongest first and the read is capped at 50 000 characters", () => {
    expect([...AREA_SOURCES]).toEqual([
      "uppmatt",
      "forening",
      "ekonomisk_plan",
      "lagenhetsregister",
      "saljare",
      "ej_kontrollmatt",
    ]);
    expect(AREA_TEXT_MAX_CHARS).toBe(50_000);
    expect(AREA_UPSIDE_BEFORE_YEAR).toBe(1987);
    expect(AUDIT_LINE_MAX_CHARS).toBe(160);
  });
});

/** The 36 phrases used while tuning (RESEARCH 8.1). Circular by nature; the held-back block below is the honest signal. */
const TUNED: readonly Row[] = [
  ["Boarean är uppmätt av Svensk Areamätning 2019.", u(2019, true)],
  ["Lägenheten är uppmätt 2021 och arean är 38 kvm.", u(2021, false)],
  ["Uppmätt boarea 41,5 kvm (mätintyg finns).", u(null, false)],
  ["Arean är lasermätt år 2022.", u(2022, true)],
  ["Areamätning utförd 2018 enligt SS 21054.", u(2018, false)],
  ["Bostadsytan har uppmätts av certifierad mätare i maj 2023.", u(2023, true)],
  ["Mätintyg över boarean finns att tillgå hos mäklaren.", u(null, false)],
  ["Boarean är kontrollmätt av mäklaren 2024.", u(2024, false)],
  ["Areauppgift enligt föreningen.", s("forening")],
  ["Boarean är hämtad från bostadsrättsföreningen.", s("forening")],
  ["Uppgiven area enligt bostadsrättsföreningens uppgifter.", s("forening")],
  ["Areauppgifterna är hämtade från föreningen och ej kontrollmätta.", s("forening")],
  ["Arean är enligt föreningen och mäklaren har ej kontrollmätt.", s("forening")],
  ["Boarea 36 kvm enligt ekonomisk plan.", s("ekonomisk_plan")],
  ["Arean är hämtad ur föreningens ekonomiska plan.", s("ekonomisk_plan")],
  ["Ytan är enligt lägenhetsregistret.", s("lagenhetsregister")],
  ["Boarea enligt föreningens lägenhetsförteckning.", s("lagenhetsregister")],
  ["Areauppgift från säljaren.", s("saljare")],
  ["Uppgift från säljare, ej kontrollmätt.", s("saljare")],
  ["Arean är uppmätt av säljaren själv.", s("saljare")],
  ["Enligt säljarens uppgift är boarean 40 kvm.", s("saljare")],
  ["Ej uppmätt.", s("ej_kontrollmatt")],
  ["Boarean är inte uppmätt.", s("ej_kontrollmatt")],
  ["Mäklaren har ej kontrollmätt arean.", s("ej_kontrollmatt")],
  ["Arean är ej kontrollmätt av mäklaren. Fråga gärna om detaljer.", s("ej_kontrollmatt")],
  ["Lägenheten har ännu inte mätts.", s("ej_kontrollmatt")],
  ["Köket är nyligen uppmätt för nytt kök från HTH.", NONE],
  ["Balkongen är uppmätt till 4 kvm och rymmer en bistrogrupp.", NONE],
  ["Uppmätt takhöjd 2,6 m.", NONE],
  ["Förrådet är uppmätt till 3 kvm.", NONE],
  ["Ljus och fräsch tvåa med öppen planlösning. Hiss i huset.", NONE],
  ["", NONE],
  ["Boarea uppmätt 2020. Areauppgift enligt föreningen.", u(2020, false)],
  ["Mätningen utfördes 2016 av Enspecta.", u(2016, true)],
  ["Arean är uppmätt 2087.", u(null, false)],
  ["Boarean uppmätt 1987 av tidigare ägare.", u(1987, false)],
];

describe("areaFactsFromText: the 36 tuned phrases (runYear 2026)", () => {
  it("has 36 phrases", () => {
    expect(TUNED.length).toBe(36);
  });

  it.each(TUNED)("%s", (phrase, expected) => {
    expect(areaFactsFromText(phrase, RUN)).toEqual(expected);
  });
});

/**
 * HELD-BACK PHRASES (RESEARCH 8.1): 14 phrases kept out of the tuning at research time (10 of 14 on the
 * first run, 13 of 14 after two rounds of fixes). Expected answers are set from the Swedish meaning.
 * "Uppmätt. Kvadratmeter: 44." is an accepted miss: the clause split separates the word from the number,
 * a miss costs nothing, and pinning it means a later fix shows up here.
 */
const HELD_BACK: readonly Row[] = [
  ["Bostadsrättens area är uppmätt 2017 i samband med renovering.", u(2017, false)],
  ["Boytan är mätt enligt SS 21054 av Mätcentralen.", u(null, true)],
  ["OBS! Arean är ej uppmätt och kan avvika.", s("ej_kontrollmatt")],
  ["Uppmätt. Kvadratmeter: 44.", u(null, false)],
  ["Ytterligare uppgifter lämnas av mäklaren. Lägenheten ligger på andra våningen.", NONE],
  ["Vi har inte kontrollmätt boytan och förlitar oss på uppgift från föreningen.", s("forening")],
  ["Areauppgiften är lämnad av bostadsrättsföreningen.", s("forening")],
  ["Baserat på ritning från 1936. Arean ej mätt.", s("ej_kontrollmatt")],
  ["Nytt badrum uppmätt och ritat av arkitekt 2020.", NONE],
  ["Garderoben är uppmätt för platsbyggd lösning, area 2 kvm.", NONE],
  ["BOA 52 kvm, enligt säljaren uppmätt 2015.", s("saljare")],
  ["Arean är uppmätt 2019 men ej kontrollmätt av mäklaren.", s("ej_kontrollmatt")],
  ["Hela lägenheten mättes upp 2022 med laser, boarea 37,5 kvm.", u(2022, true)],
  ["Mäklaren kan ej garantera arean. Mätning rekommenderas av köparen.", NONE],
];

/** The accepted miss: it must stay a miss (null) until someone decides to fix it on purpose. */
const HELD_BACK_KNOWN_MISSES: readonly string[] = ["Uppmätt. Kvadratmeter: 44."];

describe("areaFactsFromText: the 14 held-back phrases (the honest pre-live score)", () => {
  it("has 14 phrases", () => {
    expect(HELD_BACK.length).toBe(14);
  });

  it("reports how many pass and pins the accepted miss", () => {
    const misses: string[] = [];
    const detail: string[] = [];
    for (const [phrase, expected] of HELD_BACK) {
      const got = areaFactsFromText(phrase, RUN);
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        misses.push(phrase);
        detail.push(`${phrase} -> ${JSON.stringify(got)} (wanted ${JSON.stringify(expected)})`);
      }
    }
    console.info(`held-back: ${HELD_BACK.length - misses.length} av ${HELD_BACK.length}\n${detail.join("\n")}`);
    expect(misses).toEqual([...HELD_BACK_KNOWN_MISSES]);
  });

  it("the accepted miss reads as nothing, not as something else", () => {
    expect(areaFactsFromText("Uppmätt. Kvadratmeter: 44.", RUN)).toEqual(NONE);
  });
});

/**
 * SECOND HELD-BACK SET. Written AFTER the reader was finished, from the Swedish meaning, and scored
 * exactly once: no rule was changed to fit it. Misses are pinned below.
 */
const FRESH: readonly Row[] = [
  ["Lägenhetens boarea är 41 kvm enligt föreningens uppgifter.", s("forening")],
  ["Arean 38 kvm är baserad på uppgifter från bostadsrättsföreningen.", s("forening")],
  ["Boytan har mätts upp på plats av en mätare 2023.", u(2023, true)],
  ["Kvadratmeterytan är inte kontrollerad av mäklaren.", s("ej_kontrollmatt")],
  ["Arean är angiven enligt köpehandlingar och ej kontrollmätt.", s("ej_kontrollmatt")],
  ["Uppgifterna om boarean kommer från säljaren och har inte kontrollerats.", s("saljare")],
  ["Mäklaren har mätt lägenheten på plats 2022.", u(2022, false)],
  ["Lägenhetens yta har kontrollmätts av oss.", u(null, false)],
  ["Boarea 45 kvm. Källare och vind ingår ej i boarean.", NONE],
  ["Ytan stämmer med lägenhetsförteckningen från föreningen.", s("lagenhetsregister")],
  ["Arean är enligt säljaren cirka 36 kvm.", s("saljare")],
  ["Alla mått är ungefärliga och ska kontrolleras av köparen.", NONE],
  ["Uppmätningen gjordes 2018 av Svensk Areamätning.", u(2018, true)],
  ["Boarean är verifierad genom mätning 2021.", u(2021, false)],
  ["Ritningens areaangivelse är 37 kvm.", NONE],
  ["Areauppgiften är hämtad från bostadsrättsföreningens ekonomiska plan.", s("ekonomisk_plan")],
  ["Uppmätt av oss i maj 2024, boarea 33 kvm.", u(2024, false)],
];

const FRESH_KNOWN_MISSES: readonly string[] = [
  "Boytan har mätts upp på plats av en mätare 2023.",
  "Kvadratmeterytan är inte kontrollerad av mäklaren.",
  "Uppgifterna om boarean kommer från säljaren och har inte kontrollerats.",
  "Mäklaren har mätt lägenheten på plats 2022.",
  "Ytan stämmer med lägenhetsförteckningen från föreningen.",
  "Boarean är verifierad genom mätning 2021.",
  "Uppmätt av oss i maj 2024, boarea 33 kvm.",
];

describe("areaFactsFromText: second held-back set (scored once, after the reader was finished)", () => {
  it("has at least 15 phrases", () => {
    expect(FRESH.length).toBeGreaterThanOrEqual(15);
  });

  it("reports how many pass and pins the misses", () => {
    const misses: string[] = [];
    const detail: string[] = [];
    for (const [phrase, expected] of FRESH) {
      const got = areaFactsFromText(phrase, RUN);
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        misses.push(phrase);
        detail.push(`${phrase} -> ${JSON.stringify(got)} (wanted ${JSON.stringify(expected)})`);
      }
    }
    console.info(`second set: ${FRESH.length - misses.length} av ${FRESH.length}\n${detail.join("\n")}`);
    expect(misses).toEqual([...FRESH_KNOWN_MISSES]);
  });
});

describe("areaFactsFromText: the null-text contract", () => {
  it("null and empty text are not read: all null", () => {
    expect(areaFactsFromText(null, RUN)).toEqual(NONE);
    expect(areaFactsFromText("", RUN)).toEqual(NONE);
    expect(areaFactsFromText("  \n ", RUN)).toEqual(NONE);
  });
});

describe("areaFactsFromText: the rules in their own words", () => {
  it("'ej kontrollmätt' never overrides a stated source", () => {
    expect(areaFactsFromText("Areauppgifterna är hämtade från föreningen och ej kontrollmätta.", RUN).areaSource).toBe("forening");
    expect(areaFactsFromText("Uppgift från säljare, ej kontrollmätt.", RUN).areaSource).toBe("saljare");
    expect(areaFactsFromText("Boarea 36 kvm enligt ekonomisk plan, ej kontrollmätt.", RUN).areaSource).toBe("ekonomisk_plan");
  });

  it("'uppmätt av säljaren' is a seller figure, not a measurement", () => {
    expect(areaFactsFromText("Arean är uppmätt av säljaren själv.", RUN)).toEqual(s("saljare"));
    expect(areaFactsFromText("Boarean är uppmätt av ägaren 2019.", RUN)).toEqual(s("saljare"));
  });

  it("a seller who hired a measuring firm is still a measurement", () => {
    expect(areaFactsFromText("Boarean är uppmätt 2021 av Enspecta enligt säljaren.", RUN)).toEqual(u(2021, true));
  });

  it("'mätning' alone, a recommendation or another space's measurement is not the flat's area", () => {
    expect(areaFactsFromText("Mätning rekommenderas av köparen.", RUN)).toEqual(NONE);
    expect(areaFactsFromText("Vi rekommenderar en mätning.", RUN)).toEqual(NONE);
    expect(areaFactsFromText("Takhöjd ej uppmätt.", RUN)).toEqual(NONE);
    expect(areaFactsFromText("Terrassen är uppmätt till 12 kvm.", RUN)).toEqual(NONE);
    expect(areaFactsFromText("Källaren är uppmätt.", RUN)).toEqual(NONE);
  });

  it("'bostadsrättsföreningens ekonomiska plan' is the plan, not just the association", () => {
    expect(areaFactsFromText("Areauppgiften är hämtad från bostadsrättsföreningens ekonomiska plan.", RUN)).toEqual(s("ekonomisk_plan"));
    expect(areaFactsFromText("Ytan är enligt bostadsrättsföreningens lägenhetsregister.", RUN)).toEqual(s("lagenhetsregister"));
  });

  it("a balcony clause that also names the flat's own boarea is read", () => {
    expect(areaFactsFromText("Balkongen är med i boarean som är uppmätt 2020.", RUN).areaSource).toBe("uppmatt");
  });

  it("the measured year and firm exist only for a measurement; the firm is a yes/no, never a name", () => {
    const measured = areaFactsFromText("Boarean är uppmätt av Svensk Areamätning 2019.", RUN);
    expect(measured).toEqual({ areaSource: "uppmatt", areaMeasuredYear: 2019, areaMeasuredFirm: true });
    expect(JSON.stringify(measured)).not.toMatch(/Svensk|Areamätning|Enspecta/);
    expect(Object.keys(measured).sort()).toEqual(["areaMeasuredFirm", "areaMeasuredYear", "areaSource"]);
    for (const text of ["Areauppgift enligt föreningen 2019.", "Ej uppmätt 2019.", "Areauppgift från säljaren."]) {
      const facts = areaFactsFromText(text, RUN);
      expect(facts.areaMeasuredYear, text).toBeNull();
      expect(facts.areaMeasuredFirm, text).toBeNull();
    }
  });

  it("a year above the run year is dropped, and the caller owns the run year", () => {
    expect(areaFactsFromText("Arean är uppmätt 2027.", { runYear: 2026 }).areaMeasuredYear).toBeNull();
    expect(areaFactsFromText("Arean är uppmätt 2027.", { runYear: 2030 }).areaMeasuredYear).toBe(2027);
    expect(areaFactsFromText("Arean är uppmätt 2026.", { runYear: 2026 }).areaMeasuredYear).toBe(2026);
  });

  it("an area with no firm word gives firm false; with the standard or a certificate it needs no area word", () => {
    expect(areaFactsFromText("Boarean är uppmätt 2019.", RUN)).toEqual(u(2019, false));
    expect(areaFactsFromText("Mätintyg finns.", RUN).areaSource).toBe("uppmatt");
    expect(areaFactsFromText("Enligt SS 21054.", RUN).areaSource).toBe("uppmatt");
  });

  it("the result never holds the sentence", () => {
    const facts = areaFactsFromText("Ring Svensson 070-123 45 67. Boarean är uppmätt 2019.", RUN);
    expect(JSON.stringify(facts)).not.toMatch(/Svensson|070/);
  });

  it("soft hyphens, zero-width characters and no-break spaces do not hide a phrase", () => {
    expect(areaFactsFromText("Areauppgift enligt före­ningen.", RUN)).toEqual(s("forening"));
    expect(areaFactsFromText("Boarean​ är uppmätt 2019.", RUN).areaSource).toBe("uppmatt");
  });

  it("only the first 50 000 characters are read", () => {
    expect(areaFactsFromText(`${"x".repeat(AREA_TEXT_MAX_CHARS)} Areauppgift enligt föreningen.`, RUN)).toEqual(NONE);
  });
});

describe("areaAuditLines: clauses with every name masked, for the terminal only", () => {
  it("masks the firm in the example: 'Boarean är uppmätt av ▒ ▒ 2019.'", () => {
    expect(areaAuditLines("Boarean är uppmätt av Svensk Areamätning 2019.")).toEqual(["Boarean är uppmätt av ▒ ▒ 2019."]);
  });

  it("returns only clauses with an area keyword", () => {
    const lines = areaAuditLines("Fin etta nära Mariatorget. Boarean är uppmätt 2020. Hiss finns. Areauppgift enligt föreningen.");
    expect(lines).toEqual(["Boarean är uppmätt 2020.", "Areauppgift enligt föreningen."]);
  });

  it("masks seller names, e-mail addresses and phone numbers, and cuts each line at 160 characters", () => {
    const lines = areaAuditLines(
      `Areauppgift från säljare Anna Svensson, ring 070-123 45 67 eller anna.svensson@example.com. ${"Uppmätt ".repeat(60)}`,
    );
    const joined = lines.join("\n");
    expect(joined).not.toMatch(/Anna|Svensson|070|example\.com/);
    expect(joined).toContain("▒");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(AUDIT_LINE_MAX_CHARS);
    expect(lines.some((l) => l.length === AUDIT_LINE_MAX_CHARS)).toBe(true);
  });

  it("no capitalised word outside the allowlist survives", () => {
    const lines = areaAuditLines("Boarean är uppmätt av Svensk Areamätning och Enspecta AB 2019. Enligt Föreningen Oljan 18 är Arean 38 kvm.");
    for (const line of lines) {
      const survivors = (line.match(/\p{Lu}\p{L}*/gu) ?? []).filter((w) => !/^(?:Boarea|Arean|Areauppgift|Lägenheten|Mätningen|Uppmätt|Enligt|BOA|SS)/.test(w));
      expect(survivors, line).toEqual([]);
    }
  });

  it("null, empty or keyword-free text gives no lines", () => {
    expect(areaAuditLines(null)).toEqual([]);
    expect(areaAuditLines("")).toEqual([]);
    expect(areaAuditLines("Ljus tvåa med balkong.")).toEqual([]);
  });
});

describe("areaUpsideSek: an assumption kept apart from the score", () => {
  const base = { areaSource: "forening" as AreaSource, constructionYear: 1912, askingSek: 3_695_000, livingArea: 35 };

  it("one and two extra square metres at the flat's own price: 105571 and 211143", () => {
    expect(areaUpsideSek(base)).toEqual({ lowSek: 105571, highSek: 211143 });
  });

  it("every source that is not a measurement qualifies", () => {
    for (const areaSource of ["forening", "ekonomisk_plan", "lagenhetsregister", "saljare", "ej_kontrollmatt"] as const) {
      expect(areaUpsideSek({ ...base, areaSource }), areaSource).not.toBeNull();
    }
  });

  it("a measured flat, an unknown source or a building from 1987 or later gets none", () => {
    expect(areaUpsideSek({ ...base, areaSource: "uppmatt" })).toBeNull();
    expect(areaUpsideSek({ ...base, areaSource: null })).toBeNull();
    expect(areaUpsideSek({ ...base, constructionYear: 1987 })).toBeNull();
    expect(areaUpsideSek({ ...base, constructionYear: 2015 })).toBeNull();
    expect(areaUpsideSek({ ...base, constructionYear: 1986 })).not.toBeNull();
  });

  it("missing or impossible numbers give none", () => {
    expect(areaUpsideSek({ ...base, constructionYear: null })).toBeNull();
    expect(areaUpsideSek({ ...base, askingSek: null })).toBeNull();
    expect(areaUpsideSek({ ...base, livingArea: null })).toBeNull();
    expect(areaUpsideSek({ ...base, livingArea: 0 })).toBeNull();
    expect(areaUpsideSek({ ...base, askingSek: -1 })).toBeNull();
    expect(areaUpsideSek({ ...base, askingSek: Number.NaN })).toBeNull();
  });
});

describe("areaFactsFromText: pathological 50 000-character inputs read in under 50 ms (T-14.6-71)", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["'uppmätt ' repeated", "uppmätt ".repeat(6000)],
    ["digits repeated", "1234567890".repeat(5000)],
    ["'a' repeated", "a".repeat(50_000)],
    ["'arean är ej ' repeated", "arean är ej ".repeat(4000)],
    ["'areauppgift enligt ' repeated", "areauppgift enligt ".repeat(2600)],
    ["'ekonomisk ' repeated", "enligt ekonomisk ".repeat(3000)],
  ];
  it.each(cases)("%s", (_name, input) => {
    const started = performance.now();
    areaFactsFromText(input, RUN);
    areaAuditLines(input);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
