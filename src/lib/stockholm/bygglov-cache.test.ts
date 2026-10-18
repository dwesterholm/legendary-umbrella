import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BYGGLOV_RULES_VERSION, classifyDescription, toStoredCase, type StoredCase } from "@/lib/stockholm/bygglov-classify";
import {
  BYGGLOV_CACHE_DIR,
  CASE_LIST_TTL_DAYS,
  addressEntryFresh,
  beteckningSlug,
  caseListNeedsRefresh,
  AddressMapDamaged,
  addressMapDamage,
  loadAddressMap,
  loadCaseList,
  loadSweep,
  normaliseAddressKey,
  refreshCaseListIfStale,
  saveAddressMap,
  saveCaseList,
  saveGuardedJson,
  saveSweep,
  sweepFileName,
  type AddressEntry,
  type CaseListSource,
  type SweepCase,
} from "@/lib/stockholm/bygglov-cache";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bygglov-cache-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const aCase = (rec: string, text = "Installation av hiss"): StoredCase =>
  toStoredCase(
    {
      rec,
      caseType: "Byggärende",
      description: text,
      startDate: "2023-10-05",
      beteckning: "Droskhästen 8",
      addresses: ["Folkungagatan 61"],
      diarie: "2023-15008",
      archived: false,
    },
    classifyDescription(text),
  );

const readCaseFile = (name: string) => JSON.parse(readFileSync(join(dir, "cases", name), "utf8")) as Record<string, unknown>;

describe("constants", () => {
  it("keeps the cache in the gitignored data directory and the TTL at 30 days", () => {
    expect(BYGGLOV_CACHE_DIR).toBe(".planning/calibration/data/bygglov");
    expect(CASE_LIST_TTL_DAYS).toBe(30);
  });
});

describe("beteckningSlug", () => {
  it("lower-cases, maps å and ä to a and ö to o, spaces to a dash, a colon to an underscore, and drops every other character", () => {
    expect(beteckningSlug("Droskhästen 8")).toBe("droskhasten-8");
    expect(beteckningSlug("Ormen Mindre 2")).toBe("ormen-mindre-2");
    expect(beteckningSlug("Älgen Östra 5")).toBe("algen-ostra-5");
    expect(beteckningSlug("Tegelbruket 7:3")).toBe("tegelbruket-7_3");
    expect(beteckningSlug("  Kv.  Ö/Å  ")).toBe("kv-oa");
  });

  it("WR-11: Södermalm 8:57, 85:7 and 857 get three different file names", () => {
    const slugs = ["Södermalm 8:57", "Södermalm 85:7", "Södermalm 857"].map(beteckningSlug);
    expect(new Set(slugs).size).toBe(3);
    expect(slugs).toEqual(["sodermalm-8_57", "sodermalm-85_7", "sodermalm-857"]);
  });

  it("WR-11: each of them keeps its own case-list file", () => {
    saveCaseList("Södermalm 8:57", { cases: [aCase("1")] }, { dir, now: NOW });
    saveCaseList("Södermalm 857", { cases: [aCase("2")] }, { dir, now: NOW });
    const a = loadCaseList("Södermalm 8:57", { dir });
    const b = loadCaseList("Södermalm 857", { dir });
    expect(a.ok && a.entry.cases.map((c) => c.rec)).toEqual(["1"]);
    expect(b.ok && b.entry.cases.map((c) => c.rec)).toEqual(["2"]);
  });

  it("a beteckning that tries to climb out of the directory is slugged to plain characters", () => {
    expect(beteckningSlug("../x 1")).toBe("x-1");
    expect(beteckningSlug("..\\..\\etc/passwd")).toBe("etcpasswd");
    expect(beteckningSlug("../..")).toBe("");
  });
});

describe("caseListNeedsRefresh (the 30 day rule)", () => {
  const entry = (fetchedAt: string, rulesVersion = BYGGLOV_RULES_VERSION) => ({ fetchedAt, rulesVersion });

  it("29 d 23 h old is fresh and exactly 30 d old is stale", () => {
    expect(caseListNeedsRefresh(entry(ago(29 * DAY + 23 * HOUR)), NOW)).toBe(false); // 29 d 23 h
    expect(caseListNeedsRefresh(entry(ago(30 * DAY)), NOW)).toBe(true); // 30 d
    expect(caseListNeedsRefresh(entry(ago(30 * DAY - 1)), NOW)).toBe(false);
    expect(caseListNeedsRefresh(entry(ago(0)), NOW)).toBe(false);
  });

  it("more than a day in the future is stale; a day or less ahead is tolerated", () => {
    expect(caseListNeedsRefresh(entry(ago(-(DAY + 1))), NOW)).toBe(true);
    expect(caseListNeedsRefresh(entry(ago(-DAY)), NOW)).toBe(false);
  });

  it("an unparsable fetchedAt, a missing entry and another rulesVersion are stale", () => {
    expect(caseListNeedsRefresh(entry("yesterday-ish"), NOW)).toBe(true);
    expect(caseListNeedsRefresh(null, NOW)).toBe(true);
    expect(caseListNeedsRefresh(entry(ago(HOUR), BYGGLOV_RULES_VERSION + 1), NOW)).toBe(true);
  });
});

describe("saveCaseList / loadCaseList", () => {
  it("round-trips every field of every case and keeps the other cases", () => {
    const cases = [aCase("1266358"), aCase("1266359", "Stambyte i hela huset")];
    const other = [aCase("77", "Särskild besiktning av lintrummehissar")];
    saveCaseList("Droskhästen 8", { cases, otherCases: other }, { dir, now: NOW });
    const loaded = loadCaseList("Droskhästen 8", { dir });
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.entry.cases).toEqual(cases);
    expect(loaded.entry.otherCases).toEqual(other);
    expect(loaded.entry.fetchedAt).toBe(NOW.toISOString());
    expect(loaded.entry.rulesVersion).toBe(BYGGLOV_RULES_VERSION);
    expect(loaded.entry.beteckning).toBe("Droskhästen 8");
  });

  it("a fully read case (decisions, dates) round-trips too", () => {
    const read: StoredCase = {
      ...aCase("5", "Stambyte"),
      detailRead: true,
      latest: { type: "Slutbesked / slutbevis", code: "Bifall", date: "2021-05-04" },
      startbeskedDate: "2020-01-02",
      slutbeskedDate: "2021-05-04",
      closedDate: "2021-06-01",
    };
    saveCaseList("Oljan 29", { cases: [read] }, { dir, now: NOW });
    const loaded = loadCaseList("Oljan 29", { dir });
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.entry.cases[0]).toEqual(read);
    expect(loaded.entry.otherCases).toEqual([]);
  });

  it("a serialised entry holds no Description, Handler or Documents key, and saving one is refused", () => {
    saveCaseList("Droskhästen 8", { cases: [aCase("1")] }, { dir, now: NOW });
    const text = readFileSync(join(dir, "cases", "droskhasten-8.json"), "utf8");
    expect(text).not.toMatch(/"(Description|Handler|Documents|description|handler|documents)"/);

    const dirty = { ...aCase("2"), Description: "Fritext med namn", Handler: "Testa Testsson" } as unknown as StoredCase;
    expect(() => saveCaseList("Oljan 29", { cases: [dirty] }, { dir, now: NOW })).toThrow();
    expect(existsSync(join(dir, "cases", "oljan-29.json"))).toBe(false);
  });

  it("a hand-edited file that carries a forbidden key is a fel format miss, not served", () => {
    saveCaseList("Droskhästen 8", { cases: [aCase("1")] }, { dir, now: NOW });
    const file = readCaseFile("droskhasten-8.json") as { cases: Array<Record<string, unknown>> };
    file.cases[0].Handler = "Testa Testsson";
    writeFileSync(join(dir, "cases", "droskhasten-8.json"), JSON.stringify(file), "utf8");
    expect(loadCaseList("Droskhästen 8", { dir })).toEqual({ ok: false, error: "fel format" });
  });

  it("a missing file is 'saknas'", () => {
    expect(loadCaseList("Droskhästen 8", { dir })).toEqual({ ok: false, error: "saknas" });
  });

  it("invalid JSON, a wrong schema and a file for another beteckning are misses with the Swedish reason, and the file is never touched", () => {
    mkdirSync(join(dir, "cases"), { recursive: true });
    const path = join(dir, "cases", "droskhasten-8.json");

    writeFileSync(path, "{broken", "utf8");
    expect(loadCaseList("Droskhästen 8", { dir })).toEqual({ ok: false, error: "ogiltig JSON" });
    expect(readFileSync(path, "utf8")).toBe("{broken");

    writeFileSync(path, JSON.stringify({ schemaVersion: 2, cases: "nope" }), "utf8");
    expect(loadCaseList("Droskhästen 8", { dir })).toEqual({ ok: false, error: "fel format" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ schemaVersion: 2, cases: "nope" });

    // "Droskhästen 8" and "Droskhasten 8" share the slug droskhasten-8: a collision is a miss, never wrong data.
    saveCaseList("Droskhästen 8", { cases: [aCase("1")] }, { dir, now: NOW });
    const before = readFileSync(path, "utf8");
    expect(loadCaseList("Droskhasten 8", { dir })).toEqual({ ok: false, error: "annan fastighet" });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(join(dir, "cases"))).toEqual(["droskhasten-8.json"]);
  });

  it("the comparison ignores case and extra spaces", () => {
    saveCaseList("Droskhästen 8", { cases: [aCase("1")] }, { dir, now: NOW });
    expect(loadCaseList("  droskhästen   8 ", { dir }).ok).toBe(true);
  });

  it("a beteckning '../x 1' is saved as cases/x-1.json inside the directory", () => {
    saveCaseList("../x 1", { cases: [aCase("1")] }, { dir, now: NOW });
    expect(existsSync(join(dir, "cases", "x-1.json"))).toBe(true);
    expect(existsSync(join(dir, "..", "x-1.json"))).toBe(false);
    expect(loadCaseList("../x 1", { dir }).ok).toBe(true);
  });

  it("å, ä, ö slug to a, a, o in the file name", () => {
    saveCaseList("Åkern Ö", { cases: [] }, { dir, now: NOW });
    expect(readdirSync(join(dir, "cases"))).toEqual(["akern-o.json"]);
  });

  it("a beteckning with nothing left after slugging is refused and nothing is written", () => {
    expect(() => saveCaseList("../..", { cases: [] }, { dir, now: NOW })).toThrow(/beteckning/);
    expect(existsSync(join(dir, "cases"))).toBe(false);
  });

  it("saveGuardedJson refuses a path outside the cache directory and a wrong extension", () => {
    expect(() => saveGuardedJson(join(dir, "..", "escape.json"), {}, dir)).toThrow(/får bara skrivas/);
    expect(() => saveGuardedJson(join(dir, "file.txt"), {}, dir)).toThrow(/får bara skrivas/);
    expect(() => saveGuardedJson(`${dir}-evil/x.json`, {}, dir)).toThrow(/får bara skrivas/);
    saveGuardedJson(join(dir, "ok.json"), { a: 1 }, dir);
    expect(JSON.parse(readFileSync(join(dir, "ok.json"), "utf8"))).toEqual({ a: 1 });
  });
});

describe("normaliseAddressKey", () => {
  it("lower-cases, collapses spaces and closes up the entrance letter", () => {
    expect(normaliseAddressKey("Torsgatan 48 A")).toBe("torsgatan 48a"); // torsgatan 48a
    expect(normaliseAddressKey("Torsgatan 48A")).toBe("torsgatan 48a");
    expect(normaliseAddressKey("  Torsgatan   48   a ")).toBe("torsgatan 48a");
    expect(normaliseAddressKey("Folkungagatan 61")).toBe("folkungagatan 61");
    expect(normaliseAddressKey("Östgötagatan 33")).toBe("östgötagatan 33");
  });

  it("is idempotent", () => {
    for (const a of ["Torsgatan 48 A", "Folkungagatan 61", "Hornsgatan 42B"]) {
      expect(normaliseAddressKey(normaliseAddressKey(a))).toBe(normaliseAddressKey(a));
    }
  });
});

describe("the address map (address-beteckning.json)", () => {
  const entry = (over: Partial<AddressEntry> = {}): AddressEntry => ({
    beteckning: "Droskhästen 8",
    rung: "b",
    status: "resolved",
    at: NOW.toISOString(),
    ...over,
  });

  it("round-trips resolved, ambiguous and no_candidates entries with every field", () => {
    const map = {
      "folkungagatan 61": entry(),
      "torsgatan 48a": entry({ beteckning: null, rung: null, status: "ambiguous" }),
      "finnsinte 1": entry({ beteckning: null, rung: "c", status: "no_candidates" }),
      "oljan 29": entry({ rung: "a2" }),
      "kvarter 1": entry({ rung: "a" }),
    };
    saveAddressMap(map, { dir });
    const loaded = loadAddressMap({ dir });
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.map).toEqual(map);
    expect(existsSync(join(dir, "address-beteckning.json"))).toBe(true);
  });

  it("a resolved entry is fresh for 365 d and stale at 365 d; a negative one is fresh for 30 d and stale at 30 d", () => {
    const at = (ms: number) => ago(ms);
    expect(addressEntryFresh(entry({ at: at(364 * DAY + 23 * HOUR) }), NOW)).toBe(true); // 365
    expect(addressEntryFresh(entry({ at: at(365 * DAY) }), NOW)).toBe(false);
    const none = (ms: number) => entry({ beteckning: null, rung: null, status: "no_candidates", at: at(ms) });
    expect(addressEntryFresh(none(29 * DAY + 23 * HOUR), NOW)).toBe(true);
    expect(addressEntryFresh(none(30 * DAY), NOW)).toBe(false);
    const amb = entry({ beteckning: null, status: "ambiguous", at: at(31 * DAY) });
    expect(addressEntryFresh(amb, NOW)).toBe(false);
    expect(addressEntryFresh(entry({ at: "nonsense" }), NOW)).toBe(false);
    expect(addressEntryFresh(entry({ at: at(-(2 * DAY)) }), NOW)).toBe(false);
  });

  it("a fetch_failed entry is refused and nothing is written", () => {
    const bad = { "torsgatan 48a": { ...entry(), beteckning: null, rung: null, status: "fetch_failed" } } as unknown as Record<string, AddressEntry>;
    expect(() => saveAddressMap(bad, { dir })).toThrow(/fetch_failed/);
    expect(existsSync(join(dir, "address-beteckning.json"))).toBe(false);
  });

  it("a resolved entry without a beteckning, an unknown rung and an un-normalised key are refused", () => {
    expect(() => saveAddressMap({ "a 1": entry({ beteckning: null }) }, { dir })).toThrow();
    expect(() => saveAddressMap({ "a 1": entry({ rung: "z" as never }) }, { dir })).toThrow();
    expect(() => saveAddressMap({ "Torsgatan 48 A": entry() }, { dir })).toThrow();
  });

  it("bad files are misses with the Swedish reason and are left alone", () => {
    expect(loadAddressMap({ dir })).toEqual({ ok: false, error: "saknas" });
    writeFileSync(join(dir, "address-beteckning.json"), "[1,", "utf8");
    expect(loadAddressMap({ dir })).toEqual({ ok: false, error: "ogiltig JSON" });
    writeFileSync(join(dir, "address-beteckning.json"), JSON.stringify({ schemaVersion: 1, entries: 5 }), "utf8");
    expect(loadAddressMap({ dir })).toEqual({ ok: false, error: "fel format" });
    expect(readFileSync(join(dir, "address-beteckning.json"), "utf8")).toContain('"entries"');
  });

  it("CR-01: one damaged entry is dropped and counted, the good ones are kept", () => {
    const good = entry();
    writeFileSync(
      join(dir, "address-beteckning.json"),
      JSON.stringify({ schemaVersion: 1, entries: { "folkungagatan 61": good, "torsgatan 48a": { ...good, status: "resolvd" }, x: 1 } }),
      "utf8",
    );
    const loaded = loadAddressMap({ dir });
    if (!loaded.ok) throw new Error(loaded.error);
    expect(Object.keys(loaded.map)).toEqual(["folkungagatan 61"]);
    expect(loaded.dropped).toBe(2);
    expect(addressMapDamage({ dir })).toMatch(/2 poster/);
  });

  it("CR-01: a save over a file that lost entries on reading is refused and the file is untouched", () => {
    const file = join(dir, "address-beteckning.json");
    const text = JSON.stringify({ schemaVersion: 1, entries: { "folkungagatan 61": entry(), "torsgatan 48a": { ...entry(), status: "resolvd" } } });
    writeFileSync(file, text, "utf8");
    expect(() => saveAddressMap({ "oljan 29": entry() }, { dir })).toThrow(AddressMapDamaged);
    expect(readFileSync(file, "utf8")).toBe(text);
    writeFileSync(file, "[1,", "utf8");
    expect(() => saveAddressMap({ "oljan 29": entry() }, { dir })).toThrow(AddressMapDamaged);
    expect(readFileSync(file, "utf8")).toBe("[1,");
  });
});

describe("sweep files", () => {
  const query = { district: "Södermalm", description: "stambyte", from: "1985-01-01", to: "2009-12-31" };
  const sweepCase = (rec: string): SweepCase => ({
    rec,
    beteckning: "Droskhästen 8",
    addresses: ["Folkungagatan 61", "Östgötagatan 33"],
    startDate: "2006-06-01",
    kinds: ["stambyte", "fasad"],
    primary: "stambyte",
    tillsyn: false,
    archived: true,
  });

  it("builds the file name from slugged parts only", () => {
    expect(sweepFileName(query)).toBe("sodermalm-stambyte-19850101-20091231.json");
    expect(sweepFileName({ ...query, to: null })).toBe("sodermalm-stambyte-19850101-open.json");
    expect(sweepFileName({ district: "../Ö x", description: "a/b", from: "2010-01-01", to: null })).toBe("o-x-ab-20100101-open.json");
    expect(() => sweepFileName({ ...query, from: "1985-1-1" })).toThrow();
    expect(() => sweepFileName({ ...query, district: "../.." })).toThrow();
  });

  it("round-trips every field", () => {
    const cases = [sweepCase("1"), sweepCase("2")];
    saveSweep(query, { cases, headingCount: 2 }, { dir, now: NOW });
    expect(existsSync(join(dir, "sweep", "sodermalm-stambyte-19850101-20091231.json"))).toBe(true);
    const loaded = loadSweep(query, { dir });
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.entry.cases).toEqual(cases);
    expect(loaded.entry.headingCount).toBe(2);
    expect(loaded.entry.query).toEqual(query);
    expect(loaded.entry.fetchedAt).toBe(NOW.toISOString());
    expect(loaded.entry.rulesVersion).toBe(BYGGLOV_RULES_VERSION);
  });

  it("keeps a null window end and a null heading count", () => {
    const open = { ...query, to: null };
    saveSweep(open, { cases: [], headingCount: null }, { dir, now: NOW });
    const loaded = loadSweep(open, { dir });
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.entry.query.to).toBeNull();
    expect(loaded.entry.headingCount).toBeNull();
  });

  it("holds no Description, Handler or Documents key and refuses one", () => {
    saveSweep(query, { cases: [sweepCase("1")], headingCount: 1 }, { dir, now: NOW });
    const text = readFileSync(join(dir, "sweep", "sodermalm-stambyte-19850101-20091231.json"), "utf8");
    expect(text).not.toMatch(/"(Description|Handler|Documents)"/);
    const dirty = { ...sweepCase("2"), Description: "fritext" } as unknown as SweepCase;
    expect(() => saveSweep({ ...query, from: "2010-01-01" }, { cases: [dirty], headingCount: 1 }, { dir, now: NOW })).toThrow();
  });

  it("misses: missing, invalid JSON, wrong format, another search under the same name", () => {
    expect(loadSweep(query, { dir })).toEqual({ ok: false, error: "saknas" });
    mkdirSync(join(dir, "sweep"), { recursive: true });
    const path = join(dir, "sweep", sweepFileName(query));
    writeFileSync(path, "{", "utf8");
    expect(loadSweep(query, { dir })).toEqual({ ok: false, error: "ogiltig JSON" });
    writeFileSync(path, JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect(loadSweep(query, { dir })).toEqual({ ok: false, error: "fel format" });
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ schemaVersion: 1 }));

    // "Södermalm" and "Sodermalm" slug alike: the query inside the file decides.
    saveSweep(query, { cases: [], headingCount: 0 }, { dir, now: NOW });
    expect(loadSweep({ ...query, district: "Sodermalm" }, { dir })).toEqual({ ok: false, error: "annan sökning" });
  });
});

describe("refreshCaseListIfStale says out loud why it goes to the city", () => {
  const client = (): CaseListSource & { calls: number } => {
    const c = {
      calls: 0,
      async caseList() {
        c.calls += 1;
        return { cases: [aCase("9")], otherCases: [], headingCount: 1, termsLinks: [] };
      },
    };
    return c;
  };
  const logsOf = () => {
    const lines: string[] = [];
    return { lines, log: (l: string) => lines.push(l) };
  };

  it("a missing file is fetched without a miss message; a second ask is a cache hit with zero calls", async () => {
    const c = client();
    const l = logsOf();
    const first = await refreshCaseListIfStale("Droskhästen 8", { dir, now: () => NOW, client: c, log: l.log });
    expect(first.source).toBe("city");
    expect(first.miss).toBeNull();
    expect(l.lines).toEqual([]);
    const second = await refreshCaseListIfStale("Droskhästen 8", { dir, now: () => new Date(NOW.getTime() + 29 * DAY + 23 * HOUR), client: c, log: l.log });
    expect(second.source).toBe("cache");
    expect(c.calls).toBe(1);
  });

  it("a case list exactly 30 days old is fetched again", async () => {
    const c = client();
    await refreshCaseListIfStale("Droskhästen 8", { dir, now: () => NOW, client: c });
    const again = await refreshCaseListIfStale("Droskhästen 8", { dir, now: () => new Date(NOW.getTime() + 30 * DAY), client: c });
    expect(again.source).toBe("city");
    expect(c.calls).toBe(2);
  });

  it("a changed rulesVersion is a miss said out loud", async () => {
    const c = client();
    saveCaseList("Droskhästen 8", { cases: [aCase("1")] }, { dir, now: NOW });
    const path = join(dir, "cases", "droskhasten-8.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    file.rulesVersion = BYGGLOV_RULES_VERSION + 1;
    writeFileSync(path, JSON.stringify(file), "utf8");
    const l = logsOf();
    const result = await refreshCaseListIfStale("Droskhästen 8", { dir, now: () => NOW, client: c, log: l.log });
    expect(result.source).toBe("city");
    expect(result.miss).toBe("regelversionen har ändrats");
    expect(l.lines).toHaveLength(1);
    expect(l.lines[0]).toMatch(/^\[stockholm\] cache droskhasten-8: regelversionen har ändrats/);
  });

  it("an unreadable file is a miss said out loud, and the fresh answer overwrites it", async () => {
    const c = client();
    mkdirSync(join(dir, "cases"), { recursive: true });
    writeFileSync(join(dir, "cases", "droskhasten-8.json"), "{broken", "utf8");
    const l = logsOf();
    const result = await refreshCaseListIfStale("Droskhästen 8", { dir, now: () => NOW, client: c, log: l.log });
    expect(result.miss).toBe("ogiltig JSON");
    expect(l.lines[0]).toContain("ogiltig JSON");
    expect(loadCaseList("Droskhästen 8", { dir }).ok).toBe(true);
  });

  it("a failing client ends the run: nothing is caught and nothing is saved", async () => {
    const failing: CaseListSource = {
      async caseList() {
        throw new Error("stopp");
      },
    };
    await expect(refreshCaseListIfStale("Droskhästen 8", { dir, now: () => NOW, client: failing })).rejects.toThrow("stopp");
    expect(existsSync(join(dir, "cases"))).toBe(false);
  });
});
