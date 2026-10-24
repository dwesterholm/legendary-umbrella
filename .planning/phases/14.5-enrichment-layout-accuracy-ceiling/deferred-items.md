# Deferred items (phase 14.5)

- **Plan 14.5-07, found 2026-10-24:** `src/lib/discovery/watch-state.test.ts` "run lock > readRunLock reports the holder without taking the lock" fails (expected `alive: true`, received `false`). The test writes a lock dated 2026-10-20 and the code appears to treat it as stale once the date is old enough, so it looks date-dependent. Not touched by plan 07 (only layout-accuracy.ts and its test changed). Left as is.
