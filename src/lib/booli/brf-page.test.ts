import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRF_PAGE_FUNCTION, brfPageUrl, fetchBrfFacts, fetchBrfText, parseBrfPage } from "@/lib/booli/brf-page";

const fixture = (n: number): string => readFileSync(join(__dirname, "__fixtures__", `brf-page-${n}.fixture.txt`), "utf8");

describe("brfPageUrl", () => {
  it("builds the public page url from digits", () => {
    expect(brfPageUrl("82768")).toBe("https://www.booli.se/bostadsrattsforening/82768");
  });

  it.each(["82768/../x", "", "abc", "12 3", "123?x=1", "12a", "-5", "../82768"])("refuses %j", (id) => {
    expect(() => brfPageUrl(id)).toThrow();
  });
});

// The three fixtures are real Booli BRF pages captured through the local browser on 2026-10-13,
// cut to the economy lines (no names). Their numbers are asserted literally.
describe("parseBrfPage on real captured pages", () => {
  it("fixture 1 (HSB BRF Metern, 82768): label and value on separate lines, report 2025", () => {
    const f = parseBrfPage(fixture(1));
    expect(f).toEqual({ loanSek: 14_800_000, areaSqm: 12_642, reportYear: 2025, debtPerSqm: Math.round(14_800_000 / 12_642) });
    expect(f.debtPerSqm).toBe(1171);
  });

  it("fixture 2 (81611): a heavily indebted association", () => {
    const f = parseBrfPage(fixture(2));
    expect(f.loanSek).toBe(164_160_600);
    expect(f.areaSqm).toBe(12_897);
    expect(f.reportYear).toBe(2024);
    expect(f.debtPerSqm).toBe(12_729);
  });

  it("fixture 3 (281879): a small association, 23 flats", () => {
    const f = parseBrfPage(fixture(3));
    expect(f.loanSek).toBe(25_948_750);
    expect(f.areaSqm).toBe(1_014);
    expect(f.reportYear).toBe(2024);
    expect(f.debtPerSqm).toBe(25_590);
  });

  it("the 'Belåning per kvm' label that is login-gated does not make a number", () => {
    // The fixtures print "Belåning per kvm" followed by "Logga in"; neither label may be read as the loan.
    expect(fixture(1)).toContain("Belåning per kvm");
    expect(parseBrfPage(fixture(1)).loanSek).toBe(14_800_000);
  });
});

describe("parseBrfPage number formats", () => {
  it("reads 'Lån: 30 072 899 kr' with a plain, a no-break and a narrow no-break space", () => {
    expect(parseBrfPage("Lån: 30 072 899 kr").loanSek).toBe(30_072_899);
    expect(parseBrfPage("Lån: 30 072 899 kr").loanSek).toBe(30_072_899);
    expect(parseBrfPage("Lån: 30 072 899 kr").loanSek).toBe(30_072_899);
  });

  it("reads the area with m² and m2", () => {
    expect(parseBrfPage("Boarea bostadsrätter: 6 076 m²").areaSqm).toBe(6076);
    expect(parseBrfPage("Boarea bostadsrätter: 6 076 m2").areaSqm).toBe(6076);
    expect(parseBrfPage("Boarea bostadsrätter\n\n6 076 m²").areaSqm).toBe(6076);
  });

  it("reads a decimal area", () => {
    expect(parseBrfPage("Boarea bostadsrätter: 1 014,5 m²").areaSqm).toBe(1014.5);
  });

  it("computes the debt per kvm in whole kronor from the research example (BRF 57671)", () => {
    const f = parseBrfPage(
      "Informationen är baserad på föreningens årsredovisning för 2024.\nBoarea bostadsrätter: 6 076 m²\nLån: 30 072 899 kr",
    );
    expect(f.debtPerSqm).toBe(Math.round(30_072_899 / 6_076));
    expect(f.debtPerSqm).toBe(4_949);
    expect(f.reportYear).toBe(2024);
  });
});

describe("parseBrfPage missing pieces", () => {
  it("a page without 'Lån' has null loan and null debt per kvm but keeps the area", () => {
    const f = parseBrfPage("Boarea bostadsrätter\n\n6 076 m²\nInformationen är baserad på föreningens årsredovisning för 2023.");
    expect(f).toEqual({ loanSek: null, areaSqm: 6076, reportYear: 2023, debtPerSqm: null });
  });

  it("a fixture with the loan lines removed gives null loan (the label-missing case; no real page lacked it in 8 probed)", () => {
    const withoutLoan = fixture(1)
      .split("\n")
      .filter((l) => l !== "Lån" && !/kr$/.test(l))
      .join("\n");
    const f = parseBrfPage(withoutLoan);
    expect(f.loanSek).toBeNull();
    expect(f.debtPerSqm).toBeNull();
    expect(f.areaSqm).toBe(12_642);
  });

  it("an area of 0 m² gives null debt per kvm", () => {
    const f = parseBrfPage("Lån: 1 000 000 kr\nBoarea bostadsrätter: 0 m²");
    expect(f.areaSqm).toBe(0);
    expect(f.debtPerSqm).toBeNull();
  });

  it("empty text, non-string and noise give all null", () => {
    const empty = { loanSek: null, areaSqm: null, reportYear: null, debtPerSqm: null };
    expect(parseBrfPage("")).toEqual(empty);
    expect(parseBrfPage(undefined as unknown as string)).toEqual(empty);
    expect(parseBrfPage("Gå till innehåll\nSök bostad\nLån\nLogga in")).toEqual(empty);
  });

  it("a number without its unit is not a loan", () => {
    expect(parseBrfPage("Lån\n279 st").loanSek).toBeNull();
  });

  it("'Lånekostnad' and 'Belåning' are not the loan label", () => {
    expect(parseBrfPage("Lånekostnad 5 000 kr").loanSek).toBeNull();
    expect(parseBrfPage("Belåning 5 000 kr").loanSek).toBeNull();
  });
});

describe("fetchBrfFacts", () => {
  const asItems = (text: string) => async () => [{ hasApollo: true, __APOLLO_STATE__: { "BrfPage:0": { __typename: "BrfPage", text } } }];

  it("renders the public url with the BRF page function and parses the text", async () => {
    let seenUrl = "";
    let seenFn = "";
    const f = await fetchBrfFacts("82768", async (url, pageFunction) => {
      seenUrl = url;
      seenFn = pageFunction;
      return asItems(fixture(1))();
    });
    expect(seenUrl).toBe("https://www.booli.se/bostadsrattsforening/82768");
    expect(seenFn).toBe(BRF_PAGE_FUNCTION);
    expect(f.debtPerSqm).toBe(1171);
  });

  it("rejects when the render throws (the caller counts the association as failed)", async () => {
    await expect(
      fetchBrfFacts("82768", async () => {
        throw new Error("blocked");
      }),
    ).rejects.toThrow("blocked");
  });

  it("rejects when the render returns no text item", async () => {
    await expect(fetchBrfFacts("82768", async () => [])).rejects.toThrow();
    await expect(fetchBrfText("82768", async () => [{ hasApollo: true, __APOLLO_STATE__: {} }])).rejects.toThrow();
  });

  it("resolves with null fields when the page rendered without the labels", async () => {
    const f = await fetchBrfFacts("82768", asItems("Gå till innehåll\nIngen ekonomi publicerad"));
    expect(f).toEqual({ loanSek: null, areaSqm: null, reportYear: null, debtPerSqm: null });
  });

  it("refuses a non-digit id before rendering", async () => {
    let called = false;
    await expect(
      fetchBrfFacts("82768/../x", async () => {
        called = true;
        return [];
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe("BRF_PAGE_FUNCTION", () => {
  it("compiles like the other page functions and returns the page text as an Apollo-shaped item", async () => {
    const run = new Function(`return (${BRF_PAGE_FUNCTION})`)() as (ctx: unknown) => Promise<{
      hasApollo: boolean;
      __APOLLO_STATE__: Record<string, { text: string }>;
    }>;
    const page = {
      expressions: [] as string[],
      async evaluate(expr: string) {
        this.expressions.push(expr);
        return fixture(1);
      },
      async waitForTimeout() {
        throw new Error("must not wait once the labels are in the text");
      },
    };
    const out = await run({ page, request: { url: "x" } });
    expect(out.hasApollo).toBe(true);
    expect(out.__APOLLO_STATE__["BrfPage:0"].text).toBe(fixture(1));
    // The browser-side expression is a fixed string that only reads the visible text.
    expect(page.expressions).toEqual(["document.body ? document.body.innerText : ''"]);
  });

  it("waits and tries again while the numbers are not in the page yet, then gives up with the text it has", async () => {
    const run = new Function(`return (${BRF_PAGE_FUNCTION})`)() as (ctx: unknown) => Promise<{ hasApollo: boolean }>;
    let reads = 0;
    let waits = 0;
    const page = {
      async evaluate() {
        reads += 1;
        return "Laddar...";
      },
      async waitForTimeout() {
        waits += 1;
      },
    };
    const out = await run({ page, request: { url: "x" } });
    expect(reads).toBe(6);
    expect(waits).toBe(6);
    expect(out.hasApollo).toBe(true);
  });

  it("an empty page is hasApollo false so the renderer's own re-extract and refusal apply", async () => {
    const run = new Function(`return (${BRF_PAGE_FUNCTION})`)() as (ctx: unknown) => Promise<{ hasApollo: boolean }>;
    const page = { evaluate: async () => "", waitForTimeout: async () => undefined };
    expect((await run({ page, request: { url: "x" } })).hasApollo).toBe(false);
  });
});
