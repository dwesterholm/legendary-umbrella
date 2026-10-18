import { describe, expect, it } from "vitest";
import { stambyteFromText } from "@/lib/discovery/stambyte-text";

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

describe("held-back stambyte phrases (the honest pre-live score)", () => {
  it("has at least 15 phrases", () => {
    expect(HELD_BACK.length).toBeGreaterThanOrEqual(15);
  });

  it("reports how many pass and lists the misses", () => {
    const misses: string[] = [];
    for (const [phrase, expected] of HELD_BACK) {
      const got = stambyteFromText(phrase, RUN);
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        misses.push(`${phrase} -> ${JSON.stringify(got)} (wanted ${JSON.stringify(expected)})`);
      }
    }
    const passed = HELD_BACK.length - misses.length;
    console.info(`held-back: ${passed} av ${HELD_BACK.length}\n${misses.join("\n")}`);
    expect(passed).toBeGreaterThanOrEqual(0);
  });
});
