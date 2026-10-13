import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RunLockedError,
  WATCH_FIRST_MAIL_PER_SECTION,
  WATCH_PRUNE_DAYS,
  WATCH_STATE_PATH,
  acquireRunLock,
  diffRun,
  emptyWatchState,
  fingerprintOf,
  isFirstRun,
  listingKey,
  loadWatchState,
  lockPathOf,
  peekWatchState,
  pruneStale,
  readRunLock,
  saveWatchState,
  watchStateSchema,
  type WatchRow,
  type WatchState,
} from "./watch-state";

function row(over: Partial<WatchRow> = {}): WatchRow {
  return {
    link: "https://www.booli.se/bostad/150148",
    address: "Götgatan 1",
    district: "Södermalm",
    kvm: 40,
    askingKr: 3_995_000,
    ...over,
  };
}

const THREE = [
  row({ link: "https://www.booli.se/bostad/1", address: "Götgatan 1" }),
  row({ link: "https://www.booli.se/bostad/2", address: "Folkungagatan 2", askingKr: 3_500_000 }),
  row({ link: "https://www.booli.se/annons/3", address: "Hornsgatan 3", askingKr: null }),
];

describe("constants", () => {
  it("are the plan's values", () => {
    expect(WATCH_PRUNE_DAYS).toBe(90);
    expect(WATCH_FIRST_MAIL_PER_SECTION).toBe(15);
    expect(WATCH_STATE_PATH).toBe(".planning/calibration/data/watch-state.json");
  });
});

describe("listingKey and fingerprintOf", () => {
  it("keys on the listing path of either URL form", () => {
    expect(listingKey(row({ link: "https://www.booli.se/bostad/150148" }))).toBe("/bostad/150148");
    expect(listingKey(row({ link: "https://www.booli.se/annons/6305391?ref=x" }))).toBe("/annons/6305391");
  });

  it("falls back to the fingerprint when there is no listing URL", () => {
    expect(listingKey(row({ link: "-" }))).toBe(`fp:${fingerprintOf(row())}`);
    expect(listingKey(row({ link: "https://www.booli.se/sok/slutpriser" }))).toBe(`fp:${fingerprintOf(row())}`);
  });

  it("normalises Unicode, case and spacing", () => {
    const decomposed = "Södermalm"; // o + combining diaeresis
    expect(decomposed).not.toBe("Södermalm");
    expect(fingerprintOf(row({ district: decomposed }))).toBe(fingerprintOf(row({ district: "Södermalm" })));
    expect(fingerprintOf(row({ address: "  GÖTGATAN   1 " }))).toBe(fingerprintOf(row({ address: "Götgatan 1" })));
    expect(fingerprintOf(row())).toBe("götgatan 1|södermalm|40");
    expect(fingerprintOf(row({ kvm: null }))).toBe("götgatan 1|södermalm|-");
  });
});

describe("diffRun", () => {
  it("an empty memory makes every row new with first and last seen set to today", () => {
    const d = diffRun(emptyWatchState(), THREE, "2026-10-20");
    expect(d.newRows).toHaveLength(3);
    expect(d.changedRows).toEqual([]);
    expect(d.unchanged).toEqual([]);
    expect(d.next.updatedAt).toBe("2026-10-20");
    expect(d.next.listings["/bostad/1"]).toEqual({
      firstSeen: "2026-10-20",
      lastSeen: "2026-10-20",
      lastAskingSek: 3_995_000,
      fingerprint: fingerprintOf(THREE[0]),
      priceHistory: [{ date: "2026-10-20", askingSek: 3_995_000 }],
    });
    // A listing with no price has an empty history, not a fake 0.
    expect(d.next.listings["/annons/3"].priceHistory).toEqual([]);
    expect(d.next.listings["/annons/3"].lastAskingSek).toBeNull();
  });

  it("the same rows with the same prices on the same day: nothing new, nothing changed, state unchanged but updatedAt", () => {
    const first = diffRun(emptyWatchState(), THREE, "2026-10-20");
    const second = diffRun(first.next, THREE, "2026-10-20");
    expect(second.newRows).toEqual([]);
    expect(second.changedRows).toEqual([]);
    expect(second.unchanged).toHaveLength(3);
    expect(second.next.listings).toEqual(first.next.listings);
  });

  it("firstSeen is never rewritten on a later day", () => {
    const first = diffRun(emptyWatchState(), THREE, "2026-10-20");
    const later = diffRun(first.next, THREE, "2026-10-27");
    expect(later.next.listings["/bostad/1"].firstSeen).toBe("2026-10-20");
    expect(later.next.listings["/bostad/1"].lastSeen).toBe("2026-10-27");
    expect(later.newRows).toEqual([]);
  });

  it("a price drop is changed, with old and new price, and the history grows", () => {
    const first = diffRun(emptyWatchState(), [THREE[0]], "2026-10-20");
    const d = diffRun(first.next, [row({ link: THREE[0].link, askingKr: 3_795_000 })], "2026-10-27");
    expect(d.changedRows).toHaveLength(1);
    expect(d.changedRows[0]).toMatchObject({ oldSek: 3_995_000, newSek: 3_795_000 });
    expect(d.newRows).toEqual([]);
    expect(d.next.listings["/bostad/1"].priceHistory).toEqual([
      { date: "2026-10-20", askingSek: 3_995_000 },
      { date: "2026-10-27", askingSek: 3_795_000 },
    ]);
    expect(d.next.listings["/bostad/1"].lastAskingSek).toBe(3_795_000);
  });

  it("a 1 kr rise is changed; a 0 kr difference is unchanged", () => {
    const first = diffRun(emptyWatchState(), [THREE[0]], "2026-10-20");
    const up = diffRun(first.next, [row({ link: THREE[0].link, askingKr: 3_995_001 })], "2026-10-27");
    expect(up.changedRows).toHaveLength(1);
    const same = diffRun(first.next, [row({ link: THREE[0].link, askingKr: 3_995_000 })], "2026-10-27");
    expect(same.changedRows).toEqual([]);
    expect(same.unchanged).toHaveLength(1);
  });

  it("a missing price on either side is never a change", () => {
    const first = diffRun(emptyWatchState(), THREE, "2026-10-20");
    // Stored null, now priced.
    const nowPriced = diffRun(first.next, [row({ link: THREE[2].link, address: "Hornsgatan 3", askingKr: 3_000_000 })], "2026-10-27");
    expect(nowPriced.changedRows).toEqual([]);
    expect(nowPriced.next.listings["/annons/3"].lastAskingSek).toBe(3_000_000);
    // Stored priced, now null: the old price is kept.
    const nowNull = diffRun(first.next, [row({ link: THREE[0].link, askingKr: null })], "2026-10-27");
    expect(nowNull.changedRows).toEqual([]);
    expect(nowNull.next.listings["/bostad/1"].lastAskingSek).toBe(3_995_000);
  });

  it("a flat that switches URL form is not new and is re-keyed to the new path", () => {
    const old = row({ link: "https://www.booli.se/annons/6305391" });
    const first = diffRun(emptyWatchState(), [old], "2026-10-20");
    const d = diffRun(first.next, [row({ link: "https://www.booli.se/bostad/150148" })], "2026-10-27");
    expect(d.newRows).toEqual([]);
    expect(d.unchanged).toHaveLength(1);
    expect(Object.keys(d.next.listings)).toEqual(["/bostad/150148"]);
    expect(d.next.listings["/bostad/150148"].firstSeen).toBe("2026-10-20");
  });

  it("decomposed 'Söder' matches the precomposed fingerprint", () => {
    const first = diffRun(emptyWatchState(), [row({ link: "https://www.booli.se/annons/9" })], "2026-10-20");
    const d = diffRun(first.next, [row({ link: "https://www.booli.se/bostad/9", district: "Södermalm" })], "2026-10-27");
    expect(d.newRows).toEqual([]);
  });

  it("the same listing twice in one run, by path or by fingerprint, is counted once", () => {
    const dup = diffRun(emptyWatchState(), [THREE[0], { ...THREE[0] }], "2026-10-20");
    expect(dup.newRows).toHaveLength(1);
    const twoForms = diffRun(
      emptyWatchState(),
      [row({ link: "https://www.booli.se/annons/6305391" }), row({ link: "https://www.booli.se/bostad/150148" })],
      "2026-10-20",
    );
    expect(twoForms.newRows).toHaveLength(1);
    expect(Object.keys(twoForms.next.listings)).toHaveLength(1);
  });

  it("does not mutate the input state", () => {
    const first = diffRun(emptyWatchState(), THREE, "2026-10-20");
    const snapshot = JSON.stringify(first.next);
    diffRun(first.next, [row({ link: THREE[0].link, askingKr: 1 })], "2026-10-27");
    expect(JSON.stringify(first.next)).toBe(snapshot);
  });

  it("listings missing from a run keep their entry", () => {
    const first = diffRun(emptyWatchState(), THREE, "2026-10-20");
    const d = diffRun(first.next, [THREE[0]], "2026-10-27");
    expect(Object.keys(d.next.listings).sort()).toEqual(["/annons/3", "/bostad/1", "/bostad/2"]);
    expect(d.next.listings["/bostad/2"].lastSeen).toBe("2026-10-20");
  });
});

describe("pruneStale", () => {
  const entry = (lastSeen: string) => ({
    firstSeen: lastSeen,
    lastSeen,
    lastAskingSek: 1,
    fingerprint: "x",
    priceHistory: [],
  });
  const state: WatchState = {
    version: 1,
    updatedAt: null,
    listings: { "/bostad/90": entry("2026-07-22"), "/bostad/91": entry("2026-07-21"), "/bostad/0": entry("2026-10-20") },
  };

  it("keeps 90 days and prunes 91", () => {
    const pruned = pruneStale(state, "2026-10-20", WATCH_PRUNE_DAYS);
    expect(Object.keys(pruned.listings).sort()).toEqual(["/bostad/0", "/bostad/90"]);
  });

  it("defaults to WATCH_PRUNE_DAYS", () => {
    expect(Object.keys(pruneStale(state, "2026-10-20").listings).sort()).toEqual(["/bostad/0", "/bostad/90"]);
  });
});

describe("isFirstRun", () => {
  it("is true for an empty memory and false after one run", () => {
    expect(isFirstRun(emptyWatchState())).toBe(true);
    expect(isFirstRun(diffRun(emptyWatchState(), THREE, "2026-10-20").next)).toBe(false);
  });
});

describe("load and save", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watch-state-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a missing file is an empty memory with no warning", () => {
    const r = loadWatchState(join(dir, "watch-state.json"));
    expect(r.warning).toBeNull();
    expect(isFirstRun(r.state)).toBe(true);
  });

  it("saves atomically and loads back the same state", () => {
    const state = diffRun(emptyWatchState(), THREE, "2026-10-20").next;
    const path = join(dir, "watch-state.json");
    saveWatchState(path, state, { dir });
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(watchStateSchema.parse(JSON.parse(readFileSync(path, "utf8")))).toEqual(state);
    expect(loadWatchState(path)).toEqual({ state, warning: null });
  });

  it("invalid JSON reads as empty, warns in Swedish and moves the file aside", () => {
    const path = join(dir, "watch-state.json");
    writeFileSync(path, "{ not json", "utf8");
    const r = loadWatchState(path, { now: () => Date.UTC(2026, 9, 20, 6, 0, 0) });
    expect(isFirstRun(r.state)).toBe(true);
    expect(r.warning).toContain("kunde inte läsas");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.startsWith("watch-state.json.bak-"))).toHaveLength(1);
  });

  it("valid JSON of the wrong shape is handled the same way", () => {
    const path = join(dir, "watch-state.json");
    writeFileSync(path, JSON.stringify({ version: 2, listings: [] }), "utf8");
    const r = loadWatchState(path);
    expect(r.warning).not.toBeNull();
    expect(isFirstRun(r.state)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("peekWatchState reads without touching anything, even a corrupt file", () => {
    const path = join(dir, "watch-state.json");
    expect(peekWatchState(path)).toEqual({ kind: "missing" });
    saveWatchState(path, diffRun(emptyWatchState(), THREE, "2026-10-20").next, { dir });
    expect(peekWatchState(path)).toEqual({ kind: "ok", listings: 3, lastSeen: "2026-10-20" });
    writeFileSync(path, "{ nope", "utf8");
    expect(peekWatchState(path)).toEqual({ kind: "corrupt" });
    expect(readFileSync(path, "utf8")).toBe("{ nope"); // not renamed, not rewritten
    expect(readdirSync(dir)).toEqual(["watch-state.json"]);
  });

  it("refuses to save outside the data directory", () => {
    expect(() => saveWatchState(join(dir, "watch-state.json"), emptyWatchState())).toThrow(/bara skrivas under/);
    expect(() => saveWatchState(join(dir, "watch-state.txt"), emptyWatchState(), { dir })).toThrow();
  });
});

describe("run lock", () => {
  let dir: string;
  let lockPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watch-lock-test-"));
    lockPath = join(dir, "watch-state.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lockPathOf puts watch-state.lock next to the state file", () => {
    expect(lockPathOf(".planning/calibration/data/watch-state.json")).toBe(".planning/calibration/data/watch-state.lock");
    expect(lockPathOf("/x/y/custom.json")).toBe("/x/y/custom.lock");
  });

  it("creates the lock with pid and start time, and release removes it", () => {
    const lock = acquireRunLock(lockPath, { pid: 4242, now: () => new Date("2026-10-20T06:00:00Z") });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({ pid: 4242, startedAt: "2026-10-20T06:00:00.000Z" });
    expect(lock.warning).toBeNull();
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("release twice is harmless, even after another run took the file", () => {
    const lock = acquireRunLock(lockPath, { pid: 1 });
    lock.release();
    writeFileSync(lockPath, JSON.stringify({ pid: 2, startedAt: "x" }), "utf8");
    lock.release(); // second call must not remove somebody else's lock
    expect(existsSync(lockPath)).toBe(true);
  });

  it("a lock held by a live pid throws RunLockedError carrying that pid and start time", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 777, startedAt: "2026-10-20T05:00:00Z" }), "utf8");
    let caught: unknown;
    try {
      acquireRunLock(lockPath, { pid: 1, isAlive: (p) => p === 777 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RunLockedError);
    expect((caught as RunLockedError).pid).toBe(777);
    expect((caught as RunLockedError).startedAt).toBe("2026-10-20T05:00:00Z");
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(777); // untouched
  });

  it("a lock with a dead pid is taken over with a warning", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 555, startedAt: "2026-10-13T00:00:00Z" }), "utf8");
    const lock = acquireRunLock(lockPath, { pid: 9, isAlive: () => false });
    expect(lock.warning).toContain("555");
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(9);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("an unreadable lock file is taken over with a warning", () => {
    writeFileSync(lockPath, "garbage", "utf8");
    const lock = acquireRunLock(lockPath, { pid: 9, isAlive: () => true });
    expect(lock.warning).toContain("oläslig");
    lock.release();
  });

  it("a real lock held by this very process is seen as live with the default liveness check", () => {
    const lock = acquireRunLock(lockPath);
    expect(() => acquireRunLock(lockPath)).toThrow(RunLockedError);
    lock.release();
  });

  it("readRunLock reports the holder without taking the lock", () => {
    expect(readRunLock(lockPath)).toBeNull();
    writeFileSync(lockPath, JSON.stringify({ pid: 31, startedAt: "2026-10-20T05:00:00Z" }), "utf8");
    expect(readRunLock(lockPath, { isAlive: () => true })).toEqual({ pid: 31, startedAt: "2026-10-20T05:00:00Z", alive: true });
    expect(readRunLock(lockPath, { isAlive: () => false })?.alive).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });
});
