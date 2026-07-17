import { vi } from "vitest";

/**
 * Shared `apify-client` mock factory (Phase 5 Wave 0 gap — 05-RESEARCH.md).
 *
 * No test in the repo mocks `ApifyClient`'s `.actor().call()` /
 * `.dataset().listItems()` chain today (`sold-source.test.ts` only exercises
 * the pure `resolveAreaId()` helper). This module is the ONE canonical mock
 * shape every future `booli/` test (`client.test.ts`, `fallback-tree.test.ts`,
 * `transport.test.ts`, ...) should import instead of hand-rolling its own fake
 * — per 05-PATTERNS.md "Recommended net-new mock shape for apify-client".
 *
 * Usage in a test file:
 *
 *   import { actorCall, listItems, resetApifyMock, apifyClientMockFactory }
 *     from "@/lib/booli/__mocks__/apify-client";
 *
 *   vi.mock("apify-client", () => apifyClientMockFactory());
 *
 *   beforeEach(() => {
 *     resetApifyMock();
 *     actorCall.mockResolvedValue({ status: "SUCCEEDED", defaultDatasetId: "x" });
 *     listItems.mockResolvedValue({ items: [{ hasApollo: true, __APOLLO_STATE__: {} }] });
 *   });
 *
 * This is a test-support module under `__mocks__/` — it produces no
 * production behavior, reads no env vars, and must never be imported by
 * non-test code (T-05-01: information-disclosure mitigation — the mock
 * never touches `process.env.APIFY_API_TOKEN` and never logs anything).
 */

/** Spy standing in for `client.actor(actorId).call(input, opts)`. */
export const actorCall = vi.fn();

/** Spy standing in for `client.dataset(datasetId).listItems()`. */
export const listItems = vi.fn();

/**
 * Resets both spies (call history AND any configured mock implementation /
 * resolved value). Call from `beforeEach` so tests don't leak state into
 * each other.
 */
export function resetApifyMock(): void {
  actorCall.mockReset();
  listItems.mockReset();
}

/**
 * `vi.mock("apify-client", () => apifyClientMockFactory())` factory. Models the full
 * chain used by `booli-scraper.ts` / `sold-source.ts`:
 *   new ApifyClient({ token }) -> .actor(anyId).call(...) -> actorCall's value
 *                              -> .dataset(anyId).listItems() -> listItems's value
 * Any actor/dataset id is accepted — the mock is shape-only and does not
 * assert on which id was passed (that assertion belongs in the consuming
 * test, e.g. via `expect(actorCall).toHaveBeenCalledWith(...)`).
 */
export function apifyClientMockFactory() {
  return {
    // `new ApifyClient(...)` is called with `new` at every production call
    // site (transport.ts, sold-source.ts, booli-scraper.ts) — an arrow
    // function passed to `mockImplementation` cannot be invoked with `new`
    // ("X is not a constructor"). A `function` mock implementation can be.
    ApifyClient: vi.fn().mockImplementation(function () {
      return {
        actor: () => ({ call: actorCall }),
        // The dataset id is threaded to `listItems` as its first arg so a test
        // can key returned data by dataset id — necessary for PARALLEL renders,
        // where await order is non-deterministic and call-order mocks
        // (mockResolvedValueOnce) race. Back-compat: `.listItems()` in prod
        // takes no args, and `listItems.mockResolvedValue(...)` ignores args.
        dataset: (id: string) => ({ listItems: (...args: unknown[]) => listItems(id, ...args) }),
      };
    }),
  };
}
