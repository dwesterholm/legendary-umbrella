import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAddressMap } from "@/lib/stockholm/bygglov-cache";
import { makeCityClient } from "@/lib/stockholm/bygglov-client";
import { resolveBeteckning, rungSummaryLine, type BeteckningDeps } from "@/lib/stockholm/beteckning";
import { makeFixtureFetch, type FixtureRoute } from "@/lib/stockholm/fixture-fetch";

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
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beteckning-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ADDRESS_PATH = "/Byggochplantjansten/CaseSearch/AddressSearch";
const folkungagatan: FixtureRoute = {
  path: ADDRESS_PATH,
  queryKey: "addressSearchField",
  queryValue: "Folkungagatan 61",
  file: "address-search-folkungagatan-61.fixture.html",
};

function setup(routes: readonly FixtureRoute[]) {
  const clock = fakeClock();
  const fetchImpl = makeFixtureFetch(FIXTURES, routes);
  const logs: string[] = [];
  const client = makeCityClient({
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    log: (l) => logs.push(l),
    gatesPath: join(dir, "host-gates.json"),
    dataDir: dir,
  });
  const deps: BeteckningDeps = { client, cacheDir: dir, now: clock.now, log: (l) => logs.push(l) };
  return { clock, fetchImpl, logs, deps };
}

describe("Folkungagatan 61 -> Droskhästen 8 through the city's address search (tracer)", () => {
  it("resolves on rung b after exactly one request, remembers it, and the next ask makes none", async () => {
    const s = setup([folkungagatan]);

    const first = await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, s.deps);
    expect(first).toMatchObject({ beteckning: "Droskhästen 8", rung: "b", status: "resolved", fromCache: false });
    expect(s.fetchImpl.requests).toHaveLength(1);
    expect(s.fetchImpl.requests[0].url).toContain("addressSearchField=Folkungagatan%2061");

    const saved = loadAddressMap({ dir });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.map["folkungagatan 61"]).toMatchObject({ beteckning: "Droskhästen 8", rung: "b", status: "resolved" });
    }

    const second = await resolveBeteckning({ address: "Folkungagatan  61", brfName: null, text: null }, s.deps);
    expect(second).toMatchObject({ beteckning: "Droskhästen 8", rung: "b", status: "resolved", fromCache: true });
    expect(s.fetchImpl.requests).toHaveLength(1);
  });

  it("prints the summary line for that one result", async () => {
    const s = setup([folkungagatan]);
    const result = await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, s.deps);
    expect(rungSummaryLine([result])).toBe("Fastighetsbeteckning: 1 av 1 hittade (a 0, a2 0, b 1, c 0), okänd 0");
  });

  it("saves only the designation, the rung, the status and a time in the address file", async () => {
    const s = setup([folkungagatan]);
    await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, s.deps);
    const file = JSON.parse(readFileSync(join(dir, "address-beteckning.json"), "utf8")) as {
      entries: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(file.entries["folkungagatan 61"]).sort()).toEqual(["at", "beteckning", "rung", "status"]);
  });
});
