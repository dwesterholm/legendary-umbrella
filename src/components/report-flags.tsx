"use client";

import { Badge } from "@/components/ui/badge";
import { FLAG_IDS, type Flag, type FlagSeverity } from "@/lib/report/flags";
import { cn } from "@/lib/utils";

interface ReportFlagsProps {
  /** The deterministic flag set persisted with the report (by-id, code-raised). */
  flags: Flag[];
  /** Optional: only render flags whose id is in this allow-list (e.g. weave the
   *  BRF flags beside the BRF card, the price flags beside the price card). */
  only?: readonly string[];
  /**
   * Optional ORDERING hint (WR-02 / D-11): ids listed here are rendered first,
   * in this order; every remaining real flag still renders after them. This may
   * only emphasise — it can NEVER filter a real, code-raised flag off the
   * screen. Ids that don't resolve to a real flag (e.g. a hallucinated id from
   * the model's `prioritizedFlagIds`) are ignored. Mirrors the PDF renderer's
   * prioritized-then-remaining ordering so the screen and PDF agree.
   */
  priority?: readonly string[];
  /** Optional heading shown above the chips when this group is woven into a card. */
  title?: string;
  className?: string;
}

/**
 * Human-readable Swedish label per deterministic flag id. The flag engine
 * (flags.ts) only ever emits these ids — the report narrates them by id, and
 * this map is the single on-screen vocabulary so the chip text never drifts
 * from the engine.
 */
const FLAG_LABELS: Record<string, string> = {
  [FLAG_IDS.BRF_HIGH_DEBT]: "Hög skuldsättning",
  [FLAG_IDS.BRF_LOW_DEBT]: "Låg skuldsättning",
  [FLAG_IDS.BRF_AVGIFT_HEALTHY]: "Sund avgiftsnivå",
  [FLAG_IDS.BRF_AVGIFT_LEAN]: "Låg avgift — kan dölja eftersatt underhåll",
  [FLAG_IDS.BRF_AVGIFT_ELEVATED]: "Förhöjd avgift",
  [FLAG_IDS.BRF_KASSAFLODE_DEFICIT]: "Negativt kassaflöde",
  [FLAG_IDS.BRF_KASSAFLODE_WEAK]: "Svagt sparande",
  [FLAG_IDS.PRICE_ABOVE_AREA]: "Pris över områdessnittet",
  [FLAG_IDS.PRICE_BELOW_AREA]: "Pris under områdessnittet",
  [FLAG_IDS.STAMBYTE_PLANERAT]: "Stambyte planerat",
  [FLAG_IDS.STAMBYTE_NYLIGEN]: "Stambyte nyligen genomfört",
};

/** A short Swedish caption for the flag's source path (D-06 provenance). */
const SOURCE_LABELS: Record<string, string> = {
  "brf.skuldPerKvm": "BRF-skuld",
  "brf.avgiftsniva": "BRF-avgift",
  "brf.kassaflode": "BRF-kassaflöde",
  "price.deltaPct": "Prisjämförelse",
  "softSignals.stambytePlanerat": "Årsredovisning",
};

/**
 * Severity → the SAME warm sage/terracotta vocabulary as `gradeColors`
 * (brf-score-card.tsx:58-67), so a flag never speaks a different visual
 * language than the cards it sits beside (D-00). Green = sage (reassuring),
 * red = destructive (warning), neutral = terracotta (worth a look).
 */
function severityChip(severity: FlagSeverity): string {
  switch (severity) {
    case "green":
      return "bg-sage-100 text-sage-700 border-sage-200";
    case "red":
      return "bg-destructive/10 text-destructive border-destructive/30";
    default:
      return "bg-terracotta-100 text-terracotta-600 border-terracotta-200";
  }
}

/**
 * `ReportFlags` — the visible surface of the deterministic flag engine, rendered
 * as red/green/neutral chips in the SAME sage/terracotta trust language as the
 * BRF/price/area cards (D-00). Designed to be woven INTO / beside those cards via
 * the `only` allow-list, not as a disconnected standalone widget. Each chip
 * carries its `sourceRef` provenance (and, for cited soft signals, its verbatim
 * quote + confidence) so the flag is auditable, mirroring the BRF card's
 * source-quote discipline (D-06/D-11).
 */
export function ReportFlags({
  flags,
  only,
  priority,
  title,
  className,
}: ReportFlagsProps) {
  // `only` is a legitimate allow-list for weaving a SUBSET beside a card.
  const visible = only ? flags.filter((f) => only.includes(f.id)) : flags;
  // WR-02 / D-11: `priority` may ONLY reorder/emphasise — never filter. Render
  // the prioritized real flags first (in the given order), then every remaining
  // visible flag, so a hallucinated or empty priority list can never hide a
  // real code-raised flag. Mirrors report-document.tsx:184-191.
  let shown = visible;
  if (priority && priority.length > 0) {
    const visibleById = new Map(visible.map((f) => [f.id, f]));
    const prioritized = priority
      .map((id) => visibleById.get(id))
      .filter((f): f is Flag => Boolean(f));
    const prioritizedIds = new Set(prioritized.map((f) => f.id));
    const remaining = visible.filter((f) => !prioritizedIds.has(f.id));
    shown = [...prioritized, ...remaining];
  }
  if (shown.length === 0) return null;

  return (
    <div className={cn("space-y-2", className)}>
      {title && (
        <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
          {title}
        </p>
      )}
      <ul className="space-y-2">
        {shown.map((flag) => {
          const label = FLAG_LABELS[flag.id] ?? flag.id;
          const sourceLabel = SOURCE_LABELS[flag.sourceRef] ?? flag.sourceRef;
          const hasCitation =
            typeof flag.sourceQuote === "string" && flag.sourceQuote.length > 0;
          return (
            <li
              key={flag.id}
              className="flex flex-col gap-1.5 rounded-lg border border-warm-gray-100 bg-warm-gray-50 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="secondary"
                  className={cn("border", severityChip(flag.severity))}
                >
                  {label}
                </Badge>
                <span className="text-xs text-warm-gray-500">
                  Källa: {sourceLabel}
                  {typeof flag.pageRef === "number" && flag.pageRef
                    ? ` (sid ${flag.pageRef})`
                    : ""}
                  {typeof flag.confidence === "number"
                    ? ` · Säkerhet ${Math.round(flag.confidence * 100)}%`
                    : ""}
                </span>
              </div>
              {/* D-06/D-11: a cited soft signal shows its verbatim quote. */}
              {hasCitation && (
                <blockquote className="border-l-2 border-warm-gray-200 pl-3 text-sm italic text-warm-gray-700">
                  {flag.sourceQuote}
                </blockquote>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
