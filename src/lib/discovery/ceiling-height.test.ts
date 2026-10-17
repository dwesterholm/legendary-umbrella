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
