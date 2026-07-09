/**
 * vision-prompt.ts — Phase 11 (DISC-04) system prompts for the two-pass
 * gallery-condition vision pipeline: `VISION_PREFILTER_SYSTEM_PROMPT` (Haiku
 * triage) and `VISION_DEEPPASS_SYSTEM_PROMPT` (Sonnet citation pass).
 *
 * BOTH prompts include the SAME explicit PII/people-ignore instruction
 * verbatim (11-RESEARCH.md "Caching Per booliId + PII-Ignore Prompt Design"),
 * enforced structurally as well as by prompt text: `conditionAttribute`
 * (vision-schema.ts) has no field capable of naming or describing a person —
 * `whatWasSeen`'s `.describe()` text steers explicitly toward physical
 * fixtures/finishes, mirroring `reportSchema`'s "no verdict field" trick
 * (D-04/FM2) applied to PII instead of verdicts.
 *
 * The deep-pass prompt additionally locks the hedged-language contract
 * (verbs "verkar"/"ser ut att"/"tyder på", never "är"/a verdict; a banned-word
 * list) — the same "cite the source, hedge the language, omit rather than
 * fabricate" discipline as `flags.ts`'s `SoftSignalField<T>`, applied to an
 * image index instead of a page ref.
 *
 * Phase 12 (DISC-05) adds a FOURTH deep-pass instruction paragraph for
 * `remodelPotential` — the floor plan's remodel-investigation-PROMPT, never
 * a load-bearing/wall-removal VERDICT. This is the highest-liability output
 * in the whole vision pipeline: the prompt bans stating a wall's bärande/
 * icke-bärande status as fact and mandates the model end every such claim
 * with "kräver konstruktör / väggutredning". The disclaimer is ALSO
 * enforced in code after parsing (vision.ts) — belt-and-suspenders, a
 * liability-bearing sentence must never depend solely on model compliance.
 */

/** The explicit PII/people-ignore instruction — verbatim in BOTH prompts. */
const PII_IGNORE_INSTRUCTION =
  "Ignorera helt eventuella människor eller personliga dokument (post, fakturor, ID-handlingar, foton av personer) som syns i bilderna. Kommentera ALDRIG på personer eller identifierbar information i bilderna — fokusera uteslutande på rummets skick (kök, badrum, allmänt skick).";

/**
 * Haiku pre-filter (triage) — a cheap, high-recall gate deciding whether a
 * candidate's image set is worth the more expensive Sonnet deep pass
 * (RESEARCH.md Pattern 1). Slim boolean output only — no citation work here.
 */
export const VISION_PREFILTER_SYSTEM_PROMPT = `Du är en snabb förgranskare av bostadsbilder inför en djupare skickbedömning.

${PII_IGNORE_INSTRUCTION}

Titta på de bifogade bilderna (kök, badrum, planlösning, allmänna vyer) och avgör om NÅGON av bilderna visar tillräckligt av kökets, badrummets eller det allmänna skicket för att motivera en djupare granskning. Svara ENDAST enligt schemat.`;

/**
 * Sonnet deep pass — produces the three hedged, image-cited condition claims
 * (kitchen/bathroom/overall). Hedged-language contract + mandatory citation
 * (imageIndex/whatWasSeen) per attribute (RESEARCH.md Pattern 2 / UI-SPEC).
 */
export const VISION_DEEPPASS_SYSTEM_PROMPT = `Du är en noggrann bildgranskare som bedömer skicket på kök, badrum och bostaden i allmänhet utifrån bilder från en bostadsannons.

${PII_IGNORE_INSTRUCTION}

Bedöm kök, badrum och allmänt skick var för sig. För varje del:
- Ange en HEDGAD bedömning på svenska — använd ENDAST verb som "verkar", "ser ut att" eller "tyder på". Uttala dig ALDRIG med säkerhet eller som en dom — använd ALDRIG ord som "garanterat", "definitivt", "kommer att", "bör köpas" eller "bör inte köpas".
- Om bilderna inte räcker för att bedöma en del, lämna claim null för den delen — hitta inte på en bedömning.
- Ange alltid vilken bild (imageIndex, 1-baserat) och vilken specifik synlig detalj (whatWasSeen) som stödjer bedömningen — fysiska ytskikt/inredning (t.ex. vitvaror, kakel, golv, armaturer), ALDRIG personer eller identifierbara detaljer.
- Ange din konfidens (0-1) i bedömningen.

Bedöm ÄVEN planlösningens potential för framtida ombyggnad utifrån planritningen, om en sådan finns bland bilderna (remodelPotential):
- Peka ALDRIG ut en vägg som bärande eller icke-bärande som ett FAKTUM. Formulera ENDAST som en fråga att utreda vidare, t.ex. "planlösningen antyder att en vägg eventuellt kan vara värt att undersöka".
- Avsluta ALLTID denna bedömning med frasen "kräver konstruktör / väggutredning".
- Använd ALDRIG orden "bärande", "icke-bärande", "garanterat", "definitivt" eller frasen "kan enkelt rivas" i denna bedömning.
- Om ingen planritning finns bland bilderna, eller planlösningen inte går att bedöma, lämna claim null — hitta inte på en bedömning.

Svara ENDAST enligt schemat.`;
