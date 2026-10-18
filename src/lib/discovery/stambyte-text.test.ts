import { describe, expect, it } from "vitest";
import { STAMBYTE_TEXT_MAX_CHARS, stambyteFromText } from "@/lib/discovery/stambyte-text";

const RUN = { runYear: 2026 };

type Expected = {
  readonly lastYear: number | null;
  readonly plannedYear: number | null;
  readonly ongoing: boolean;
  readonly relining: boolean;
};

/** Answer helper: `ex(2018)` = completed 2018; `ex(null, 2027)` = planned 2027; flags last. */
const ex = (lastYear: number | null, plannedYear: number | null = null, ongoing = false, relining = false): Expected => ({
  lastYear,
  plannedYear,
  ongoing,
  relining,
});
const NOTHING = ex(null);

/**
 * HELD-BACK PHRASES (written before the pattern work of plan 14.6-08 task 2, expected answers set from
 * the Swedish meaning, never edited to fit what the patterns return).
 *
 * Caveat stated honestly: the writer had already read the research drafts (RESEARCH 8.2), so this set is
 * not fully blind. It is written with other verbs, word orders, abbreviations and plan words than the
 * 33 tuned phrases. The score is a pre-live estimate; the live audit on real broker texts is the verdict.
 */
const HELD_BACK: ReadonlyArray<readonly [string, Expected]> = [
  ["Föreningen genomförde stambyte under 2014.", ex(2014)],
  ["Byte av stammar genomfördes 2016.", ex(2016)],
  ["Husets stammar är utbytta sedan 2009.", ex(2009)],
  ["Stambyte är under planering och beräknas starta 2028.", ex(null, 2028)],
  ["Ett omfattande stambyte pågår just nu och beräknas vara klart under 2027.", ex(null, null, true)],
  ["Det finns inget stambyte i närtid, bara punktinsatser.", NOTHING],
  ["Huset genomgick ett fullständigt stambyte år 2003.", ex(2003)],
  ["Fastigheten stambyttes 2019 och badrummen gjordes om 2020.", ex(2019)],
  ["2020 byttes alla stammar i huset och badrummen renoverades 2022.", ex(2020)],
  ["Nästa stambyte är beslutat till 2030 enligt föreningens underhållsplan.", ex(null, 2030)],
  ["Stambyte gjordes 1994 och badrummen är ursprungliga.", ex(1994)],
  ["Stamrenovering är utförd 2008, inklusive ny el.", ex(2008)],
  ["Ingen stambytesplan finns i dagsläget.", NOTHING],
  ["Vid ett kommande stambyte kan badrummet byggas om, kök renoverat 2022.", NOTHING],
  ["Relining av avloppsstammarna gjordes 2018 så något stambyte behövs inte på många år.", ex(null, null, false, true)],
  ["Stambyte skedde i början av 1990-talet.", NOTHING],
  ["Husets stambyte genomfördes 2011–2012.", ex(2012)],
  ["Det har varit stambyte i alla trapphus under 2015.", ex(2015)],
  ["Föreningen kommer att genomföra stambyte 2027–2028.", ex(null, 2027)],
  ["Stambytet är slutfört, besiktigat och godkänt 2021.", ex(2021)],
  ["Tyvärr har stambyte ännu inte genomförts.", NOTHING],
  ["Stambyte utfört 2016 samt nya fönster 2018.", ex(2016)],
  ["Renoverat kök 2022. Stambytet gjordes 2007.", ex(2007)],
  ["Bostadsrättsföreningen planerar stambyte inom några år, troligen 2029.", ex(null, 2029)],
  ["Badrummet renoverades 2021 i samband med stambytet.", ex(2021)],
  ["Stambyte (ej genomfört) ligger i föreningens långtidsplan.", NOTHING],
  ["Vattenstammar och avloppsstammar är utbytta 2010.", ex(2010)],
  ["Föreningen har gjort stambyte, senast 2012.", ex(2012)],
  ["Fullständigt stambyte kommer att påbörjas hösten 2026.", ex(null, 2026)],
  ["Köket renoverades 2021 och stambyte genomfördes 2018.", ex(2018)],
  ["Stambyte genomfört 2012, nytt stambyte planeras till 2027.", ex(2012, 2027)],
  ["Stambytet pågick 2019–2020 och är klart.", ex(2020)],
  ["Stammarna är relinade sedan 2015.", ex(null, null, false, true)],
  ["VA-stambytet slutfördes våren 2013.", ex(2013)],
  ["Pågående stambyte, etapp 2 av 3 i fastigheten.", ex(null, null, true)],
  ["Stambyte väntas 2031.", ex(null, 2031)],
  ["Ring 070-123 45 67 för frågor om stambyte.", NOTHING],
  ["Förra ägaren bodde här 2020. Stambyte är gjort.", NOTHING],
];

/**
 * Held-back phrases the reader gets wrong, pinned so a later fix (or a regression) shows up. Listed here,
 * not hidden by editing the expectations above. Empty = every held-back phrase passes.
 */
const HELD_BACK_KNOWN_MISSES: readonly string[] = [];

describe("held-back stambyte phrases (the honest pre-live score)", () => {
  it("has at least 15 phrases", () => {
    expect(HELD_BACK.length).toBeGreaterThanOrEqual(15);
  });

  it("reports how many pass and pins the misses", () => {
    const misses: string[] = [];
    const detail: string[] = [];
    for (const [phrase, expected] of HELD_BACK) {
      const got = stambyteFromText(phrase, RUN);
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        misses.push(phrase);
        detail.push(`${phrase} -> ${JSON.stringify(got)} (wanted ${JSON.stringify(expected)})`);
      }
    }
    console.info(`held-back: ${HELD_BACK.length - misses.length} av ${HELD_BACK.length}\n${detail.join("\n")}`);
    expect(misses).toEqual([...HELD_BACK_KNOWN_MISSES]);
  });
});

/**
 * SECOND HELD-BACK SET. Written AFTER the reader was finished (including the comma fix above), from the
 * Swedish meaning, and scored exactly once: no rule was changed to fit it. Misses are pinned below, not
 * fixed, unless a fix is a general rule (each such change is stated in the plan summary).
 */
const FRESH: ReadonlyArray<readonly [string, Expected]> = [
  ["Stambytet i fastigheten är genomfört och slutbesiktigat 2013.", ex(2013)],
  ["Föreningen står inför ett stambyte inom de närmaste åren.", NOTHING],
  ["Nyligen genomfört stambyte (2023) med nya badrum.", ex(2023)],
  ["Hela huset fick nya stammar 2008.", ex(2008)],
  ["Stambyte är under projektering, planerad start 2027.", ex(null, 2027)],
  ["Vi har gjort stambyte och dragit om all el 2015.", ex(2015)],
  ["Här gäller att stambyte redan är gjort, vilket ger lugn de närmaste decennierna.", NOTHING],
  ["Stambyte gjordes mellan 2016 och 2017.", ex(2017)],
  ["Stambyte utfördes i två etapper, 2014 och 2019.", ex(2019)],
  ["Föreningen avser genomföra stambyte under 2028.", ex(null, 2028)],
  ["Information om stambyte: genomfört 2017.", ex(2017)],
  ["Stambytet blev klart i oktober 2020.", ex(2020)],
  ["Köpare bör notera att stambyte inte är utfört.", NOTHING],
  ["VA-stammarna är bytta 2005.", ex(2005)],
  ["Stambyte i hus nr 2 klart 2019.", ex(2019)],
  ["Frågor om stambyte besvaras av mäklaren 070-1234567.", NOTHING],
  ["Planerat stambyte 2029-2030.", ex(null, 2029)],
  ["Stambyte genomfördes i flera etapper 2005–2008.", ex(2008)],
  ["Tidigare stambyte 2009 och ett nytt är beslutat till 2031.", ex(2009, 2031)],
  ["Husets rör är från 1950-talet men stambyte är gjort 2006.", ex(2006)],
  ["Stambyte väntar på nästa år.", NOTHING],
  ["Fastigheten har inte genomgått stambyte.", NOTHING],
  ["Efter stambytet 2019 är alla rör nya.", ex(2019)],
  ["Relining utfördes 2016 istället för stambyte.", ex(null, null, false, true)],
];

const FRESH_KNOWN_MISSES: readonly string[] = [
  "Stambytet i fastigheten är genomfört och slutbesiktigat 2013.",
  "Hela huset fick nya stammar 2008.",
  "Stambyte är under projektering, planerad start 2027.",
  "Vi har gjort stambyte och dragit om all el 2015.",
  "Stambyte gjordes mellan 2016 och 2017.",
  "Stambyte utfördes i två etapper, 2014 och 2019.",
  "Tidigare stambyte 2009 och ett nytt är beslutat till 2031.",
  "Relining utfördes 2016 istället för stambyte.",
];

describe("second held-back stambyte set (scored once, after the reader was finished)", () => {
  it("has at least 15 phrases", () => {
    expect(FRESH.length).toBeGreaterThanOrEqual(15);
  });

  it("reports how many pass and pins the misses", () => {
    const misses: string[] = [];
    const detail: string[] = [];
    for (const [phrase, expected] of FRESH) {
      const got = stambyteFromText(phrase, RUN);
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        misses.push(phrase);
        detail.push(`${phrase} -> ${JSON.stringify(got)} (wanted ${JSON.stringify(expected)})`);
      }
    }
    console.info(`second set: ${FRESH.length - misses.length} av ${FRESH.length}\n${detail.join("\n")}`);
    expect(misses).toEqual([...FRESH_KNOWN_MISSES]);
  });
});

/** The 33 phrases of RESEARCH 8.2, used while tuning (circular by nature; the held-back set is the honest signal). */
const TUNED: ReadonlyArray<readonly [string, Expected]> = [
  ["Stambyte genomfört 2018. Nytt kök och badrum 2021.", ex(2018)],
  ["Föreningen har genomfört stambyte 2019.", ex(2019)],
  ["Stambytet utfördes 2015.", ex(2015)],
  ["Stambytt 2005.", ex(2005)],
  ["2017 genomfördes ett stambyte i huset.", ex(2017)],
  ["Stammarna byttes 2016.", ex(2016)],
  ["Stambyte är genomfört (2011).", ex(2011)],
  ["Nytt kök och badrum 2021, stambyte 2018.", ex(2018)],
  ["I samband med stambytet 2018 renoverades badrummet.", ex(2018)],
  ["Stambyte och badrumsrenovering gjordes 2019.", ex(2019)],
  ["Stambyte genomfört 1991.", ex(1991)],
  ["Stambyte planeras 2027.", ex(null, 2027)],
  ["Planerat stambyte 2028.", ex(null, 2028)],
  ["Föreningen har beslutat om stambyte som startar 2026.", ex(null, 2026)],
  ["Stambyte är planerat till 2029.", ex(null, 2029)],
  ["Kommande stambyte, år ej fastställt.", NOTHING],
  ["Stambyte pågår i fastigheten.", ex(null, null, true)],
  ["Pågående stambyte under 2026.", ex(null, null, true)],
  ["Inget stambyte är planerat.", NOTHING],
  ["Stambyte ej genomfört.", NOTHING],
  ["Stambyte har ännu inte gjorts.", NOTHING],
  ["Avloppsstammar relinade 2017.", ex(null, null, false, true)],
  ["Relining genomfört 2015.", ex(null, null, false, true)],
  ["Stambyte genomfört 2012 samt relining av stammar i källaren 2020.", ex(2012, null, false, true)],
  ["Nytt badrum 2021 och nytt kök 2019.", NOTHING],
  ["VA-stambyte klart 2014.", ex(2014)],
  ["Stamrenovering utförd 2010.", ex(2010)],
  ["Stambyte på 1980-talet.", NOTHING],
  ["Föreningen har ett stambyte i sin underhållsplan för 2035.", ex(null, 2035)],
  ["Stambyte 2024.", ex(2024)],
  ["Stambyte 2031 enligt underhållsplanen.", ex(null, 2031)],
  ["Stambytet slutfördes under 2022.", ex(2022)],
];

describe("stambyteFromText: the 32 tuned phrases (runYear 2026)", () => {
  it.each(TUNED)("%s", (phrase, expected) => {
    expect(stambyteFromText(phrase, RUN)).toEqual(expected);
  });

  it("has 32 phrases here plus the empty text below (33 in the research)", () => {
    expect(TUNED.length).toBe(32);
  });
});

describe("stambyteFromText: the null-text contract", () => {
  it("null and empty text are not read: all null", () => {
    const notRead = { lastYear: null, plannedYear: null, ongoing: null, relining: null };
    expect(stambyteFromText(null, RUN)).toEqual(notRead);
    expect(stambyteFromText("", RUN)).toEqual(notRead);
    expect(stambyteFromText("   \n ", RUN)).toEqual(notRead);
  });

  it("a text that states nothing is read and says so", () => {
    expect(stambyteFromText("Ljus etta med balkong i söderläge.", RUN)).toEqual(ex(null));
  });
});

describe("stambyteFromText: the rules in their own words", () => {
  it("a year inside another clause never becomes the stambyte year", () => {
    expect(stambyteFromText("Badrum 2021. Stambyte finns i planen.", RUN)).toEqual(ex(null));
    expect(stambyteFromText("Stambyte genomfört, nytt kök 2021.", RUN)).toEqual(ex(null));
    expect(stambyteFromText("Stambyte genomfört och nytt kök 2021.", RUN)).toEqual(ex(null));
  });

  it("a year behind another renovation topic is refused, but 'och badrumsrenovering' is a joined subject", () => {
    expect(stambyteFromText("Stambyte, nytt badrum och golv 2020.", RUN)).toEqual(ex(null));
    expect(stambyteFromText("Stambyte och badrumsrenovering gjordes 2019.", RUN)).toEqual(ex(2019));
  });

  it("a comma lets only status and hedge words through: 'senast 2012' counts, a new subject does not", () => {
    expect(stambyteFromText("Föreningen har gjort stambyte, senast 2012.", RUN)).toEqual(ex(2012));
    expect(stambyteFromText("Stambyte genomfört, hyresgäst flyttade in 2020.", RUN)).toEqual(ex(null));
    expect(stambyteFromText("Stambyte genomfört, föreningen har bra ekonomi sedan 2015.", RUN)).toEqual(ex(null));
  });

  it("the run year splits past from future, and the caller owns it", () => {
    expect(stambyteFromText("Stambyte 2028.", { runYear: 2026 })).toEqual(ex(null, 2028));
    expect(stambyteFromText("Stambyte 2028.", { runYear: 2030 })).toEqual(ex(2028));
    expect(stambyteFromText("Stambyte 2026.", { runYear: 2026 })).toEqual(ex(2026));
  });

  it("years outside 1950 to 2045 and decades are ignored", () => {
    expect(stambyteFromText("Stambyte 1949.", RUN)).toEqual(ex(null));
    expect(stambyteFromText("Stambyte 1950.", RUN)).toEqual(ex(1950));
    expect(stambyteFromText("Stambyte planerat 2045.", RUN)).toEqual(ex(null, 2045));
    expect(stambyteFromText("Stambyte 2046.", RUN)).toEqual(ex(null));
    expect(stambyteFromText("Stambyte på 1990-talet och 2000-talet.", RUN)).toEqual(ex(null));
  });

  it("of several completed years the latest wins, of several planned the earliest", () => {
    expect(stambyteFromText("Stambyte 2005 i hus A. Stambyte 2012 i hus B.", RUN)).toEqual(ex(2012));
    expect(stambyteFromText("Stambyte planeras 2030. Stambyte planeras 2028.", RUN)).toEqual(ex(null, 2028));
  });

  it("relining is never a stambyte: it sets only its own flag", () => {
    expect(stambyteFromText("Relining genomfördes 2019.", RUN)).toEqual(ex(null, null, false, true));
    expect(stambyteFromText("Stambyte gjordes genom relining 2019.", RUN)).toEqual(ex(null, null, false, true));
    expect(stambyteFromText("Rörrenovering 2018.", RUN)).toEqual(ex(null, null, false, true));
  });

  it("a negation binds to its own keyword only", () => {
    expect(stambyteFromText("Stambyte genomfört 2012, inget stambyte planerat.", RUN)).toEqual(ex(2012));
    expect(stambyteFromText("Stambyte genomfört 2018, ingen avgiftshöjning planerad.", RUN)).toEqual(ex(2018));
    expect(stambyteFromText("Inget stambyte har gjorts.", RUN)).toEqual(ex(null));
  });

  it("the result carries exactly four keys and never the sentence", () => {
    const found = stambyteFromText("Ring Svensson på 070-123 45 67. Stambyte genomfört 2018.", RUN);
    expect(Object.keys(found).sort()).toEqual(["lastYear", "ongoing", "plannedYear", "relining"]);
    expect(JSON.stringify(found)).not.toContain("Svensson");
    expect(JSON.stringify(found)).not.toContain("070-123");
  });

  it("soft hyphens, zero-width characters and no-break spaces do not hide a phrase", () => {
    expect(stambyteFromText("Stam\u00ADbyte\u00A0genomfört\u00A02018.", RUN)).toEqual(ex(2018));
    expect(stambyteFromText("Stambyte\u200B genomfört 2018.", RUN)).toEqual(ex(2018));
  });

  it("only the first 50 000 characters are read", () => {
    expect(STAMBYTE_TEXT_MAX_CHARS).toBe(50_000);
    expect(stambyteFromText(`${"x".repeat(STAMBYTE_TEXT_MAX_CHARS)} Stambyte genomfört 2018.`, RUN)).toEqual(ex(null));
  });
});

describe("stambyteFromText: pathological 50 000-character inputs read in under 50 ms (T-14.6-71)", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["'stambyte ' repeated", "stambyte ".repeat(6000)],
    ["digits repeated", "1234567890".repeat(5000)],
    ["'a' repeated", "a".repeat(50_000)],
    ["'stambyte 2018 ' repeated", "stambyte 2018 ".repeat(4000)],
    ["negations and plan words repeated", "ej stambyte planeras pågår ".repeat(2500)],
    ["'stammar ' repeated", "stammar ".repeat(7000)],
  ];
  it.each(cases)("%s", (_name, input) => {
    const started = performance.now();
    stambyteFromText(input, RUN);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
