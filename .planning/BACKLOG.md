# Backlog

Ideas parked by Daniel. Not roadmapped; nothing here is scheduled.

## Stambyte event study (parked 2026-10-23)

**What:** measure the price effect BEFORE and after a stambyte properly: for the 1 446 innerstan buildings with a dated stambyte case (Phase 14.6 sweep, `.planning/calibration/data/bygglov/`), pull each building's full Booli sale history (back to ≈ 2008), then compare sales 1–3 years before the case start with sales after and with buildings that had none, within the same building (event study; building fixed effects cancel).

**Why parked:** needs ≈ 1 500–3 000 Booli page loads. Booli blocked bulk detail reads from the Mac twice (2026-10-17/18), so it would run on Apify's residential proxy at ≈ 0,05 USD/page = 75–150 USD one-off. Daniel: "Put it on the backlog for now."

**Needs:** a district-by-year price index over the pulled span (the model's `monthsAgo` only covers the current 18-month window); the 14.6 join (`sold-join.ts`) extended to the historic rows; cached, resumable puller (pattern: `scripts/pull-slutpriser.ts`).

**Can answer:** the discount in the years before a reported stambyte, the premium after, how long it lasts. **Cannot see:** unreported stambyten; the "planned but not yet reported" stage without the annual report.

**Related:** 14.6 evidence `stambyte-fit.md` (effects on the current window: +2,4 % within 10 y, SE 1,3; t 0,9 → not in the model, R-08).
