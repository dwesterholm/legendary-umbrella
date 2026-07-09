/**
 * `TICK_DISCOVERY_MAX_DURATION_SEC` — documents the max-duration ceiling for
 * `tickDiscovery` (09-RESEARCH.md Pitfall 2: `runPlaywrightRender` has up to
 * a 240s wait ceiling per rung, and `fetchAreaListings` may attempt two
 * rungs). This value matches the Vercel platform DEFAULT function duration
 * on BOTH Hobby and Pro already (09-RESEARCH.md line 447) — declared here
 * (rather than as an `export const maxDuration` inside the `"use server"`
 * action file) because Next.js's Server Actions bundler only permits ASYNC
 * FUNCTION exports from a `"use server"` file; `maxDuration` is a Route
 * Handler/Page special export, not a Server Action one, and a plain
 * constant export there fails the production build ("Only async functions
 * are allowed to be exported in a 'use server' file" — a real compiler
 * constraint invisible to vitest's mocked unit tests, only surfaced by
 * `npm run build`).
 */
export const TICK_DISCOVERY_MAX_DURATION_SEC = 300;
