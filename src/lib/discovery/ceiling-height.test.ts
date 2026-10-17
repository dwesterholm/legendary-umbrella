import { describe, expect, it } from "vitest";
import {
  CEILING_MAX_M,
  CEILING_MIN_M,
  CEILING_TEXT_MAX_CHARS,
  ceilingFactsFromText,
  ceilingHeightFromText,
} from "@/lib/discovery/ceiling-height";

describe("constants", () => {
  it("the accepted band is 2,2 to 5,0 m and the read is capped at 50 000 characters", () => {
    expect(CEILING_MIN_M).toBe(2.2);
    expect(CEILING_MAX_M).toBe(5.0);
    expect(CEILING_TEXT_MAX_CHARS).toBe(50_000);
  });
});

describe("ceilingHeightFromText: the keyword first (tracer slice)", () => {
  it("'Takhöjd 3,2 m.' is 3,2 with the canonical phrase", () => {
    expect(ceilingHeightFromText("Takhöjd 3,2 m.")).toEqual({ metres: 3.2, phrase: "takhöjd 3,2 m" });
  });

  it("'takhöjd 7 m' is outside the band and gives null", () => {
    expect(ceilingHeightFromText("takhöjd 7 m")).toBeNull();
  });

  it("null and empty text give null", () => {
    expect(ceilingHeightFromText(null)).toBeNull();
    expect(ceilingHeightFromText("")).toBeNull();
  });

  it("the result carries exactly the keys metres and phrase, never the sentence", () => {
    const found = ceilingHeightFromText("Ring Svensson på 070-123 45 67. Takhöjd 3,2 m i vardagsrummet.");
    expect(Object.keys(found ?? {}).sort()).toEqual(["metres", "phrase"]);
    expect(JSON.stringify(found)).not.toContain("Svensson");
    expect(JSON.stringify(found)).not.toContain("070-123");
  });
});

describe("ceilingFactsFromText", () => {
  it("null text means not read: all three null", () => {
    expect(ceilingFactsFromText(null)).toEqual({ ceilingHeightM: null, ceilingSource: null, tallCeilingPhrase: null });
  });

  it("a text that states nothing is read and says so: null, null, false", () => {
    expect(ceilingFactsFromText("Ljus etta med balkong.")).toEqual({
      ceilingHeightM: null,
      ceilingSource: null,
      tallCeilingPhrase: false,
    });
  });

  it("a stated height is 3,2, 'angiven', no tall phrase", () => {
    expect(ceilingFactsFromText("Takhöjd 3,2 m.")).toEqual({
      ceilingHeightM: 3.2,
      ceilingSource: "angiven",
      tallCeilingPhrase: false,
    });
  });
});

describe("ceilingHeightFromText: phrasings brokers use (metres)", () => {
  const positives: [string, number][] = [
    ["Takhöjd 3,2 m", 3.2],
    ["takhöjd på ca 3 meter", 3],
    ["Takhöjd: 3.2m", 3.2],
    ["Rumshöjd 2,8 m", 2.8],
    ["3,5 meters takhöjd", 3.5],
    ["ca 3 m i takhöjd", 3],
    ["2,7 m takhöjd", 2.7],
    ["tre meter i takhöjd", 3],
    ["tre och en halv meter i takhöjd", 3.5],
    ["fyra meters takhöjd", 4],
    ["takhöjd 270 cm", 2.7],
    ["takhöjd 2,70", 2.7],
    ["takhöjd om cirka 3,1 meter", 3.1],
    ["takhöjd upp till 3,6 m", 3.6],
    ["Takhöjden är 3,3 m", 3.3],
    ["Hög takhöjd (3,4 m)", 3.4],
    ["takhöjd ca. 3 m", 3],
  ];
  it.each(positives)("%s gives %s", (text, metres) => {
    expect(ceilingHeightFromText(text)?.metres).toBe(metres);
  });

  it("the canonical phrase is rebuilt from the number: decimal comma, trailing zeros dropped", () => {
    expect(ceilingHeightFromText("takhöjd på ca 3 meter")?.phrase).toBe("takhöjd 3 m");
    expect(ceilingHeightFromText("takhöjd 270 cm")?.phrase).toBe("takhöjd 2,7 m");
    expect(ceilingHeightFromText("3,5 meters takhöjd")?.phrase).toBe("takhöjd 3,5 m");
    expect(ceilingHeightFromText("takhöjd 3,25 m")?.phrase).toBe("takhöjd 3,25 m");
  });
});

describe("ceilingHeightFromText: rejected", () => {
  const rejected: [string][] = [
    ["låg takhöjd"],
    ["Låg takhöjd 2,3 m"],
    ["takhöjd i källaren 2,1 m"],
    ["Förrådet har en takhöjd på 2,3 m"],
    ["takhöjd 0,5 m"],
    ["takhöjd 12 m"],
    ["takhöjd 2,1 m"],
    ["takhöjd 5,1 m"],
    ["takhöjd 3 rum och kök"],
    ["Takhöjd 2,5 m2"],
    ["takhöjd 3,6 m, loftsäng"],
    ["takhöjdsskillnad 3 m"],
    ["Vinden har takhöjd 2,4 m"],
    ["Garaget har takhöjd 2,5 m"],
    ["Cykelrummet har takhöjd 2,6 m"],
    ["Tvättstugan har takhöjd 2,5 m"],
    ["Trapphuset har takhöjd 3,5 m"],
    ["Souterrängen har takhöjd 2,4 m"],
    ["Gemensam takterrass, takhöjd 3 m"],
    ["Bergrummet har takhöjd 3 m"],
    ["Mellanplanet har takhöjd 2,5 m"],
    ["Hög takhöjd."],
    ["Ceiling height 3.2 m"],
  ];
  it.each(rejected)("%s gives null", (text) => {
    expect(ceilingHeightFromText(text)).toBeNull();
  });
});

describe("ceilingHeightFromText: first match, clauses and robustness", () => {
  it("two heights in one text: the first in text order wins", () => {
    expect(ceilingHeightFromText("Takhöjd 3,0 meter i vardagsrummet och 2,5 meter i sovrummet")?.metres).toBe(3.0);
  });

  it("a first clause about another space is skipped, the next clause counts", () => {
    expect(ceilingHeightFromText("Källaren har takhöjd 2,3 m. Takhöjd 3,1 m i lägenheten.")?.metres).toBe(3.1);
  });

  it("a first implausible height is skipped, the next plausible one counts", () => {
    expect(ceilingHeightFromText("Takhöjd 12 m. Takhöjd 3,1 m.")?.metres).toBe(3.1);
  });

  it("a decimal point is not a clause end: 'Takhöjd: 3.2m' stays whole next to another space later in the text", () => {
    expect(ceilingHeightFromText("Takhöjd: 3.2m. Förråd i källaren.")?.metres).toBe(3.2);
  });

  it("a soft hyphen, a zero-width space and a no-break space do not break a match", () => {
    expect(ceilingHeightFromText("tak\u00ADhöjd 3,1 m")?.metres).toBe(3.1);
    expect(ceilingHeightFromText("tak\u200Bhöjd 3,1 m")?.metres).toBe(3.1);
    expect(ceilingHeightFromText("takhöjd 3,1\u00A0m")?.metres).toBe(3.1);
    expect(ceilingHeightFromText("takhöjd\u00A03,1 m")?.metres).toBe(3.1);
  });

  it("only the first 50 000 characters are read, and a long text returns fast", () => {
    const filler = "Ljus och fin lägenhet med öppen planlösning. ".repeat(1300);
    const text = filler + "Takhöjd 3,1 m.";
    expect(text.length).toBeGreaterThan(CEILING_TEXT_MAX_CHARS);
    expect(text.indexOf("Takhöjd")).toBeGreaterThan(CEILING_TEXT_MAX_CHARS);
    const started = Date.now();
    expect(ceilingHeightFromText(text)).toBeNull();
    expect(ceilingHeightFromText("Takhöjd 3,1 m. " + filler)?.metres).toBe(3.1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a hostile text of repeated keywords and spaces is cheap", () => {
    const hostile = ("takhöjd" + " ".repeat(30) + "på ").repeat(1500);
    const started = Date.now();
    expect(ceilingHeightFromText(hostile)).toBeNull();
    const numbers = "takhöjd 1".repeat(5000);
    expect(ceilingHeightFromText(numbers)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("ceilingFactsFromText: the tall-ceiling flag", () => {
  it("'Hög takhöjd (3,4 m)' gives the number and the flag", () => {
    expect(ceilingFactsFromText("Hög takhöjd (3,4 m)")).toEqual({
      ceilingHeightM: 3.4,
      ceilingSource: "angiven",
      tallCeilingPhrase: true,
    });
  });

  it("'högt i tak (ca 3,4 m)' gives no number (D-05) and the flag", () => {
    expect(ceilingFactsFromText("högt i tak (ca 3,4 m)")).toEqual({
      ceilingHeightM: null,
      ceilingSource: null,
      tallCeilingPhrase: true,
    });
  });

  it("'Härligt högt i tak.' gives { null, null, true }", () => {
    expect(ceilingFactsFromText("Härligt högt i tak.")).toEqual({
      ceilingHeightM: null,
      ceilingSource: null,
      tallCeilingPhrase: true,
    });
  });

  it("'generös takhöjd', 'höga tak', 'extra hög takhöjd' and 'högt till tak' are the flag only", () => {
    for (const text of ["generös takhöjd", "Vackra höga tak", "extra hög takhöjd", "Högt till tak i salen"]) {
      expect(ceilingFactsFromText(text)).toEqual({ ceilingHeightM: null, ceilingSource: null, tallCeilingPhrase: true });
    }
  });

  it("'låg takhöjd' and 'lågt i tak' never give a number or the flag", () => {
    for (const text of ["låg takhöjd", "Lågt i tak i hallen", "Låg takhöjd 2,3 m"]) {
      expect(ceilingFactsFromText(text)).toEqual({ ceilingHeightM: null, ceilingSource: null, tallCeilingPhrase: false });
    }
  });

  it("'inte högt i tak' and 'ej högt i tak' do not raise the flag", () => {
    expect(ceilingFactsFromText("Inte högt i tak.").tallCeilingPhrase).toBe(false);
    expect(ceilingFactsFromText("Ej högt i tak.").tallCeilingPhrase).toBe(false);
  });

  it("never returns the sentence, only the three keys", () => {
    const facts = ceilingFactsFromText("Ring Svensson 070-123 45 67. Hög takhöjd 3,4 m.");
    expect(Object.keys(facts).sort()).toEqual(["ceilingHeightM", "ceilingSource", "tallCeilingPhrase"]);
    expect(JSON.stringify(facts)).not.toContain("Svensson");
  });
});
