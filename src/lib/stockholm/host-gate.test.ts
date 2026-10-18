import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunLockedError, acquireRunLock } from "@/lib/discovery/watch-state";
import {
  CITY_LOCK_PATH,
  HOST_BLOCK_MS,
  HOST_GATES_PATH,
  assertManualRunAllowed,
  blockHost,
  hostBlockedUntil,
  inWeeklyWindow,
  makeHostPacer,
  readHostGates,
} from "@/lib/stockholm/host-gate";

const HOST = "etjanster.stockholm.se";
const NOW = new Date("2026-10-20T12:00:00.000Z");

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "host-gate-test-"));
  path = join(dir, "host-gates.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("constants", () => {
  it("keeps the files under the gitignored data directory and the block at 24 hours", () => {
    expect(HOST_GATES_PATH).toBe(".planning/calibration/data/host-gates.json");
    expect(CITY_LOCK_PATH).toBe(".planning/calibration/data/bygglov/city.lock");
    expect(HOST_BLOCK_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("blockHost / readHostGates / hostBlockedUntil", () => {
  it("writes a 24 hour block with the label and reads it back", () => {
    const entry = blockHost(path, HOST, "http-403", NOW, { dir });
    expect(entry).toEqual({ blockedUntil: new Date(NOW.getTime() + HOST_BLOCK_MS).toISOString(), reason: "http-403" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ [HOST]: entry });
    expect(readHostGates(path)).toEqual({ [HOST]: entry });
  });

  it("is blocked for 24 hours and free the moment the block has passed", () => {
    blockHost(path, HOST, "http-429", NOW, { dir });
    const gates = readHostGates(path);
    const end = new Date(NOW.getTime() + HOST_BLOCK_MS);
    expect(hostBlockedUntil(gates, HOST, new Date(NOW.getTime() + 10 * 3_600_000))).toEqual(end);
    expect(hostBlockedUntil(gates, HOST, new Date(end.getTime() - 1))).toEqual(end);
    expect(hostBlockedUntil(gates, HOST, end)).toBeNull();
    expect(hostBlockedUntil(gates, "other.example", NOW)).toBeNull();
  });

  it("keeps the blocks of other hosts when one more is written", () => {
    blockHost(path, "a.example", "http-403", NOW, { dir });
    blockHost(path, HOST, "inloggning", NOW, { dir });
    expect(Object.keys(readHostGates(path)).sort()).toEqual(["a.example", HOST]);
  });

  it("a disabled host stays blocked with no end, also long after 24 hours, and a later block keeps the flag", () => {
    blockHost(path, "kartor.example", "user-agent", NOW, { dir, disabled: true });
    const later = new Date(NOW.getTime() + 400 * 86_400_000);
    const until = hostBlockedUntil(readHostGates(path), "kartor.example", later);
    expect(until).not.toBeNull();
    blockHost(path, "kartor.example", "http-403", NOW, { dir });
    expect(readHostGates(path)["kartor.example"].disabled).toBe(true);
  });

  it("refuses a label outside /^[a-z0-9-]{1,40}$/ and writes nothing", () => {
    for (const bad of ["HTTP 403", "", "a".repeat(41), "x/y", "x\ny", "Åker"]) {
      expect(() => blockHost(path, HOST, bad, NOW, { dir }), bad).toThrow(/etikett/);
    }
    expect(readHostGates(path)).toEqual({});
  });

  it("refuses a host that is not a plain host name", () => {
    expect(() => blockHost(path, "https://x/y", "http-403", NOW, { dir })).toThrow(/värd/);
  });

  it("refuses a path outside the data directory", () => {
    expect(() => blockHost(join(dir, "..", "elsewhere.json"), HOST, "http-403", NOW, { dir })).toThrow(/får bara skrivas/);
    expect(() => blockHost(join(dir, "gates.txt"), HOST, "http-403", NOW, { dir })).toThrow(/får bara skrivas/);
  });

  it("a missing file is no block and says nothing", () => {
    const lines: string[] = [];
    expect(readHostGates(path, (l) => lines.push(l))).toEqual({});
    expect(lines).toEqual([]);
  });

  it("a corrupt file is reported in Swedish and counts as no block, and reading never rewrites it", () => {
    writeFileSync(path, "{not json", "utf8");
    const lines: string[] = [];
    expect(readHostGates(path, (l) => lines.push(l))).toEqual({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[stockholm\] .*host-gates\.json.*(ogiltig JSON)/);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  it("a wrong-shaped file is reported as fel format", () => {
    writeFileSync(path, JSON.stringify({ [HOST]: { blockedUntil: "not a date", reason: "http-403" } }), "utf8");
    const lines: string[] = [];
    expect(readHostGates(path, (l) => lines.push(l))).toEqual({});
    expect(lines[0]).toMatch(/fel format/);
  });

  it("blockHost rewrites a corrupt file only after saying so", () => {
    writeFileSync(path, "{not json", "utf8");
    let fileWhenLogged: string | null = null;
    blockHost(path, HOST, "http-403", NOW, {
      dir,
      log: (l) => {
        if (/skrivs om/.test(l)) fileWhenLogged = readFileSync(path, "utf8");
      },
    });
    expect(fileWhenLogged).toBe("{not json");
    expect(readHostGates(path)[HOST].reason).toBe("http-403");
  });
});

describe("makeHostPacer (makeStartGate(3000) per host)", () => {
  function fakeClock() {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => void (t += ms), ms: () => t };
  }

  it("starts the same host at least 3000 ms apart, also when awaited together", async () => {
    const clock = fakeClock();
    const pace = makeHostPacer({ now: clock.now, sleep: clock.sleep });
    const starts: number[] = [];
    await Promise.all([0, 1, 2].map(() => pace(HOST).then(() => starts.push(clock.ms()))));
    expect(starts).toEqual([1_000_000, 1_003_000, 1_006_000]);
  });

  it("never makes one host wait behind another", async () => {
    const clock = fakeClock();
    const pace = makeHostPacer({ now: clock.now, sleep: clock.sleep });
    await pace("a.example");
    await pace("b.example");
    expect(clock.ms()).toBe(1_000_000);
  });
});

describe("inWeeklyWindow / assertManualRunAllowed (R-02: Monday 06:30-09:30 local time)", () => {
  // 2026-10-19 is a Monday (local time, built from parts so the machine's zone does not matter).
  const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m, 0, 0);

  it("pins the weekday the test relies on", () => {
    expect(at(19, 7, 0).getDay()).toBe(1);
  });

  it("Monday 06:29 is outside, 06:30 inside, 09:29 inside, 09:30 outside", () => {
    expect(inWeeklyWindow(at(19, 6, 29))).toBe(false); // 06:29
    expect(inWeeklyWindow(at(19, 6, 30))).toBe(true); // 06:30
    expect(inWeeklyWindow(at(19, 9, 29))).toBe(true); // 09:29
    expect(inWeeklyWindow(at(19, 9, 30))).toBe(false); // 09:30
  });

  it("Sunday 07:00 and Tuesday 07:00 are outside", () => {
    expect(inWeeklyWindow(at(18, 7, 0))).toBe(false);
    expect(inWeeklyWindow(at(20, 7, 0))).toBe(false);
  });

  it("a manual tool may start outside the window and is refused inside it, in Swedish, naming the window", () => {
    expect(() => assertManualRunAllowed(at(19, 9, 30))).not.toThrow();
    expect(() => assertManualRunAllowed(at(19, 7, 0))).toThrow(/måndag.*06:30.*09:30/);
  });
});

describe("the city run lock reuses acquireRunLock", () => {
  it("a second acquire throws while the first run is alive, and works again after release", () => {
    const lockPath = join(dir, "city.lock");
    const first = acquireRunLock(lockPath);
    expect(() => acquireRunLock(lockPath)).toThrow(RunLockedError);
    first.release();
    const again = acquireRunLock(lockPath);
    again.release();
  });
});
