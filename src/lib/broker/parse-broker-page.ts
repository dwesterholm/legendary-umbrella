import * as cheerio from "cheerio";

/**
 * parse-broker-page.ts — JSON-LD-first / DOM-fallback extraction of the two
 * fields the broker page can genuinely supply that Booli's own Apollo entity
 * cannot: `renovationStatus` and `description` (LSTG-03). floor/balcony/
 * brfName come from Apollo (see src/lib/booli/client.ts) and are
 * deliberately NOT re-derived here (RESEARCH Anti-Pattern — doubling the
 * maintenance surface + overwrite-risk on fields Apollo already answers).
 *
 * PII exclusion (LSTG-04 criterion 4, T-06-05): broker JSON-LD commonly
 * nests a `RealEstateAgent`/`Person` object carrying mäklare name/telephone/
 * email directly alongside the listing description. This module NEVER
 * object-spreads or passes through a parsed JSON-LD blob — every returned
 * field is read by explicit, named access (an allow-list of exactly
 * `description` and a dedicated renovation field/section), so agent PII
 * never enters the return value, and therefore never reaches the persisted
 * `listing_data` JSONB column.
 *
 * No-fabrication discipline (Pitfall 5, T-06-06): `renovationStatus` is
 * DETERMINISTIC extraction only. It is read from a dedicated field/section
 * (a JSON-LD field, or a DOM heading matching /renover|skick/i and its
 * adjacent content) — never inferred or paraphrased from free-text
 * description prose. If no dedicated field/section exists, the honest
 * result is `null` ("Ej tillgänglig"), not a guess.
 */

export interface BrokerFields {
  renovationStatus: string | null;
  description: string | null;
}

const RENOVATION_HEADING_RE = /renover|skick/i;

/**
 * Parses every `<script type="application/ld+json">` block on the page.
 * Malformed JSON-LD (trailing commas, HTML entities, etc.) is common on
 * real broker CMS output — each block is parsed independently inside its
 * own try/catch; a malformed block is skipped, never thrown.
 */
function extractJsonLd($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed: unknown = JSON.parse($(el).text());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const v of arr) {
        if (v && typeof v === "object") blocks.push(v as Record<string, unknown>);
      }
    } catch {
      // Malformed JSON-LD — skip this block, don't throw.
    }
  });
  return blocks;
}

const RELEVANT_JSONLD_TYPES = new Set(["RealEstateListing", "Product", "Residence"]);

function isRelevantJsonLdType(type: unknown): boolean {
  if (typeof type === "string") return RELEVANT_JSONLD_TYPES.has(type);
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && RELEVANT_JSONLD_TYPES.has(t));
  return false;
}

/**
 * Allow-list read of `description` out of a JSON-LD block. Explicit named
 * access only — never `{...block}` (Pitfall 4).
 */
function descriptionFromJsonLd(blocks: Record<string, unknown>[]): string | null {
  for (const block of blocks) {
    if (!isRelevantJsonLdType(block["@type"])) continue;
    const description = block.description;
    if (typeof description === "string" && description.trim().length > 0) {
      return description.trim();
    }
  }
  return null;
}

/**
 * DOM fallback for description: a prose block under a `.description`
 * section, or failing that the longest paragraph on the page (a cheap but
 * effective heuristic for "the free-text listing description" on broker
 * pages with no dedicated class name).
 */
function descriptionFromDom($: cheerio.CheerioAPI): string | null {
  const sectionText = $(".description").first().text().trim();
  if (sectionText.length > 0) return sectionText;

  // WR-04 (shard-2 review): a naive page-wide "longest <p>" frequently selects
  // a cookie/GDPR/footer/agent-contact block — not the listing description, and
  // some of it carries agent PII (undermining the LSTG-04 PII-exclusion the
  // JSON-LD path honors). Constrain the heuristic: prefer a main/article scope,
  // skip boilerplate/contact containers, require a minimum length, and reject
  // paragraphs that look like contact info (email/phone).
  const EXCLUDE = [
    "footer",
    "nav",
    "header",
    '[class*="cookie"]',
    '[class*="consent"]',
    '[class*="agent"]',
    '[class*="mäklare"]',
    '[class*="maklare"]',
    '[class*="contact"]',
    '[class*="kontakt"]',
  ].join(", ");
  const CONTACT_RE = /[\w.+-]+@[\w-]+\.\w+|\+?\d[\d\s-]{6,}\d/; // email or phone-ish
  const MIN_LEN = 60;

  for (const scope of ["main", "article", "body"]) {
    const root = $(scope).first();
    if (root.length === 0) continue;
    let longest: string | null = null;
    root.find("p").each((_, el) => {
      const $el = $(el);
      if ($el.closest(EXCLUDE).length > 0) return;
      const text = $el.text().trim();
      if (text.length < MIN_LEN || CONTACT_RE.test(text)) return;
      if (longest === null || text.length > longest.length) longest = text;
    });
    if (longest !== null) return longest;
  }
  return null;
}

/**
 * DOM fallback for renovationStatus: find a heading whose text matches
 * /renover|skick/i and read the text of its immediately-following sibling
 * element. No match → null (never inferred from description prose).
 */
function renovationStatusFromDom($: cheerio.CheerioAPI): string | null {
  let result: string | null = null;
  $("h1, h2, h3, h4, dt").each((_, el) => {
    if (result !== null) return;
    const $el = $(el);
    const headingText = $el.text().trim();
    if (!RENOVATION_HEADING_RE.test(headingText)) return;

    // WR-03 (shard-2 review): `.next()` alone misses the two most common broker
    // CMS layouts. Try in order:
    //  1. a <dt>'s paired <dd> (definition-list layout),
    //  2. the immediate next sibling (the original heuristic),
    //  3. the heading's parent container text minus the heading itself
    //     (wrapper-div layout: <div><h3>Skick</h3><p>…</p></div>).
    let text = "";
    if ($el.is("dt")) {
      text = $el.nextAll("dd").first().text().trim();
    }
    if (text.length === 0) {
      text = $el.next().text().trim();
    }
    if (text.length === 0) {
      const parentText = $el.parent().text().trim();
      if (parentText.startsWith(headingText)) {
        const rest = parentText.slice(headingText.length).trim();
        if (rest.length > 0) text = rest;
      }
    }
    if (text.length > 0) result = text;
  });
  return result;
}

/**
 * Extracts `renovationStatus` + `description` from broker-page HTML.
 * JSON-LD is tried first (structured, CMS-versioned); DOM selectors are the
 * fallback. Never throws — malformed/empty HTML yields `{ renovationStatus:
 * null, description: null }`.
 */
export function parseBrokerPage(html: string): BrokerFields {
  try {
    const $ = cheerio.load(html);
    const jsonLdBlocks = extractJsonLd($);

    const description = descriptionFromJsonLd(jsonLdBlocks) ?? descriptionFromDom($);

    // renovationStatus has no standard JSON-LD field (schema.org has no
    // dedicated "renovation" property) — it is DOM-section-sourced only,
    // per Pitfall 5's no-fabrication discipline.
    const renovationStatus = renovationStatusFromDom($);

    return { renovationStatus, description };
  } catch {
    return { renovationStatus: null, description: null };
  }
}
