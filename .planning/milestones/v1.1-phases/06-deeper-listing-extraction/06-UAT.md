---
status: testing
phase: 06-deeper-listing-extraction
source: [06-VERIFICATION.md]
started: 2026-07-06T19:10:00Z
updated: 2026-07-06T19:10:00Z
---

## Current Test

number: 1
name: Live broker-CMS coverage + degradation + PII sample
expected: |
  Paste 3-5 real, currently-active Booli listing URLs into the running app with a real APIFY_API_TOKEN.
  Våning/Balkong/BRF populate from Booli with "Källa: Booli". Renoveringsstatus/Beskrivning either
  populate with "Källa: Mäklarens annons" or show "Ej tillgänglig". No mäklare name/phone/email appears
  anywhere in the rendered report. A broker-page failure shows the soft terracotta banner while the rest
  of the analysis renders exactly as before. Server logs show `[broker]` lines on any fetch failure,
  never a silent failure or thrown error surfacing to the user.
awaiting: user response

## Tests

### 1. Live broker-CMS coverage + degradation + PII sample
expected: Paste 3-5 real active Booli listings with a real APIFY_API_TOKEN. Booli-sourced fields show "Källa: Booli"; broker-sourced show "Källa: Mäklarens annons" or "Ej tillgänglig". No mäklare PII anywhere. Broker failure → soft terracotta banner, rest of analysis unaffected. `[broker]` logs on failure, never silent/thrown.
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
