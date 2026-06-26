import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";
import type { ThemedSection } from "@/lib/schemas/report";
import type { Flag } from "@/lib/report/flags";
import type { ReportPdfData } from "./render";
// Importing this module runs Font.register as a side effect — it MUST execute
// before any <Text> is laid out, otherwise the registered family is unknown and
// react-pdf falls back to AFM Helvetica (the å/ä/ö risk this whole subsystem
// exists to avoid). Keep this import above the StyleSheet.
import { REPORT_FONT_FAMILY } from "./fonts";

/**
 * report-document.tsx — the @react-pdf/renderer Document tree for the AI report
 * (RPRT-03, D-11/D-12). NO in-repo analog: built from RESEARCH §Pattern 1.
 *
 * SINGLE SOURCE OF TRUTH (D-11): renders ONLY the persisted `report_data` it is
 * handed (via render.ts) — never a re-fetch or re-synthesis. The section order
 * MIRRORS the on-screen experience: lead synthesis anchor → Ekonomi → Pris →
 * Område themed sections → the prioritized flags. The PDF is "the same
 * experience made portable".
 *
 * TRUST TREATMENT (D-12): every themed section with `status: "ej_tillgänglig"`
 * renders an honest "Ej tillgänglig" marker instead of fabricated prose (FM4);
 * the document carries the "ej finansiell rådgivning" disclaimer and a
 * source/freshness footer. The schema makes a verdict/recommendation field
 * unrepresentable (D-04), so the PDF can never present a köp/sälj-råd.
 *
 * COLOUR VOCABULARY: reuse the warm sage/terracotta palette from
 * brf-score-card.tsx — red-severity flags → terracotta/destructive, green →
 * sage, neutral → muted. We reuse the language, not the JSX.
 */

// Warm-palette hex values mirroring the on-screen theme tokens (sage primary,
// terracotta accent). brf-score-card.tsx maps these via Tailwind classes; in the
// PDF we need the literal colours.
const COLORS = {
  ink: "#2b2b28",
  muted: "#6f6b63",
  hair: "#e3ddd2",
  sage: "#5b7355", // green / reassuring
  terracotta: "#b5663f", // elevated / caution
  destructive: "#a13b2f", // red / warning
} as const;

const styles = StyleSheet.create({
  page: {
    fontFamily: REPORT_FONT_FAMILY,
    fontSize: 10,
    lineHeight: 1.5,
    color: COLORS.ink,
    paddingTop: 48,
    paddingBottom: 56,
    paddingHorizontal: 48,
  },
  header: {
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.hair,
    paddingBottom: 10,
  },
  title: { fontSize: 18, fontWeight: 600, color: COLORS.ink },
  subtitle: { fontSize: 9, color: COLORS.muted, marginTop: 2 },
  leadBox: {
    backgroundColor: "#f5f1e8",
    borderRadius: 4,
    padding: 12,
    marginBottom: 18,
  },
  leadLabel: {
    fontSize: 8,
    fontWeight: 600,
    color: COLORS.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
  },
  lead: { fontSize: 12, lineHeight: 1.5, color: COLORS.ink },
  section: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: COLORS.ink,
    marginBottom: 6,
  },
  claim: { marginBottom: 6 },
  claimText: { fontSize: 10, color: COLORS.ink },
  sourceRef: { fontSize: 7, color: COLORS.muted, marginTop: 1 },
  unavailable: {
    fontSize: 9,
    color: COLORS.muted,
  },
  flagsTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: COLORS.ink,
    marginTop: 6,
    marginBottom: 6,
  },
  flagRow: { flexDirection: "row", marginBottom: 4, alignItems: "flex-start" },
  flagDot: { width: 6, height: 6, borderRadius: 3, marginTop: 3, marginRight: 6 },
  flagText: { fontSize: 10, flex: 1 },
  flagQuote: { fontSize: 8, color: COLORS.muted, marginTop: 1 },
  footer: {
    position: "absolute",
    bottom: 28,
    left: 48,
    right: 48,
    borderTopWidth: 1,
    borderTopColor: COLORS.hair,
    paddingTop: 8,
  },
  disclaimer: { fontSize: 8, color: COLORS.muted },
  trace: { fontSize: 7, color: COLORS.muted, marginTop: 2 },
});

/** Maps a flag severity onto the warm-palette dot colour (D-00). */
function severityColor(severity: Flag["severity"]): string {
  if (severity === "green") return COLORS.sage;
  if (severity === "red") return COLORS.destructive;
  return COLORS.muted;
}

/** Swedish display labels per stable flag id (vocabulary, mirrors the UI). */
const FLAG_LABELS: Record<string, string> = {
  brf_high_debt: "Hög skuldsättning i föreningen",
  brf_low_debt: "Låg skuldsättning i föreningen",
  brf_avgift_healthy: "Årsavgift på sund nivå",
  brf_avgift_lean: "Låg årsavgift",
  brf_avgift_elevated: "Förhöjd årsavgift",
  brf_kassaflode_deficit: "Negativt kassaflöde",
  brf_kassaflode_weak: "Svagt kassaflöde",
  price_above_area: "Pris över områdets snitt",
  price_below_area: "Pris under områdets snitt",
  stambyte_planerat: "Stambyte planerat",
  stambyte_nyligen_genomfort: "Stambyte nyligen genomfört",
};

function flagLabel(id: string): string {
  return FLAG_LABELS[id] ?? id;
}

/** One themed section (Ekonomi / Pris / Område). */
function ThemedSectionView({
  title,
  section,
}: {
  title: string;
  section: ThemedSection;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {section.status === "ej_tillgänglig" || section.claims.length === 0 ? (
        // D-12 / FM4: honest gap marker, never fabricated content.
        <Text style={styles.unavailable}>
          Ej tillgänglig — underlag saknas för detta tema.
        </Text>
      ) : (
        section.claims.map((claim, i) => (
          <View key={i} style={styles.claim}>
            <Text style={styles.claimText}>{claim.text}</Text>
            <Text style={styles.sourceRef}>Källa: {claim.sourceRef}</Text>
          </View>
        ))
      )}
    </View>
  );
}

/**
 * The report PDF Document. Mirrors the on-screen section order (D-11) and
 * carries the D-12 trust treatment. Receives the persisted report_data only.
 */
export function ReportDocument({ data }: { data: ReportPdfData }) {
  const { report, flags } = data;
  // Render flags in the model-chosen priority order (by id), then any remaining
  // flags. The model can reorder/prioritise but can never mint an id not present
  // upstream (the ids resolve against the deterministic flag set).
  const flagById = new Map(flags.map((f) => [f.id, f]));
  const prioritized = report.prioritizedFlagIds
    .map((id) => flagById.get(id))
    .filter((f): f is Flag => Boolean(f));
  const remaining = flags.filter(
    (f) => !report.prioritizedFlagIds.includes(f.id),
  );
  const orderedFlags = [...prioritized, ...remaining];

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>AI-analys av bostaden</Text>
          <Text style={styles.subtitle}>
            En oberoende, datadriven sammanställning — ej finansiell rådgivning.
          </Text>
        </View>

        {/* Lead synthesis — the cross-source anchor (D-05), first on screen. */}
        <View style={styles.leadBox}>
          <Text style={styles.leadLabel}>Sammanfattning</Text>
          <Text style={styles.lead}>{report.leadSynthesis}</Text>
        </View>

        {/* Themed sections in on-screen order. */}
        <ThemedSectionView title="Ekonomi" section={report.ekonomi} />
        <ThemedSectionView title="Pris" section={report.pris} />
        <ThemedSectionView title="Område" section={report.omrade} />

        {/* Prioritized flags. */}
        {orderedFlags.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.flagsTitle}>Flaggor</Text>
            {orderedFlags.map((flag) => (
              <View key={flag.id} style={styles.flagRow}>
                <View
                  style={[
                    styles.flagDot,
                    { backgroundColor: severityColor(flag.severity) },
                  ]}
                />
                <View style={styles.flagText}>
                  <Text>{flagLabel(flag.id)}</Text>
                  {flag.sourceQuote ? (
                    <Text style={styles.flagQuote}>”{flag.sourceQuote}”</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        )}

        {/* D-12 trust footer: disclaimer + freshness/trace, on every page. */}
        <View style={styles.footer} fixed>
          <Text style={styles.disclaimer}>
            Detta är en oberoende dataanalys och utgör inte finansiell
            rådgivning. Uppgifter kan vara osäkra eller ej tillgängliga — kontrollera
            alltid mot originalkällor innan beslut.
          </Text>
          <Text style={styles.trace}>
            Genererad av {data.model ?? "AI"} · {data.promptVersion ?? "rapport"}
          </Text>
        </View>
      </Page>
    </Document>
  );
}
