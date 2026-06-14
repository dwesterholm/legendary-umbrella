import Link from "next/link";
import type { Metadata } from "next";
import { BRF_SCORE_THRESHOLDS } from "@/lib/brf/score";
import { BRF_SANITY_BANDS } from "@/lib/brf/sanity";
import { formatSEK } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Så räknar vi BRF-betyget | Bostad AI",
  description:
    "Full transparens: varje nyckeltal, tröskelvärde och vikt som ligger bakom BRF-betyget A–F.",
};

/**
 * `/sa-raknar-vi` — the public "Så räknar vi BRF-betyget" methodology page (D-09).
 *
 * This is the BRF-02 "transparent methodology" deliverable and the differentiator
 * vs Allabrf's black box. It is intentionally PUBLIC — it lives OUTSIDE the
 * auth-gated `(app)` route group (whose layout `redirect("/login")`s guests), so
 * an unauthenticated visitor can read it. It performs NO database query, holds NO
 * user data, and makes NO Claude call (threat T-02-19): it is pure content plus
 * the imported scorer constants.
 *
 * Every threshold and weight is rendered straight from `BRF_SCORE_THRESHOLDS`
 * (and the plausibility bands from `BRF_SANITY_BANDS`) — the SAME constants the
 * deterministic scorer uses. The numbers are never duplicated here, so if the
 * scorer changes, this page changes with it (single source of truth).
 */
export default function SaRaknarViPage() {
  const t = BRF_SCORE_THRESHOLDS;
  const pct = (w: number) => `${Math.round(w * 100)} %`;

  return (
    <div className="min-h-screen bg-warm-white">
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-12">
        <header className="flex flex-col gap-3">
          <Link
            href="/"
            className="text-sm text-warm-gray-500 transition-colors hover:text-sage-600"
          >
            ← Bostad AI
          </Link>
          <h1 className="text-3xl font-semibold text-warm-gray-900">
            Så räknar vi BRF-betyget
          </h1>
          <p className="text-warm-gray-700">
            BRF-betyget är inte en svart låda. Claude läser endast ut siffrorna
            ur årsredovisningen — själva betyget beräknas deterministiskt i kod
            från nyckeltalen nedan. Samma årsredovisning ger alltid samma betyg.
            Här är varje nyckeltal, tröskelvärde och vikt vi använder.
          </p>
        </header>

        {/* skuldPerKvm */}
        <section className="flex flex-col gap-3 rounded-xl border border-warm-gray-200 bg-white p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xl font-semibold text-warm-gray-900">
              Skuld per kvm
            </h2>
            <span className="text-sm font-medium text-warm-gray-500">
              Vikt {pct(t.skuldPerKvm.weight)}
            </span>
          </div>
          <p className="text-sm text-warm-gray-700">
            Räntebärande skuld delat på upplåten bostadsrättsyta (SEK/m²), enligt
            BFNAR 2023:1. Lägre skuld är bättre — hög belåning per kvm är en risk
            när räntorna stiger.
          </p>
          <ul className="space-y-1 text-sm text-warm-gray-700">
            <li>
              Under {formatSEK(t.skuldPerKvm.strongMax)}/m² — stark
            </li>
            <li>
              {formatSEK(t.skuldPerKvm.strongMax)}–
              {formatSEK(t.skuldPerKvm.midMax)}/m² — bra
            </li>
            <li>
              {formatSEK(t.skuldPerKvm.midMax)}–
              {formatSEK(t.skuldPerKvm.weakMax)}/m² — medel
            </li>
            <li>
              Över {formatSEK(t.skuldPerKvm.weakMax)}/m² — varningsflagga
            </li>
          </ul>
        </section>

        {/* avgiftsniva */}
        <section className="flex flex-col gap-3 rounded-xl border border-warm-gray-200 bg-white p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xl font-semibold text-warm-gray-900">
              Årsavgift per kvm
            </h2>
            <span className="text-sm font-medium text-warm-gray-500">
              Vikt {pct(t.avgiftsniva.weight)}
            </span>
          </div>
          <p className="text-sm text-warm-gray-700">
            Årsavgift per kvm (SEK/m²/år). En låg avgift är bara bra om föreningen
            ändå sparar till underhåll — både en mycket låg och en mycket hög
            avgift bedöms svagare.
          </p>
          <ul className="space-y-1 text-sm text-warm-gray-700">
            <li>
              {formatSEK(t.avgiftsniva.healthyMin)}–
              {formatSEK(t.avgiftsniva.healthyMax)}/m²/år — sund nivå
            </li>
            <li>
              {formatSEK(t.avgiftsniva.leanMin)}–
              {formatSEK(t.avgiftsniva.healthyMin)} eller{" "}
              {formatSEK(t.avgiftsniva.healthyMax)}–
              {formatSEK(t.avgiftsniva.elevatedMax)}/m²/år — mager/förhöjd
            </li>
            <li>
              Under {formatSEK(t.avgiftsniva.leanMin)} eller över{" "}
              {formatSEK(t.avgiftsniva.elevatedMax)}/m²/år — svag
            </li>
          </ul>
        </section>

        {/* kassaflode */}
        <section className="flex flex-col gap-3 rounded-xl border border-warm-gray-200 bg-white p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xl font-semibold text-warm-gray-900">
              Sparande per kvm (kassaflöde)
            </h2>
            <span className="text-sm font-medium text-warm-gray-500">
              Vikt {pct(t.kassaflode.weight)}
            </span>
          </div>
          <p className="text-sm text-warm-gray-700">
            Kassaflöde från den löpande verksamheten, sparande per kvm (SEK/m²).
            Högre är bättre — ett negativt kassaflöde är ett underskott.
          </p>
          <ul className="space-y-1 text-sm text-warm-gray-700">
            <li>Minst {formatSEK(t.kassaflode.healthyMin)}/m² — sund</li>
            <li>
              {formatSEK(t.kassaflode.warningMin)}–
              {formatSEK(t.kassaflode.healthyMin)}/m² — varning
            </li>
            <li>
              0–{formatSEK(t.kassaflode.warningMin)}/m² — svag
            </li>
            <li>Negativt — underskott</li>
          </ul>
        </section>

        {/* underhallsplanStatus */}
        <section className="flex flex-col gap-3 rounded-xl border border-warm-gray-200 bg-white p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xl font-semibold text-warm-gray-900">
              Underhållsplan
            </h2>
            <span className="text-sm font-medium text-warm-gray-500">
              Vikt {pct(t.underhallsplanStatus.weight)}
            </span>
          </div>
          <p className="text-sm text-warm-gray-700">
            Status för föreningens underhållsplan. En aktuell plan visar att
            föreningen har koll på kommande kostnader.
          </p>
          <ul className="space-y-1 text-sm text-warm-gray-700">
            <li>
              Finns, aktuell — bäst (
              {t.underhallsplanStatus.scores.finns_aktuell})
            </li>
            <li>
              Finns, inaktuell ({t.underhallsplanStatus.scores.finns_inaktuell})
            </li>
            <li>Oklart ({t.underhallsplanStatus.scores.oklart})</li>
            <li>Saknas — sämst ({t.underhallsplanStatus.scores.saknas})</li>
          </ul>
        </section>

        {/* Grade letters */}
        <section className="flex flex-col gap-3 rounded-xl border border-warm-gray-200 bg-white p-6">
          <h2 className="text-xl font-semibold text-warm-gray-900">
            Från nyckeltal till betyg A–F
          </h2>
          <p className="text-sm text-warm-gray-700">
            Varje nyckeltal ger en delpoäng mellan 0 och 1. Delpoängen
            multipliceras med sin vikt (vikterna summerar till 100 %) och summan
            mappas till ett betyg. Ett nyckeltal som saknas ger 0 i delpoäng men
            behåller sin vikt — saknad information drar alltså ner betyget, den
            antas aldrig vara bra.
          </p>
          <ul className="space-y-1 text-sm text-warm-gray-700">
            <li>
              <span className="font-semibold text-sage-700">A / B</span> — stark
              ekonomi
            </li>
            <li>
              <span className="font-semibold text-terracotta-600">C / D</span> —
              blandad bild, läs detaljerna
            </li>
            <li>
              <span className="font-semibold text-destructive">E / F</span> —
              svaga nyckeltal, var försiktig
            </li>
          </ul>
        </section>

        {/* Confidence + sanity bands */}
        <section className="flex flex-col gap-3 rounded-xl border border-warm-gray-200 bg-white p-6">
          <h2 className="text-xl font-semibold text-warm-gray-900">
            Osäkerhet och rimlighetskontroll
          </h2>
          <p className="text-sm text-warm-gray-700">
            Varje utläst siffra får en säkerhetsindikator. När säkerheten är låg —
            eller när en siffra hamnar utanför ett rimligt intervall (t.ex. en
            månadsavgift förväxlad med en årsavgift) — flaggas den{" "}
            <span className="font-medium">”Osäker — kontrollera själv”</span> och
            du kan rätta värdet själv. En manuell rättning räknas om betyget direkt
            och markeras <span className="font-medium">”Manuellt angiven”</span> —
            utan att fråga Claude igen.
          </p>
          <p className="text-sm font-medium text-warm-gray-700">
            Rimliga intervall vi kontrollerar mot:
          </p>
          <ul className="space-y-1 text-sm text-warm-gray-700">
            <li>
              Skuld per kvm: {formatSEK(BRF_SANITY_BANDS.skuldPerKvm.min)}–
              {formatSEK(BRF_SANITY_BANDS.skuldPerKvm.max)}/m²
            </li>
            <li>
              Årsavgift per kvm: {formatSEK(BRF_SANITY_BANDS.avgiftsniva.min)}–
              {formatSEK(BRF_SANITY_BANDS.avgiftsniva.max)}/m²/år
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
