/**
 * LLM-judge prompts for the report-synthesis eval (AI-SPEC §5).
 *
 * SCAFFOLD: these are the judge prompt templates the nightly synthesis flywheel
 * (AI-SPEC §6) and `report-promptfooconfig.yaml` consume. They are NOT wired
 * into per-PR CI — the deterministic, no-spend assertions (schema validity,
 * no-verdict invariant, sourceRef/flag-id resolution, numeral-binding,
 * stop-reason, log redaction) live in `evals/report.test.ts` and defend the
 * fabrication-/verdict-shaped failures first. These judges catch the residue an
 * LLM is genuinely needed for: the no-verdict LINE (D-04/FM2), generic FILLER
 * (FM5), and cross-source SYNTHESIS QUALITY (D-05) — each calibrated to ≥0.7
 * correlation with the human (köparmäklare / experienced-buyer) labels.
 *
 * Each judge returns a strict JSON verdict so promptfoo / the harness can gate
 * on `pass` and surface `reason` on a miss. The judge runs on the cheaper Haiku
 * tier (judging is a classification, not a synthesis task).
 */

/** The model id the judges run on — cheap classification, not synthesis. */
export const REPORT_JUDGE_MODEL = "claude-haiku-4-5";

/** The JSON contract every judge must return (parsed + gated by the harness). */
export interface JudgeVerdict {
  /** True = the report PASSES this dimension. */
  pass: boolean;
  /** 0–1 score for calibration against the human labels (≥0.7 corr target). */
  score: number;
  /** One-line Swedish reason — surfaced on a miss. */
  reason: string;
}

/**
 * Dimension: Opinionated-but-NO-verdict (AI-SPEC §5, D-04/FM2).
 * PASS = takes a clear stance on what matters, yet issues no buy/don't-buy
 * verdict, no "rätt pris är X", no "du bör lägga max Y", no implied valuation.
 * FAIL = any sentence a köparmäklare/bolånerådgivare reads as a personalized
 * recommendation or a stated value — OR so neutered it gives no opinion at all.
 */
export const JUDGE_NO_VERDICT_PROMPT = `Du är en svensk köparmäklare som granskar en AI-genererad bostadsrapport.

Bedöm EN sak: håller rapporten sig opinionsstark men UTAN att ge ett köp/sälj-råd eller en värdering?

UNDERKÄNN (pass=false) om rapporten innehåller något av:
- ett köp- eller säljråd ("ett bra köp", "avstå", "du bör köpa/sälja"),
- en prisrekommendation ("rätt pris är X", "du bör lägga max Y", "övervärderad/undervärderad"),
- en värdering av just denna lägenhet ("lägenheten är värd X"),
- ELLER motsatsen: så urvattnad att den inte tar någon ställning alls (ren mush utan omdöme).

GODKÄNN (pass=true) om rapporten är tydligt opinionsstark om VAD som är viktigt och HUR oroande det är, men stannar inom "ej finansiell rådgivning / ej värdering".

Rapport att bedöma:
{{output}}

Svara ENDAST med JSON: {"pass": boolean, "score": number (0-1), "reason": "kort svenska"}`;

/**
 * Dimension: No generic, non-citing filler (AI-SPEC §5, §1b FM5).
 * PASS = every claim says something specific about THIS listing's data.
 * FAIL = boilerplate ("läs årsredovisningen noga", "se över ekonomin") that
 * would survive copy-pasting to any other listing — zero second-opinion value.
 */
export const JUDGE_GENERIC_FILLER_PROMPT = `Du är en erfaren bostadsrättsköpare som granskar en AI-genererad rapport för generiskt fyll.

Testfråga för VARJE påstående: "Skulle exakt denna mening vara lika sann för en HELT ANNAN bostad?" Om JA → det är generiskt fyll.

UNDERKÄNN (pass=false) om rapporten innehåller generiska råd utan koppling till just denna affärs data, t.ex. "läs årsredovisningen noga", "se över föreningens ekonomi", "gör en noggrann besiktning" — sådant som saknar andrahandsvärde.

GODKÄNN (pass=true) om varje påstående är specifikt för denna listings data (t.ex. "föreningens skuld/kvm är 11 200 → i varningsbandet").

Rapport att bedöma:
{{output}}

Svara ENDAST med JSON: {"pass": boolean, "score": number (0-1), "reason": "kort svenska — citera ev. fyll-meningen"}`;

/**
 * Dimension: Cross-source lead-synthesis quality (AI-SPEC §5, D-05, §1b
 * "price premium AGAINST finances").
 * PASS = leadSynthesis connects ≥2 sources in one judgement the single cards
 * cannot state alone, reads pris/kvm vs area with sample size in mind, and
 * treats new-build leverage in context (byggår) rather than by the old-building
 * band. FAIL = two disconnected facts, wrong debt band for building age, comp
 * presented as a valuation, or a tiny comp sample treated as authoritative.
 */
export const JUDGE_SYNTHESIS_QUALITY_PROMPT = `Du är en svensk köparmäklare som bedömer lead-syntesen (öppningen) i en AI-rapport.

Bedöm om lead-syntesen är den tvärgående tråd du faktiskt skulle ge en klient:

GODKÄNN (pass=true, hög score) om den:
- kopplar ihop MINST två källor i ETT omdöme (t.ex. "priset ligger 8 % över snittet OCH föreningen är högt belånad → premien är svårare att motivera"),
- läser pris/kvm mot områdessnittet med hänsyn till antal sålda (litet urval = svagare slutsats),
- sätter nyproduktionens belåning i sitt sammanhang (hög skuld/kvm är väntat vid nyproduktion), inte enligt det gamla husets band.

UNDERKÄNN (pass=false, låg score) om den:
- ställer priset och BRF-skulden som två frånkopplade fakta,
- använder fel skuldband för husets ålder,
- presenterar jämförelsen mot sålda som en VÄRDERING,
- behandlar ett litet jämförelseunderlag som auktoritativt.

Lead-syntes / rapport att bedöma:
{{output}}

Svara ENDAST med JSON: {"pass": boolean, "score": number (0-1), "reason": "kort svenska"}`;

/** All report judges, keyed by the §5 dimension they score. */
export const REPORT_JUDGES = {
  noVerdict: JUDGE_NO_VERDICT_PROMPT,
  genericFiller: JUDGE_GENERIC_FILLER_PROMPT,
  synthesisQuality: JUDGE_SYNTHESIS_QUALITY_PROMPT,
} as const;
