import { afterEach, describe, expect, it, vi } from "vitest";
import { OSM_ATTRIBUTION, OSM_MAX_MEMBERS_PER_RELATION, OSM_MAX_POINTS_PER_WAY, parseOsmExtract } from "@/lib/discovery/osm-buildings";
import {
  OSM_BBOX,
  OVERPASS_ENDPOINTS,
  OVERPASS_LIMITS,
  OVERPASS_QUERIES,
  OVERPASS_USER_AGENT,
  downloadOsmExtract,
  importResearchExtract,
} from "@/lib/discovery/osm-overpass";

// ---------------------------------------------------------------------------
// Helpers: a scripted fetch (no network), a recording sleep (no waiting)
// ---------------------------------------------------------------------------

type QueryKind = "buildings" | "relations" | "roads";

const NOW = new Date("2026-10-14T09:30:00.000Z");
const OSM_BASE = "2026-10-14T09:12:44Z";

const point = (i: number) => ({ lat: 59.3 + (i % 50) * 0.0005, lon: 18.0 + (i % 70) * 0.0005 });
const wayEl = (id: number, tags: Record<string, string> = { building: "yes" }, extra: Record<string, unknown> = {}) => ({
  type: "way",
  id,
  tags,
  geometry: [point(id), point(id + 1), point(id + 2), point(id)],
  ...extra,
});
const relationEl = (id: number, withMembers = true) => ({
  type: "relation",
  id,
  tags: { building: "yes", type: "multipolygon" },
  ...(withMembers ? { members: [{ type: "way", ref: id * 10, role: "outer", geometry: [point(id), point(id + 1), point(id + 2), point(id)] }] } : {}),
});

const answer = (elements: unknown[], extra: Record<string, unknown> = {}, base: string | null = OSM_BASE) =>
  JSON.stringify({
    version: 0.6,
    generator: "Overpass API test",
    ...(base === null ? {} : { osm3s: { timestamp_osm_base: base, copyright: "ODbL" } }),
    elements,
    ...extra,
  });

const ways = (n: number, tags?: Record<string, string>) => Array.from({ length: n }, (_, i) => wayEl(i + 1, tags, { bounds: { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 } }));
const buildingsBody = (n = OVERPASS_LIMITS.minBuildingWays) => answer([...ways(n), relationEl(900_001, false), relationEl(900_002, false)]);
const relationsBody = (n = 3) => answer(Array.from({ length: n }, (_, i) => relationEl(800_000 + i)));
const roadsBody = (n = OVERPASS_LIMITS.minRoadWays) => answer(ways(n, { highway: "residential", name: "Folkungagatan" }));

const okBodyFor = (kind: QueryKind): string => (kind === "buildings" ? buildingsBody() : kind === "relations" ? relationsBody() : roadsBody());

const json = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, { status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });

/** Which of the three queries a request body carries. */
function queryKindOf(init: RequestInit): QueryKind {
  const text = decodeURIComponent(String(init.body).slice("data=".length));
  if (text.includes('relation["building"]')) return "relations";
  if (text.includes('way["highway"]')) return "roads";
  return "buildings";
}

interface Call {
  url: string;
  init: RequestInit;
  kind: QueryKind;
}

/** A fetch whose answer is chosen per call; records every call and the number of requests in flight at once. */
function scriptedFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const call: Call = { url, init, kind: queryKindOf(init) };
    const index = calls.length;
    calls.push(call);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await Promise.resolve();
      return await handler(call, index);
    } finally {
      inFlight--;
    }
  });
  return { fetchImpl, calls, maxInFlight: () => maxInFlight };
}

function deps(fetchImpl: ReturnType<typeof scriptedFetch>["fetchImpl"]) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  return {
    sleeps,
    logs,
    deps: {
      fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      now: () => NOW,
      log: (line: string) => {
        logs.push(line);
      },
    },
  };
}

const hostOf = (url: string) => new URL(url).host;

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("Overpass constants (R-05)", () => {
  it("the endpoint list is the four https hosts in the pinned order, main host last", () => {
    expect([...OVERPASS_ENDPOINTS]).toEqual([
      "https://lz4.overpass-api.de/api/interpreter",
      "https://z.overpass-api.de/api/interpreter",
      "https://overpass.openstreetmap.fr/api/interpreter",
      "https://overpass-api.de/api/interpreter",
    ]);
  });

  it("the bbox is the research box plus the 250 m margin", () => {
    expect(OSM_BBOX).toEqual({ south: 59.295, west: 17.985, north: 59.355, east: 18.125 });
  });

  it("the three queries carry the pinned text", () => {
    const box = "59.295,17.985,59.355,18.125";
    expect(OVERPASS_QUERIES.buildings).toContain(`way["building"](${box});out geom tags;`);
    expect(OVERPASS_QUERIES.relations).toContain(`relation["building"](${box});out geom;`);
    expect(OVERPASS_QUERIES.roads).toContain(`way["highway"]["name"](${box});out geom tags;`);
    for (const q of Object.values(OVERPASS_QUERIES)) expect(q.startsWith("[out:json][timeout:180];")).toBe(true);
  });

  it("the limits are the pinned numbers and agree with the extract schema's caps", () => {
    expect(OVERPASS_LIMITS).toEqual({
      rounds: 3,
      endpointPauseMs: 3000,
      roundPauseMs: 15000,
      requestTimeoutMs: 200000,
      maxBytes: 50 * 1024 * 1024,
      maxElements: 200000,
      maxPointsPerWay: 10000,
      maxMembers: 5000,
      minBuildingWays: 5000,
      minRoadWays: 1000,
    });
    expect(OVERPASS_LIMITS.maxPointsPerWay).toBe(OSM_MAX_POINTS_PER_WAY);
    expect(OVERPASS_LIMITS.maxMembers).toBe(OSM_MAX_MEMBERS_PER_RELATION);
  });

  it("the user agent names the project", () => {
    expect(OVERPASS_USER_AGENT).toBe("bostadai-sun-orientation/1.0 (personal research; monthly cache refresh)");
  });
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

describe("downloadOsmExtract: what is sent", () => {
  it("sends three POSTs one at a time to allowlisted hosts with the pinned headers and bodies, in order", async () => {
    const { fetchImpl, calls, maxInFlight } = scriptedFetch((c) => json(okBodyFor(c.kind)));
    const { deps: d } = deps(fetchImpl);
    await downloadOsmExtract(d);
    expect(calls.map((c) => c.kind)).toEqual(["buildings", "relations", "roads"]);
    expect(maxInFlight()).toBe(1);
    for (const c of calls) {
      expect(OVERPASS_ENDPOINTS as readonly string[]).toContain(c.url);
      expect(c.init.method).toBe("POST");
      const headers = new Headers(c.init.headers);
      expect(headers.get("user-agent")).toBe(OVERPASS_USER_AGENT);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(String(c.init.body).startsWith("data=")).toBe(true);
      expect(decodeURIComponent(String(c.init.body).slice(5))).toBe(OVERPASS_QUERIES[c.kind]);
      expect(c.init.redirect).toBe("error");
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("pauses between the three queries so requests stay under one per second", async () => {
    const { fetchImpl } = scriptedFetch((c) => json(okBodyFor(c.kind)));
    const { deps: d, sleeps } = deps(fetchImpl);
    await downloadOsmExtract(d);
    expect(sleeps).toEqual([3000, 3000]);
  });
});

// ---------------------------------------------------------------------------
// Endpoint walk and retries
// ---------------------------------------------------------------------------

describe("downloadOsmExtract: endpoint walk", () => {
  it("tries lz4 first; when lz4 answers 504 and z answers 200, z's elements are used and the log names z and 200", async () => {
    const { fetchImpl, calls } = scriptedFetch((c, i) => {
      if (i === 0) return new Response("gateway timeout", { status: 504 });
      return json(okBodyFor(c.kind));
    });
    const { deps: d, logs } = deps(fetchImpl);
    const file = await downloadOsmExtract(d);
    expect(hostOf(calls[0].url)).toBe("lz4.overpass-api.de");
    expect(hostOf(calls[1].url)).toBe("z.overpass-api.de");
    expect(file.buildings.length).toBe(OVERPASS_LIMITS.minBuildingWays);
    const successLine = logs.find((l) => l.includes("z.overpass-api.de") && l.includes("200"));
    expect(successLine).toBeDefined();
    expect(logs.some((l) => l.includes("lz4.overpass-api.de") && l.includes("504"))).toBe(true);
  });

  it("429 on all four endpoints in round 1, success on lz4 in round 2: 3 s between endpoints and 15 s between rounds", async () => {
    const { fetchImpl, calls } = scriptedFetch((c, i) => (i < 4 ? new Response("slow down", { status: 429 }) : json(okBodyFor(c.kind))));
    const { deps: d, sleeps } = deps(fetchImpl);
    await downloadOsmExtract(d);
    expect(calls.slice(0, 5).map((c) => hostOf(c.url))).toEqual([
      "lz4.overpass-api.de",
      "z.overpass-api.de",
      "overpass.openstreetmap.fr",
      "overpass-api.de",
      "lz4.overpass-api.de",
    ]);
    // 3 s x3 between the four endpoints, 15 s to the next round, then the two pauses between the three queries
    expect(sleeps).toEqual([3000, 3000, 3000, 15000, 3000, 3000]);
  });

  it("all endpoints failing for three rounds rejects, lists every attempt, sends exactly 12 requests and never the later queries", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => new Response("SECRET-BODY-MARKER overloaded", { status: 504 }));
    const { deps: d, sleeps, logs } = deps(fetchImpl);
    const error = await downloadOsmExtract(d).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    for (const host of ["lz4.overpass-api.de", "z.overpass-api.de", "overpass.openstreetmap.fr", "overpass-api.de"]) {
      expect(error!.message).toContain(`${host} HTTP 504`);
    }
    expect(calls).toHaveLength(12);
    expect(new Set(calls.map((c) => c.kind))).toEqual(new Set(["buildings"]));
    expect(sleeps.filter((ms) => ms === 15000)).toHaveLength(2);
    expect(sleeps.filter((ms) => ms === 3000)).toHaveLength(9);
    // R: logs and errors never carry a response body
    expect(error!.message).not.toContain("SECRET-BODY-MARKER");
    expect(logs.join("\n")).not.toContain("SECRET-BODY-MARKER");
  });

  it("a network error is listed by its error name, not its message", async () => {
    const { fetchImpl } = scriptedFetch(() => {
      throw new TypeError("fetch failed https://evil.example/leak?token=abc");
    });
    const { deps: d, logs } = deps(fetchImpl);
    const error = await downloadOsmExtract(d).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error!.message).toContain("lz4.overpass-api.de TypeError");
    expect(error!.message).not.toContain("evil.example");
    expect(logs.join("\n")).not.toContain("evil.example");
  });

  it("a request that hangs is aborted after the request timeout and the next endpoint is tried", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = scriptedFetch((c, i) => {
      if (i > 0) return json(okBodyFor(c.kind));
      return new Promise<Response>((_resolve, reject) => {
        (c.init.signal as AbortSignal).addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    const { deps: d } = deps(fetchImpl);
    const pending = downloadOsmExtract(d);
    await vi.advanceTimersByTimeAsync(OVERPASS_LIMITS.requestTimeoutMs + 1);
    const file = await pending;
    expect(file.buildings.length).toBeGreaterThan(0);
    expect(hostOf(calls[1].url)).toBe("z.overpass-api.de");
  });
});

// ---------------------------------------------------------------------------
// Validation of an answer
// ---------------------------------------------------------------------------

describe("downloadOsmExtract: an answer is accepted only when it looks like a real extract", () => {
  let streamPulls = 0;
  const hugeStream = (): Response => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          streamPulls++;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  };
  let declaredBodyReads = 0;
  const declaredHuge = (): Response => {
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          declaredBodyReads++;
          controller.enqueue(new Uint8Array(8));
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { status: 200, headers: { "content-type": "application/json", "content-length": "60000000" } });
  };

  const cases: Array<[string, () => Response, string]> = [
    ["xml with text/xml", () => new Response('<?xml version="1.0"?><osm></osm>', { status: 200, headers: { "content-type": "text/xml" } }), "fel innehållstyp"],
    ["invalid JSON with a json content-type", () => json("{ not json"), "ogiltig JSON"],
    ["not an object", () => json("[1,2,3]"), "ogiltigt svar"],
    ["elements is not an array", () => json(JSON.stringify({ osm3s: { timestamp_osm_base: OSM_BASE }, elements: "nope" })), "ogiltigt svar"],
    ["a remark saying error", () => json(answer(ways(OVERPASS_LIMITS.minBuildingWays), { remark: "runtime error: Query timed out in \"query\" at line 3 after 181 seconds." })), "Overpass meldade fel"],
    ["an element with lat 95", () => json(answer([...ways(OVERPASS_LIMITS.minBuildingWays), { type: "way", id: 7_000_001, tags: { building: "yes" }, geometry: [{ lat: 95, lon: 18 }] }])), "ogiltigt element"],
    ["an element with lon 181", () => json(answer([...ways(OVERPASS_LIMITS.minBuildingWays), { type: "way", id: 7_000_002, tags: {}, geometry: [{ lat: 59, lon: 181 }] }])), "ogiltigt element"],
    ["a way with 10 001 geometry points", () => json(answer([...ways(OVERPASS_LIMITS.minBuildingWays), { type: "way", id: 7_000_003, tags: {}, geometry: Array.from({ length: OVERPASS_LIMITS.maxPointsPerWay + 1 }, (_, i) => point(i)) }])), "ogiltigt element"],
    ["an element of an unknown type", () => json(answer([...ways(OVERPASS_LIMITS.minBuildingWays), { type: "node", id: 1, lat: 59, lon: 18 }])), "ogiltigt element"],
    ["more elements than allowed", () => json(`{"osm3s":{"timestamp_osm_base":"${OSM_BASE}"},"elements":[${Array.from({ length: OVERPASS_LIMITS.maxElements + 1 }, () => "0").join(",")}]}`), "för många element"],
    ["4 999 building ways", () => json(answer(ways(OVERPASS_LIMITS.minBuildingWays - 1))), "misstänkt tomt svar"],
    ["no OSM time on the buildings answer", () => json(answer(ways(OVERPASS_LIMITS.minBuildingWays), {}, null)), "saknar OSM-tid"],
    ["a declared size of 60 MB", declaredHuge, "för stort svar"],
    ["a streamed body past 50 MB", hugeStream, "för stort svar"],
  ];

  it.each(cases)("rejects %s on every attempt (12 requests, only the first query) and says why", async (_name, bad, label) => {
    streamPulls = 0;
    declaredBodyReads = 0;
    const { fetchImpl, calls } = scriptedFetch(() => bad());
    const { deps: d } = deps(fetchImpl);
    const error = await downloadOsmExtract(d).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain(label);
    expect(calls).toHaveLength(12);
    expect(new Set(calls.map((c) => c.kind))).toEqual(new Set(["buildings"]));
    if (label === "för stort svar" && _name.startsWith("a declared")) expect(declaredBodyReads).toBe(0);
    if (_name.startsWith("a streamed")) expect(streamPulls).toBeLessThanOrEqual(12 * 52);
  });

  it("a relation with 5 001 members is rejected on the relations query and the roads query is never sent", async () => {
    const tooMany = {
      type: "relation",
      id: 5,
      tags: { building: "yes" },
      members: Array.from({ length: OVERPASS_LIMITS.maxMembers + 1 }, (_, i) => ({ type: "way", ref: i + 1, role: "outer" })),
    };
    const { fetchImpl, calls } = scriptedFetch((c) => (c.kind === "relations" ? json(answer([tooMany])) : json(okBodyFor(c.kind))));
    const { deps: d } = deps(fetchImpl);
    await expect(downloadOsmExtract(d)).rejects.toThrow("ogiltigt element");
    expect(calls.filter((c) => c.kind === "buildings")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "relations")).toHaveLength(12);
    expect(calls.filter((c) => c.kind === "roads")).toHaveLength(0);
  });

  it("a roads answer with 999 ways is a suspected empty answer", async () => {
    const { fetchImpl } = scriptedFetch((c) => json(c.kind === "roads" ? roadsBody(OVERPASS_LIMITS.minRoadWays - 1) : okBodyFor(c.kind)));
    const { deps: d } = deps(fetchImpl);
    await expect(downloadOsmExtract(d)).rejects.toThrow("misstänkt tomt svar");
  });

  it("one bad attempt is only a failed attempt: the next endpoint's good answer is used", async () => {
    const { fetchImpl, calls } = scriptedFetch((c, i) => (i === 0 ? json("<html>maintenance</html>") : json(okBodyFor(c.kind))));
    const { deps: d, logs } = deps(fetchImpl);
    const file = await downloadOsmExtract(d);
    expect(file.buildings).toHaveLength(OVERPASS_LIMITS.minBuildingWays);
    expect(hostOf(calls[1].url)).toBe("z.overpass-api.de");
    expect(logs.join("\n")).not.toContain("maintenance");
  });
});

// ---------------------------------------------------------------------------
// The file it returns
// ---------------------------------------------------------------------------

describe("downloadOsmExtract: the file contract", () => {
  it("returns version 1 with attribution, fetchedAt = injected now, osmBase from the buildings answer, the bbox, and only the right element types; the extract parser accepts it", async () => {
    const { fetchImpl } = scriptedFetch((c) => json(okBodyFor(c.kind)));
    const { deps: d, logs } = deps(fetchImpl);
    const file = await downloadOsmExtract(d);
    expect(file.version).toBe(1);
    expect(file.attribution).toBe(OSM_ATTRIBUTION);
    expect(file.fetchedAt).toBe(NOW.toISOString());
    expect(file.osmBase).toBe(OSM_BASE);
    expect(file.bbox).toEqual(OSM_BBOX);
    // the buildings answer also carried 2 relations; they are not buildings-as-ways
    expect(file.buildings).toHaveLength(OVERPASS_LIMITS.minBuildingWays);
    expect(file.buildings.every((e) => e.type === "way")).toBe(true);
    expect(file.relations).toHaveLength(3);
    expect(file.relations.every((e) => e.type === "relation")).toBe(true);
    expect(file.roads).toHaveLength(OVERPASS_LIMITS.minRoadWays);
    expect(file.roads.every((e) => e.type === "way")).toBe(true);
    // the bounds Overpass adds are not stored (nothing reads them; the file stays small)
    expect(JSON.stringify(file)).not.toContain("minlat");
    expect(() => parseOsmExtract(file)).not.toThrow();
    // compact on purpose
    expect(JSON.stringify(file)).not.toMatch(/\n/);
    // log lines: host, status, element count, MB, seconds - and nothing else
    const lines = logs.filter((l) => l.includes("HTTP 200"));
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toMatch(/lz4\.overpass-api\.de HTTP 200, [\d\s]+ element, [\d,]+ MB, [\d,]+ s/);
  });
});

// ---------------------------------------------------------------------------
// Fallback: the 2026-10-13 research downloads
// ---------------------------------------------------------------------------

describe("importResearchExtract", () => {
  const files = (overrides: Partial<Record<string, string>> = {}) => {
    const map: Record<string, string> = {
      "osm-innerstan-buildings.json": buildingsBody(),
      "osm-innerstan-building-relations.json": relationsBody(),
      "osm-innerstan-roads.json": roadsBody(),
      ...overrides,
    };
    return (path: string): string => {
      const name = path.split("/").pop() as string;
      const text = map[name];
      if (text === undefined) throw new Error(`ENOENT ${name}`);
      return text;
    };
  };

  it("builds the same file contract with the research source, fetchedAt = the buildings answer's OSM time and the research bbox", () => {
    const file = importResearchExtract("some/dir", { readText: files() });
    expect(file.version).toBe(1);
    expect(file.source).toBe("research download 2026-10-13");
    expect(file.fetchedAt).toBe(OSM_BASE);
    expect(file.osmBase).toBe(OSM_BASE);
    expect(file.attribution).toBe(OSM_ATTRIBUTION);
    expect(file.bbox).toEqual({ south: 59.3, west: 17.99, north: 59.35, east: 18.12 });
    expect(file.buildings.every((e) => e.type === "way")).toBe(true);
    expect(file.buildings).toHaveLength(OVERPASS_LIMITS.minBuildingWays);
    expect(file.relations).toHaveLength(3);
    expect(file.roads).toHaveLength(OVERPASS_LIMITS.minRoadWays);
    expect(() => parseOsmExtract(file)).not.toThrow();
  });

  it("applies the same validation and minimum counts", () => {
    expect(() => importResearchExtract("d", { readText: files({ "osm-innerstan-roads.json": roadsBody(10) }) })).toThrow("misstänkt tomt svar");
    expect(() => importResearchExtract("d", { readText: files({ "osm-innerstan-building-relations.json": answer([{ type: "way", id: 1, geometry: [{ lat: 95, lon: 1 }] }]) }) })).toThrow("ogiltigt element");
    expect(() => importResearchExtract("d", { readText: files({ "osm-innerstan-buildings.json": "{ broken" }) })).toThrow("ogiltig JSON");
  });

  it("a missing research file is an error that names the file", () => {
    const readText = (path: string): string => {
      if (path.endsWith("osm-innerstan-roads.json")) throw new Error("ENOENT");
      return files()(path);
    };
    expect(() => importResearchExtract("d", { readText })).toThrow("osm-innerstan-roads.json");
  });
});
