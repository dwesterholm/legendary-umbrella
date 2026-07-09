---
status: testing
phase: 11-gallery-condition-vision
source: [11-VERIFICATION.md, 11-REVIEW.md]
started: 2026-07-07T18:00:00Z
updated: 2026-07-07T18:00:00Z
---

## Current Test

number: 1
name: Gallery-vision accuracy validation gate (KILL CRITERION)
expected: |
  Run evals/vision.eval.ts with RUN_LLM_EVALS=1 on 20–30 real listings with manually-checked ground truth.
  Rubric: directional accuracy ≥70%, citation validity ≥90%, zero hallucination = 100% (hard gate). If accuracy
  is too low to present even as hedged evidence, or per-search vision cost can't stay under CAP_VISION_SEK_MAX=10
  → CUT gallery vision and ship discovery with text ranking only (the UI already degrades to vision:null by construction).
awaiting: user response

## Tests

### 1. Gallery-vision accuracy validation gate (kill criterion)
expected: eval rubric met on 20–30 labeled real listings; else CUT vision, ship text-only.
result: [pending]

### 2. Booli images( ref probe + image-host allowlist confirmation
expected: run scripts/probe-booli-images.ts (operator-approved Apify spend) to confirm the Apollo `images(` ref shape AND the real Booli image CDN host. NOTE: the unverified `.bcdn.se` host was REMOVED from the SSRF allowlist during review (fail-closed) — until the operator confirms and re-adds the correct Booli image host, extractImageUrls will yield no allowed images → vision degrades to visionSkippedReason="no_images". Confirm + re-add the verified host.
result: [pending]

### 3. Live vision render + one structured-output API smoke
expected: with DISCOVERY_ENABLED=true + a confirmed image host, run a real candidate through the two-pass pipeline; confirm the "AI-bedömning av bilder — kan vara fel" section renders hedged, image-cited claims, visually distinct from deterministic flags, no PII references, and the incremental CAP_VISION_SEK_MAX cap holds. Also serves as the one live output_config.format smoke.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
