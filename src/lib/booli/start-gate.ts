/**
 * A floor on the time between two page starts (Phase 14.5, R-07).
 *
 * The enrichment restart reads Booli pages one at a time, and this gate makes sure that two consecutive page starts
 * are at least `gapMs` apart. The local browser keeps its own 1-2 s pacing on top of this. Pure: imports nothing from
 * the Booli client, so the unit test runs on a fake clock.
 *
 * Callers await the returned function right before a page render. Callers that arrive while another is waiting queue
 * behind it, also when they are awaited concurrently, so the floor holds for any concurrency.
 */
export const START_GAP_MIN_MS = 1000;
export const START_GAP_MAX_MS = 60_000;

export interface StartGateDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function makeStartGate(gapMs: number, deps: StartGateDeps = {}): () => Promise<void> {
  if (!Number.isInteger(gapMs) || gapMs < START_GAP_MIN_MS || gapMs > START_GAP_MAX_MS) {
    throw new RangeError(
      `Avståndet mellan sidstarter måste vara ett helt antal millisekunder mellan ${START_GAP_MIN_MS} och ${START_GAP_MAX_MS} (fick ${gapMs})`,
    );
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastStart: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  return () => {
    const turn = chain.then(async () => {
      if (lastStart !== null) {
        const wait = lastStart + gapMs - now();
        if (wait > 0) await sleep(wait);
      }
      lastStart = now();
    });
    // A failed turn must not block the callers behind it.
    chain = turn.catch(() => undefined);
    return turn;
  };
}
