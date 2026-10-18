import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshCaseListIfStale } from "@/lib/stockholm/bygglov-cache";
import { CITY_HOST, CITY_LIMITS, CITY_USER_AGENT, makeCityClient } from "@/lib/stockholm/bygglov-client";
import { makeFixtureFetch } from "@/lib/stockholm/fixture-fetch";

const FIXTURES = join(__dirname, "__fixtures__");

/** A fake clock: sleep(ms) advances it, so no test waits in real time. */
function fakeClock(startIso = "2026-10-20T12:00:00.000Z") {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    ms: () => t,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bygglov-client-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LIST_ROUTE = { path: "/byggochplantjansten/arendeochhandlingar", queryKey: "RealEstateName", file: "list-droskhasten-8.fixture.html" };

describe("Droskhästen 8: one gated GET from a fake server, parsed, classified and cached (tracer)", () => {
  it("makes exactly one request, saves the case list and returns 53 stored build cases", async () => {
    const clock = fakeClock();
    const fetchImpl = makeFixtureFetch(FIXTURES, [LIST_ROUTE]);
    const logs: string[] = [];
    const client = makeCityClient({ fetchImpl, sleep: clock.sleep, now: clock.now, log: (l) => logs.push(l), gatesPath: join(dir, "host-gates.json"), dataDir: dir });

    const result = await refreshCaseListIfStale("Droskhästen 8", { dir, now: clock.now, client });

    expect(fetchImpl.requests).toHaveLength(1);
    expect(result.source).toBe("city");
    expect(result.cases).toHaveLength(53);
    expect(result.termsLinks).toEqual([]);

    const request = fetchImpl.requests[0];
    expect(request.url).toBe(
      "https://etjanster.stockholm.se/byggochplantjansten/arendeochhandlingar?ExtendedAddress=false&RealEstateName=Droskh%C3%A4sten%208",
    );
    expect(request.method).toBe("GET");
    expect(request.headers["user-agent"]).toBe(CITY_USER_AGENT);
    expect(request.headers.accept).toBe("text/html");
    expect(Object.keys(request.headers).some((k) => k.toLowerCase() === "cookie")).toBe(false);
    expect(request.redirect).toBe("error");
    expect(new URL(request.url).host).toBe(CITY_HOST);
    expect(CITY_LIMITS.maxBytes).toBe(5 * 1024 * 1024);
  });

  it("answers a second ask within 30 days from the cache with zero requests and the same 53 cases", async () => {
    const clock = fakeClock();
    const fetchImpl = makeFixtureFetch(FIXTURES, [LIST_ROUTE]);
    const client = makeCityClient({ fetchImpl, sleep: clock.sleep, now: clock.now, log: () => undefined, gatesPath: join(dir, "host-gates.json"), dataDir: dir });

    const first = await refreshCaseListIfStale("Droskhästen 8", { dir, now: clock.now, client });
    clock.advance(10 * 86_400_000);
    const second = await refreshCaseListIfStale("Droskhästen 8", { dir, now: clock.now, client });

    expect(fetchImpl.requests).toHaveLength(1);
    expect(second.source).toBe("cache");
    expect(second.cases).toHaveLength(53);
    expect(second.cases).toEqual(first.cases);
  });

  it("saves tags, digits and dates only: no Description, Handler or Documents key in the file", async () => {
    const clock = fakeClock();
    const fetchImpl = makeFixtureFetch(FIXTURES, [LIST_ROUTE]);
    const client = makeCityClient({ fetchImpl, sleep: clock.sleep, now: clock.now, log: () => undefined, gatesPath: join(dir, "host-gates.json"), dataDir: dir });
    await refreshCaseListIfStale("Droskhästen 8", { dir, now: clock.now, client });

    const text = readFileSync(join(dir, "cases", "droskhasten-8.json"), "utf8");
    expect(text).not.toMatch(/"(Description|Handler|Documents)"/);
    const file = JSON.parse(text) as { cases: unknown[]; beteckning: string; rulesVersion: number };
    expect(file.beteckning).toBe("Droskhästen 8");
    expect(file.cases).toHaveLength(53);
  });

  it("starts two back-to-back case-list calls at least 3000 ms apart on the fake clock", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const inner = makeFixtureFetch(FIXTURES, [LIST_ROUTE]);
    const fetchImpl = Object.assign(
      async (url: string, init?: RequestInit) => {
        starts.push(clock.ms());
        return inner(url, init);
      },
      { requests: inner.requests },
    );
    const client = makeCityClient({ fetchImpl, sleep: clock.sleep, now: clock.now, log: () => undefined, gatesPath: join(dir, "host-gates.json"), dataDir: dir });

    await client.caseList("Droskhästen 8");
    await client.caseList("Droskhästen 8");
    await client.caseList("Droskhästen 8");

    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(3000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(3000);
  });
});
