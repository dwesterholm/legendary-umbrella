/**
 * brf-page.ts - the public Booli page of one housing association (BRF), read for
 * its debt per square metre (Phase 14.2, WATCH-03, R-07).
 *
 * WHY THIS PAGE: a listing's own payload carries no association debt (its
 * `housingCoopInfo` section is empty and lazy-loaded). The association has its own
 * public page, `/bostadsrattsforening/<digits>` (the digits sit in the listing's
 * last breadcrumb, see `brfIdFromBreadcrumbs`), which prints total loans ("Lån")
 * and the floor area of the tenant-owner flats ("Boarea bostadsrätter") taken from
 * the association's annual report, and says which year's report that is. Booli's own
 * "belåning per kvm" figure sits behind a login, so we compute it: loans / area.
 *
 * ALLABRF IS DEAD: the old Allabrf reader was built on guessed URLs and never worked
 * (memory allabrf-auto-fetch-never-worked). Nothing here uses it.
 *
 * ERROR CONTRACT (HIGH-1): a failed render THROWS from `fetchBrfFacts` / `fetchBrfText`
 * so the caller can count it as a failed association; it is never turned into an
 * empty value. A page that rendered but lacks the labels is NOT a failure: it
 * parses to null fields (not every association has published its report on Booli).
 *
 * PII: the page text is read in memory. Only four numbers leave `parseBrfPage`;
 * board members and other names that sit on the page are never touched.
 *
 * BRF_PAGE_FUNCTION is a repo constant compiled like the other page functions
 * (T-14.2-03); the page text is read as data and never evaluated.
 */

import { runPlaywrightRender } from "@/lib/booli/transport";

/**
 * Page function: wait until the economy numbers are in the DOM (up to about 6 s, the page
 * fills them in after load), then hand back the visible text of the page. Wrapped as an
 * Apollo-shaped item so the renderer's "usable item" filter accepts it. The browser-side
 * expression is a string, ES2019 and below.
 */
export const BRF_PAGE_FUNCTION = `async function pageFunction(context) {
  const { page } = context;
  let text = "";
  for (let i = 0; i < 6; i++) {
    text = String(await page.evaluate("document.body ? document.body.innerText : ''"));
    if (/Boarea/i.test(text) && /L.n/.test(text)) break;
    await page.waitForTimeout(1000);
  }
  return { hasApollo: text.length > 0, __APOLLO_STATE__: { "BrfPage:0": { __typename: "BrfPage", text: text } } };
}`;

/** The public page of association `id`. Digits only (T-14.2-13, same rule as `soldDetailUrl`). */
export function brfPageUrl(id: string): string {
  if (typeof id !== "string" || !/^\d+$/.test(id)) {
    throw new Error("Ogiltigt BRF-id");
  }
  return `https://www.booli.se/bostadsrattsforening/${id}`;
}

export interface BrfFacts {
  /** Total loans of the association, kr. */
  loanSek: number | null;
  /** Floor area of the tenant-owner flats, m2. */
  areaSqm: number | null;
  /** The annual report year the numbers come from. */
  reportYear: number | null;
  /** Whole kronor per m2: Math.round(loanSek / areaSqm); null when either is missing or the area is 0. */
  debtPerSqm: number | null;
}

/** Thousands separators Booli and browsers produce: space, no-break space, narrow no-break space. */
const SPACE = "[ \\u00a0\\u202f\\u2009]";

/** A number with space-separated thousands, an optional decimal part, in front of an optional unit. */
const NUMBER = `(\\d{1,3}(?:${SPACE}\\d{3})+|\\d+)(?:[.,](\\d+))?`;

/** Between a label and its value: an optional colon, white space and up to a few line breaks (a rendered page puts the value on its own line, often after a blank one). */
const GAP = `${SPACE}*:?(?:${SPACE}|\\n){0,8}`;

function numberFrom(whole: string | undefined, decimals: string | undefined): number | null {
  if (!whole) return null;
  const n = Number(`${whole.replace(new RegExp(SPACE, "g"), "")}${decimals ? `.${decimals}` : ""}`);
  return Number.isFinite(n) ? n : null;
}

/**
 * The first number-with-unit that follows `label`: on the same line after a colon, or on a line
 * below it (a rendered page puts a key and its value on separate lines, 2026-10-13: "Lån",
 * "14 800 000 kr"). The unit is required, so a label followed by another label never matches.
 */
function valueAfter(text: string, label: string, unit: RegExp): number | null {
  const re = new RegExp(`(?:^|\\n|\\s)${label}${GAP}${NUMBER}${SPACE}*(?:${unit.source})`, "i");
  const m = text.match(re);
  if (!m) return null;
  return numberFrom(m[1], m[2]);
}

/** Total loans: "Lån: 30 072 899 kr". The label must be the word "Lån" itself, not "Lånekostnad" and the like. */
const LOAN_LABEL = "L[åa]n(?![a-zåäö])";
/** Floor area of the tenant-owner flats: "Boarea bostadsrätter: 6 076 m²" (also m2 / kvm). */
const AREA_LABEL = "Boarea[ \\u00a0\\u202f]+bostadsr[äa]tter";

/**
 * Loans, area, report year and debt per m2 from the visible text of a BRF page. Never throws;
 * anything it cannot read is null. `debtPerSqm` is only set when both numbers are present
 * and the area is above 0.
 */
export function parseBrfPage(text: string): BrfFacts {
  const t = typeof text === "string" ? text : "";
  const loanSek = valueAfter(t, LOAN_LABEL, /kr/);
  const areaSqm = valueAfter(t, AREA_LABEL, /m²|m2|kvm/);
  const yearMatch = t.match(/årsredovisning(?:en)?\s+för\s+(20\d{2}|19\d{2})/i);
  const reportYear = yearMatch ? Number(yearMatch[1]) : null;
  const debtPerSqm = loanSek !== null && areaSqm !== null && areaSqm > 0 ? Math.round(loanSek / areaSqm) : null;
  return { loanSek, areaSqm, reportYear, debtPerSqm };
}

type Render = (url: string, pageFunction: string) => Promise<unknown[]>;

/** The visible text of association `id`'s page. Throws when the page could not be rendered (HIGH-1). */
export async function fetchBrfText(id: string, render: Render = runPlaywrightRender): Promise<string> {
  const items = await render(brfPageUrl(id), BRF_PAGE_FUNCTION);
  const state = (items[0] as { __APOLLO_STATE__?: Record<string, { text?: unknown }> } | undefined)?.__APOLLO_STATE__;
  const text = state?.["BrfPage:0"]?.text;
  if (typeof text !== "string") throw new Error("BRF-sidan gav ingen text");
  return text;
}

/**
 * Renders association `id`'s public Booli page and reads its numbers. Rejects when the render
 * fails (the caller counts that association as failed); resolves with null fields when the
 * page rendered without the labels.
 */
export async function fetchBrfFacts(id: string, render: Render = runPlaywrightRender): Promise<BrfFacts> {
  return parseBrfPage(await fetchBrfText(id, render));
}
