import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildingFactsOf, classifyDescription, toStoredCase } from "@/lib/stockholm/bygglov-classify";
import {
  exactMatchRows,
  pageMarkers,
  parseAddressFragment,
  parseCaseDetail,
  parseCaseList,
  termsLinks,
} from "@/lib/stockholm/bygglov-parse";

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

// ---------------------------------------------------------------------------------------------------
// Task 2: the detail page, the address fragment and every failure shape
// ---------------------------------------------------------------------------------------------------

describe("parseCaseDetail: decisions come from the embedded array", () => {
  it("2020 stambyte at Fotangeln 1: three decisions, oldest first, estate and diarienummer read", () => {
    const parsed = parseCaseDetail(fixture("case-stambyte-2020-startbesked-slutbesked"));
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.reason}`);
    expect(parsed.detail.rec).toBe("1208902");
    expect(parsed.detail.diarie).toBe("2020-14734");
    expect(parsed.detail.startDate).toBe("2020-10-28");
    expect(parsed.detail.closedDate).toBe("2023-03-16");
    expect(parsed.detail.estates).toEqual([{ beteckning: "Fotangeln 1", address: "Bastugatan 1A", district: "Södermalm" }]);
    expect(parsed.detail.decisions).toEqual([
      { date: "2020-12-08", type: "Startbesked", code: "Bifall" },
      { date: "2023-02-02", type: "Beslut", code: "Bifall" },
      { date: "2023-03-15", type: "Slutbesked / slutbevis", code: "Bifall" },
    ]);
  });

  it("2017 balcony renovation: one Beslut / Avskrivet 2018-04-12", () => {
    const parsed = parseCaseDetail(fixture("case-balkong-2017-avskrivet"));
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.reason}`);
    expect(parsed.detail.rec).toBe("1150705");
    expect(parsed.detail.decisions).toEqual([{ date: "2018-04-12", type: "Beslut", code: "Avskrivet" }]);
  });

  it("2006 archived stambyte: one Beslut with code null", () => {
    const parsed = parseCaseDetail(fixture("case-stambyte-2006-archived"));
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.reason}`);
    // an archived case has no RecNo and no Estates in its view model; the caller knows the rec from the URL
    expect(parsed.detail.rec).toBeNull();
    expect(parsed.detail.diarie).toBe("2006-07800");
    expect(parsed.detail.estates).toEqual([]);
    expect(parsed.detail.decisions).toEqual([{ date: "2006-06-15", type: "Beslut", code: null }]);
    expect(parsed.detail.closedDate).toBe("2008-12-22");
  });

  it("an officer name planted as Handler, in the Handläggare line and in a document title ('Testa Testsson') never appears in the result", () => {
    const original = fixture("case-stambyte-2020-startbesked-slutbesked");
    const planted = original
      .replace('\\"Handler\\":null', '\\"Handler\\":\\"Testa Testsson\\"')
      .replace('<dd class="mb-6"></dd>', '<dd class="mb-6">Testa Testsson</dd>')
      .replace(
        '\\"Documents\\":[]',
        '\\"Documents\\":[{\\"Title\\":\\"Beslut om ny kontrollansvarig Testa Testsson\\",\\"Id\\":\\"7\\"}]',
      );
    // guard against a vacuous test: the name really is in the page three times
    expect(planted.split("Testa Testsson")).toHaveLength(4);

    const parsed = parseCaseDetail(planted);
    expect(parsed.ok).toBe(true);
    const json = JSON.stringify(parsed);
    expect(json).not.toContain("Testa");
    expect(json).not.toContain("Testsson");
    expect(json).not.toContain("kontrollansvarig");
    // the free ärendemening (Definition) is not copied either
    expect(json).not.toContain("badrum");
    if (!parsed.ok) throw new Error("parse failed");
    expect(Object.keys(parsed.detail).sort()).toEqual(["closedDate", "decisions", "diarie", "estates", "rec", "startDate"]);
  });

  it("a detail page without the view model is shape; with a login form it is login", () => {
    expect(parseCaseDetail("<html><body><p>Ärende</p></body></html>")).toEqual({ ok: false, reason: "shape" });
    expect(parseCaseDetail('<html><body><form><h1>Logga in med BankID</h1></form></body></html>')).toEqual({
      ok: false,
      reason: "login",
    });
  });
});

describe("parseAddressFragment", () => {
  it("Folkungagatan 61 gives the one decoded option; the placeholder is dropped", () => {
    expect(parseAddressFragment(fixture("address-search-folkungagatan-61"))).toEqual([
      { text: "Droskhästen 8, Folkungagatan 61", value: "Droskhästen 8" },
    ]);
  });

  it("Hornsgatan 42 gives two options with the same beteckning 'Ormen Mindre 2'", () => {
    const options = parseAddressFragment(fixture("address-search-hornsgatan-42"));
    expect(options).toHaveLength(2);
    expect(options?.map((o) => o.value)).toEqual(["Ormen Mindre 2", "Ormen Mindre 2"]);
    expect(options?.map((o) => o.text).sort()).toEqual(["Ormen Mindre 2, Hornsgatan 42A", "Ormen Mindre 2, Hornsgatan 42B"]);
  });

  it("a fragment with no select list is null", () => {
    expect(parseAddressFragment("<div>Adressen finns inte.</div>")).toBeNull();
  });
});

describe("parseCaseList: the sweep pages and every failure shape", () => {
  it("the 380-row stambyte sweep and the 97-row balcony sweep parse to exactly 380 and 97 rows", () => {
    const stambyte = parseCaseList(fixture("ext-sodermalm-stambyte-1985"));
    const balkong = parseCaseList(fixture("ext-sodermalm-balkong-2025-06"));
    if (!stambyte.ok || !balkong.ok) throw new Error("sweep parse failed");
    expect(stambyte.rows).toHaveLength(380);
    expect(stambyte.headingCount).toBe(380);
    expect(balkong.rows).toHaveLength(97);
    expect(balkong.headingCount).toBe(97);
    // a diarienummer with a colon ("IV:2170/69") is cut to the allowed characters, never refused
    const odd = parseCaseList(fixture("list-droskhasten-8"));
    if (!odd.ok) throw new Error("parse failed");
    for (const row of [...stambyte.rows, ...balkong.rows, ...odd.rows, ...odd.otherRows]) {
      expect(row.diarie).toMatch(/^[0-9A-Za-z/ -]{0,20}$/);
    }
  });

  it("a renamed marker is shape", () => {
    const html = fixture("list-droskhasten-8").replace("var CaseSearchResultsViewModel", "var CaseSearchRenamed");
    expect(parseCaseList(html)).toEqual({ ok: false, reason: "shape" });
  });

  it("a heading that says 'av 60' over 53 rows is count", () => {
    const html = fixture("list-droskhasten-8").replace("av 53)", "av 60)");
    expect(html).toContain("av 60)");
    expect(parseCaseList(html)).toEqual({ ok: false, reason: "count" });
    const tab = fixture("ext-sodermalm-balkong-2025-06").replace("(97 tr&#228;ffar)", "(500 tr&#228;ffar)");
    expect(parseCaseList(tab)).toEqual({ ok: false, reason: "count" });
  });

  it("a row that breaks the schema (a non-digit RecNo) is shape", () => {
    const html = fixture("ext-sodermalm-balkong-2025-06").replace('"RecNo":"1328664"', '"RecNo":"13x8664"');
    expect(parseCaseList(html)).toEqual({ ok: false, reason: "shape" });
  });

  it("a page with no view model and a BankID login form is login", () => {
    const html = '<html><body><form action="/inloggning"><h1>Logga in med BankID</h1></form></body></html>';
    expect(parseCaseList(html)).toEqual({ ok: false, reason: "login" });
  });

  it("a page with no view model and the word Användarvillkor is terms", () => {
    const html = "<html><body><main><p>Godkänn Användarvillkor för att fortsätta</p></main></body></html>";
    expect(parseCaseList(html)).toEqual({ ok: false, reason: "terms" });
  });

  it("a page with no view model and no marker is shape", () => {
    expect(parseCaseList("<html><body><p>Underhåll pågår</p></body></html>")).toEqual({ ok: false, reason: "shape" });
  });

  it("a normal page that also has a 'Logga in' link in its header still parses ok (markers are read only when the view model is missing)", () => {
    const html = fixture("list-droskhasten-8").replace("<body>", '<body><nav><a href="/logga-in">Logga in</a></nav>');
    expect(html).toContain("Logga in");
    const parsed = parseCaseList(html);
    expect(parsed.ok).toBe(true);
  });
});

describe("pageMarkers and termsLinks", () => {
  it("no saved page shows a login or terms marker, and none has a terms link", () => {
    for (const name of [
      "list-droskhasten-8",
      "ext-sodermalm-stambyte-1985",
      "ext-sodermalm-balkong-2025-06",
      "case-stambyte-2020-startbesked-slutbesked",
    ]) {
      expect(pageMarkers(fixture(name)), name).toEqual({ login: false, terms: false });
    }
    for (const name of ["list-droskhasten-8", "ext-sodermalm-stambyte-1985", "ext-sodermalm-balkong-2025-06"]) {
      const parsed = parseCaseList(fixture(name));
      if (!parsed.ok) throw new Error("parse failed");
      expect(parsed.termsLinks, name).toEqual([]);
    }
  });

  it("a terms anchor injected into the list page is reported by its text, cut and de-duplicated, never by its href", () => {
    const html = fixture("list-droskhasten-8").replace(
      "<body>",
      '<body><a href="https://example.test/secret-path">Användarvillkor</a><a href="/x">Användarvillkor</a>',
    );
    const parsed = parseCaseList(html);
    if (!parsed.ok) throw new Error("parse failed");
    expect(parsed.termsLinks).toEqual(["Användarvillkor"]);
    expect(JSON.stringify(parsed.termsLinks)).not.toContain("secret-path");
    expect(termsLinks(`<a>${"Villkor ".repeat(30)}</a>`)[0]).toHaveLength(60);
  });
});
