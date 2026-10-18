import { describe, expect, it } from "vitest";
import { START_GAP_MAX_MS, START_GAP_MIN_MS, makeStartGate } from "./start-gate";

/** A fake clock: sleep(ms) advances it, so the test never waits in real time. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("makeStartGate (R-07: a floor on the time between two page starts)", () => {
  it("queues three calls made at the same moment: they resolve at 0, 2000 and 4000 ms", async () => {
    const clock = fakeClock();
    const gate = makeStartGate(2000, { now: clock.now, sleep: clock.sleep });
    const times: number[] = [];
    await Promise.all([0, 1, 2].map(() => gate().then(() => times.push(clock.now()))));
    expect(times).toEqual([0, 2000, 4000]);
  });

  it("queues sequentially awaited calls the same way", async () => {
    const clock = fakeClock(5000);
    const gate = makeStartGate(2000, { now: clock.now, sleep: clock.sleep });
    const times: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await gate();
      times.push(clock.now());
    }
    expect(times).toEqual([5000, 7000, 9000]);
  });

  it("lets a call through at once when the last start was 10 s ago", async () => {
    const clock = fakeClock();
    const gate = makeStartGate(2000, { now: clock.now, sleep: clock.sleep });
    await gate();
    clock.advance(10_000);
    await gate();
    expect(clock.now()).toBe(10_000);
  });

  it("waits the missing 1 500 ms when the last start was 500 ms ago", async () => {
    const clock = fakeClock();
    const gate = makeStartGate(2000, { now: clock.now, sleep: clock.sleep });
    await gate();
    clock.advance(500);
    await gate();
    expect(clock.now()).toBe(2000);
  });

  it("keeps the floor when the sleeping call fails", async () => {
    const clock = fakeClock();
    let calls = 0;
    const gate = makeStartGate(2000, {
      now: clock.now,
      sleep: async (ms) => {
        calls += 1;
        if (calls === 1) throw new Error("sleep failed");
        clock.advance(ms);
      },
    });
    await gate();
    await expect(gate()).rejects.toThrow("sleep failed");
    await gate();
    expect(calls).toBe(2);
  });

  it("rejects a gap that is not a whole number of milliseconds from 1 000 to 60 000", () => {
    expect(START_GAP_MIN_MS).toBe(1000);
    expect(START_GAP_MAX_MS).toBe(60_000);
    for (const bad of [0, 999, 60_001, 1500.5, Number.NaN, Number.POSITIVE_INFINITY, -2000]) {
      expect(() => makeStartGate(bad)).toThrow(RangeError);
    }
    expect(() => makeStartGate(START_GAP_MIN_MS)).not.toThrow();
    expect(() => makeStartGate(START_GAP_MAX_MS)).not.toThrow();
  });
});
