import { describe, expect, it } from "vitest";
import type { StoredCase } from "@/lib/stockholm/bygglov-classify";
import {
  SPIKE_BUILDINGS,
  SPIKE_STOP_LABELS,
  buildSpikeReport,
  readRobots,
  renderSpikeMarkdown,
  secondsStats,
  spikeReportSchema,
  spikeVerdict,
  stambyteYearsOf,
  type SpikeBuildingRecord,
  type SpikeRunFacts,
  type VerdictInput,
} from "@/lib/stockholm/spike-report";

const CLEAN: VerdictInput = { refusal: null, robotsDisallows: false, termsLinks: [], minkarta: "accepted" };

describe("the spike buildings", () => {
  it("are the 13 addresses of D-04 with Folkungagatan 61 first", () => {
    expect(SPIKE_BUILDINGS).toHaveLength(13);
    expect(SPIKE_BUILDINGS[0]).toMatchObject({ address: "Folkungagatan 61", booliIds: ["150148"], constructionYear: 1912 });
    expect(new Set(SPIKE_BUILDINGS.map((b) => b.address)).size).toBe(13);
    expect(SPIKE_BUILDINGS.find((b) => b.address === "Tjurbergsgatan 38")?.booliIds).toEqual(["324847", "324863"]);
    expect(SPIKE_BUILDINGS.map((b) => b.address)).toEqual(expect.arrayContaining(["Tideliusgatan 55", "Hornsgatan 119"]));
  });
});

describe("spikeVerdict: the city saying no ends the phase", () => {
  it("is go on a clean run", () => {
    expect(spikeVerdict(CLEAN)).toEqual({ verdict: "go", reason: null, minkarta: "accepted" });
  });

  it.each(["http-403", "http-429", "inloggning", "villkor", "andrad-sida", "fel-innehallstyp", "pausad"])(
    "is stop for the refusal label %s",
    (label) => {
      expect(spikeVerdict({ ...CLEAN, refusal: label })).toEqual({ verdict: "stop", reason: label, minkarta: "accepted" });
    },
  );

  it("keeps the label list and the rule in step", () => {
    for (const label of SPIKE_STOP_LABELS) expect(spikeVerdict({ ...CLEAN, refusal: label }).verdict).toBe("stop");
  });

  it("is go when the run ended on a failure that is not a refusal (a 500, a budget, a too big page)", () => {
    for (const label of ["http-500", "http-404", "storlek", "budget", "natverksfel"]) {
      expect(spikeVerdict({ ...CLEAN, refusal: label }).verdict).toBe("go");
    }
  });

  it("is stop 'robots' when robots.txt closes the case pages", () => {
    expect(spikeVerdict({ ...CLEAN, robotsDisallows: true })).toMatchObject({ verdict: "stop", reason: "robots" });
  });

  it("is stop 'villkor-lank' when a case page links to terms of use", () => {
    expect(spikeVerdict({ ...CLEAN, termsLinks: ["Användarvillkor"] })).toMatchObject({ verdict: "stop", reason: "villkor-lank" });
  });

  it("is stop 'omdirigering' on a redirect, because a redirect to a login page looks like a network error", () => {
    expect(spikeVerdict({ ...CLEAN, redirects: 1 })).toMatchObject({ verdict: "stop", reason: "omdirigering" });
  });

  it("is go with minkarta 'nekad' when Min Karta alone refused", () => {
    expect(spikeVerdict({ ...CLEAN, minkarta: "nekad" })).toEqual({ verdict: "go", reason: null, minkarta: "nekad" });
  });

  it("is stop when too few buildings were tried, go at exactly the number needed", () => {
    expect(spikeVerdict({ ...CLEAN, buildingsAttempted: 9, buildingsRequired: 10 })).toMatchObject({ verdict: "stop", reason: "for-fa-byggnader" });
    expect(spikeVerdict({ ...CLEAN, buildingsAttempted: 10, buildingsRequired: 10 }).verdict).toBe("go");
  });

  it("is stop 'ingen-losning' when no building could be resolved at all", () => {
    expect(spikeVerdict({ ...CLEAN, buildingsAttempted: 13, buildingsRequired: 10, buildingsResolved: 0 })).toMatchObject({
      verdict: "stop",
      reason: "ingen-losning",
    });
    expect(spikeVerdict({ ...CLEAN, buildingsAttempted: 13, buildingsRequired: 10, buildingsResolved: 1 }).verdict).toBe("go");
  });

  it("names the first reason when several apply: the refusal before robots before terms", () => {
    const all = { ...CLEAN, refusal: "http-403", robotsDisallows: true, termsLinks: ["Villkor"] };
    expect(spikeVerdict(all).reason).toBe("http-403");
    expect(spikeVerdict({ ...all, refusal: null }).reason).toBe("robots");
  });
});

describe("readRobots", () => {
  it("lets a robots.txt without rules for the e-service through", () => {
    const text = "User-agent: *\nDisallow: /admin/\nDisallow: /sok\n";
    expect(readRobots(text)).toEqual({ disallowsCasePages: false, rulesUnderService: [] });
  });

  it("closes the case pages for 'Disallow: /Byggochplantjansten' (case does not matter)", () => {
    const hit = readRobots("User-agent: *\nDisallow: /Byggochplantjansten\n");
    expect(hit.disallowsCasePages).toBe(true);
    expect(hit.rulesUnderService).toEqual(["/Byggochplantjansten"]);
    expect(readRobots("User-agent: *\nDisallow: /byggochplantjansten/arendeochhandlingar\n").disallowsCasePages).toBe(true);
  });

  it("closes everything for 'Disallow: /'", () => {
    expect(readRobots("User-agent: *\nDisallow: /\n").disallowsCasePages).toBe(true);
  });

  it("ignores rules for other robots and an empty Disallow", () => {
    expect(readRobots("User-agent: Googlebot\nDisallow: /\n").disallowsCasePages).toBe(false);
    expect(readRobots("User-agent: *\nDisallow:\n").disallowsCasePages).toBe(false);
  });

  it("lets a longer Allow win over a shorter Disallow, and a sibling path stay open", () => {
    const text = "User-agent: *\nDisallow: /Byggochplantjansten/\nAllow: /Byggochplantjansten/arende\nAllow: /Byggochplantjansten/CaseSearch\nAllow: /byggochplantjansten/arendeochhandlingar\n";
    expect(readRobots(text).disallowsCasePages).toBe(false);
    expect(readRobots("User-agent: *\nDisallow: /Byggochplantjansten/Admin\n").disallowsCasePages).toBe(false);
  });

  it("counts a rule that names several agents when one of them is '*'", () => {
    expect(readRobots("User-agent: bingbot\nUser-agent: *\nDisallow: /byggochplantjansten/\n").disallowsCasePages).toBe(true);
  });

  it("treats an HTML page or an empty text as no rules", () => {
    expect(readRobots("<html><body>Sidan finns inte</body></html>").disallowsCasePages).toBe(false);
    expect(readRobots("").disallowsCasePages).toBe(false);
  });

  it("understands wildcards and the end marker", () => {
    expect(readRobots("User-agent: *\nDisallow: /*/arende/\n").disallowsCasePages).toBe(true);
    expect(readRobots("User-agent: *\nDisallow: /byggochplantjansten/arendeochhandlingar$\n").disallowsCasePages).toBe(true);
  });
});

const caseOf = (extra: Partial<StoredCase>): StoredCase => ({
  rec: "1",
  diarie: "2006-1",
  startDate: "2006-04-24",
  kinds: ["stambyte"],
  primary: "stambyte",
  tillsyn: false,
  archived: true,
  detailRead: false,
  latest: null,
  startbeskedDate: null,
  slutbeskedDate: null,
  closedDate: null,
  ...extra,
});

describe("stambyteYearsOf", () => {
  it("uses the slutbesked year when there is one, else the start year, sorted and without duplicates", () => {
    const years = stambyteYearsOf([
      caseOf({ rec: "1", startDate: "2006-04-24" }),
      caseOf({ rec: "2", startDate: "2020-12-01", slutbeskedDate: "2023-03-15" }),
      caseOf({ rec: "3", startDate: "2006-09-09" }),
    ]);
    expect(years).toEqual([2006, 2023]);
  });

  it("leaves out enforcement cases, withdrawn cases and other kinds", () => {
    const years = stambyteYearsOf([
      caseOf({ rec: "1", tillsyn: true }),
      caseOf({ rec: "2", latest: { type: "Beslut", code: "Avskrivet", date: "2007-01-01" } }),
      caseOf({ rec: "3", kinds: ["balkong_ny"], primary: "balkong_ny" }),
    ]);
    expect(years).toEqual([]);
  });
});

describe("secondsStats", () => {
  it("gives median, max and count, and nulls for an empty list", () => {
    expect(secondsStats([3.3, 1.1, 0.4])).toEqual({ median: 1.1, max: 3.3, n: 3 });
    expect(secondsStats([1, 2])).toEqual({ median: 1.5, max: 2, n: 2 });
    expect(secondsStats([])).toEqual({ median: null, max: null, n: 0 });
  });
});

const building = (extra: Partial<SpikeBuildingRecord> = {}): SpikeBuildingRecord => ({
  booliIds: ["150148"],
  address: "Folkungagatan 61",
  constructionYear: 1912,
  rungsTried: ["b"],
  rung: "b",
  beteckning: "Droskhästen 8",
  status: "resolved",
  fromCache: false,
  buildCases: 53,
  otherCases: 27,
  kinds: { stambyte: 1, hiss: 1, annat: 40 },
  stambyteYears: [2006],
  stambyteOngoing: false,
  balconyCases: [{ kind: "balkong_ny", month: "2017-05", decision: "avskrivet" }],
  recentInteresting: [{ kind: "vind_inredning", month: "2023-10", decision: null }],
  detailPagesRead: 0,
  requestSeconds: [0.3, 1.4],
  notes: [],
  refusal: null,
  ...extra,
});

const facts = (extra: Partial<SpikeRunFacts> = {}): SpikeRunFacts => ({
  ranAt: "2026-10-18T20:00:00.000Z",
  dryRun: false,
  buildings: [building()],
  selectedCount: 1,
  requests: { city: 4, minkarta: 2 },
  citySeconds: [0.3, 1.4, 3.3, 0.6],
  minkartaSeconds: [0.4, 0.5],
  robots: { status: 200, text: "User-agent: *\nDisallow: /admin\n" },
  termsLinks: [],
  redirects: 0,
  refusal: null,
  substringTest: { query: "ambyte", count: 9, stambyteCount: 9, overlap: 9, substring: true },
  minkarta: { address: "Folkungagatan 61", status: "accepted", beteckning: "Droskhästen 8", agreesWithCity: true, calls: 2 },
  ...extra,
});

describe("buildSpikeReport and renderSpikeMarkdown", () => {
  it("builds a report that passes the schema and renders a go summary", () => {
    const report = buildSpikeReport(facts());
    expect(spikeReportSchema.safeParse(report).success).toBe(true);
    expect(report.verdict).toBe("go");
    expect(report.stopReason).toBeNull();
    expect(report.secondsPerRequest).toEqual({ median: 1, max: 3.3, n: 4 });
    expect(report.distinctBeteckningar).toBe(1);

    const md = renderSpikeMarkdown(report);
    expect(md.startsWith("# Spike: stadens ärendelista (14.6)")).toBe(true);
    expect(md).toMatch(/^Utfall: GO$/m);
    expect(md).toContain("Folkungagatan 61");
    expect(md).toContain("Droskhästen 8");
    expect(md).toContain("2006");
    expect(md).toContain("Beskrivningsfältet söker inne i ord: JA");
    expect(md).toContain("robots.txt (HTTP 200)");
    expect(md).toContain("Min Karta med vårt ärliga User-Agent");
  });

  it("renders 'Utfall: STOPP (<reason>)' on a refusal and says the phase stops", () => {
    const report = buildSpikeReport(facts({ refusal: "http-403" }));
    expect(report.verdict).toBe("stop");
    expect(report.stopReason).toBe("http-403");
    const md = renderSpikeMarkdown(report);
    expect(md).toMatch(/^Utfall: STOPP \(http-403\)$/m);
    expect(md).toContain("fasen slutar här");
  });

  it("is stop 'robots' when the robots.txt text closes the case pages, and 'villkor-lank' on a terms link", () => {
    const robots = buildSpikeReport(facts({ robots: { status: 200, text: "User-agent: *\nDisallow: /Byggochplantjansten/\n" } }));
    expect(robots).toMatchObject({ verdict: "stop", stopReason: "robots" });
    expect(robots.robots.disallowsCasePages).toBe(true);
    const terms = buildSpikeReport(facts({ termsLinks: ["Användarvillkor"] }));
    expect(terms).toMatchObject({ verdict: "stop", stopReason: "villkor-lank" });
    expect(renderSpikeMarkdown(terms)).toMatch(/^Utfall: STOPP \(villkor-lank\)$/m);
  });

  it("keeps the verdict go and records rung c as off when Min Karta refused", () => {
    const report = buildSpikeReport(
      facts({ minkarta: { address: "Folkungagatan 61", status: "nekad", beteckning: null, agreesWithCity: null, calls: 1 } }),
    );
    expect(report.verdict).toBe("go");
    expect(report.minkarta.status).toBe("nekad");
    expect(renderSpikeMarkdown(report)).toContain("NEKAD");
  });

  it("says plainly when the substring test had no clear answer or when the field matches whole words only", () => {
    const whole = buildSpikeReport(facts({ substringTest: { query: "ambyte", count: 0, stambyteCount: 9, overlap: 0, substring: false } }));
    expect(renderSpikeMarkdown(whole)).toContain("NEJ, bara hela ord");
    const unclear = buildSpikeReport(facts({ substringTest: { query: "ambyte", count: null, stambyteCount: null, overlap: null, substring: null } }));
    expect(renderSpikeMarkdown(unclear)).toContain("inget läsbart svar");
  });

  it("is stop 'for-fa-byggnader' when fewer than 10 of 13 buildings were tried", () => {
    const report = buildSpikeReport(facts({ selectedCount: 13, buildings: [building(), building({ address: "Idungatan 5", beteckning: "Skalmejblåsaren 12" })] }));
    expect(report).toMatchObject({ verdict: "stop", stopReason: "for-fa-byggnader" });
    expect(report.distinctBeteckningar).toBe(2);
  });

  it("says in the summary that a dry run measured nothing", () => {
    const md = renderSpikeMarkdown(buildSpikeReport(facts({ dryRun: true })));
    expect(md).toContain("torrkörning");
    expect(md).toContain("Inte prövat");
  });
});

describe("what the evidence may hold", () => {
  it("rejects a key the schema does not know, so no name or free text can ride along", () => {
    const report = buildSpikeReport(facts());
    const withName = { ...report, buildings: [{ ...report.buildings[0], Handler: "En Person" }] };
    expect(spikeReportSchema.safeParse(withName).success).toBe(false);
    const withText = { ...report, buildings: [{ ...report.buildings[0], Description: "Byte av stammar" }] };
    expect(spikeReportSchema.safeParse(withText).success).toBe(false);
  });

  it("writes none of the forbidden keys into a report", () => {
    const json = JSON.stringify(buildSpikeReport(facts()));
    expect(json).not.toMatch(/"(Handler|Documents|Description)"/);
  });
});
