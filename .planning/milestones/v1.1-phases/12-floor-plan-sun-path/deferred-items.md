# Deferred Items — Phase 12

Out-of-scope discoveries logged during execution, NOT auto-fixed (Scope Boundary rule: only auto-fix issues directly caused by the current task's changes).

## 12-02

- **`evals/vision.eval.ts:147` — `prefer-const` eslint error on `cases`.** Confirmed PRE-EXISTING (present before any 12-02 change, verified via `git stash`). Not caused by the `remodelPotential` leaf/claims-mapping/prompt changes in this plan. Left unfixed per Scope Boundary rule.
