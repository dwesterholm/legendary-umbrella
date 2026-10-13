/**
 * page-functions.ts — the ONE shared extraction page function used by every
 * owned-transport Booli read (listing-detail AND area-search / slutpriser).
 *
 * CONTRACT (unchanged since Phase 5): the actor returns one item
 * `{ hasApollo, __APOLLO_STATE__ }` where `__APOLLO_STATE__` is a map keyed
 * `Listing:<id>` / `SoldProperty:<id>` → entity. `client.ts` reads that map and
 * nothing else, so everything Booli-shaped lives here.
 *
 * HOW BOOLI SHIPS DATA (live-probed 2026-10-06, after Booli's site rebuild):
 *  1. LEGACY — `<script id="__NEXT_DATA__">` with
 *     `props.pageProps.__APOLLO_STATE__` (a normalized cache with `__ref`
 *     links). Gone from every page we checked, kept as the first attempt in
 *     case any page still serves it.
 *  2. DETAIL PAGE (`/bostad/<id>`) — Next.js App Router. The server-rendered
 *     payload is streamed as `self.__next_f.push([1, "<flight text>"])`
 *     script tags. The flight text is newline-separated `<id>:<json>` rows;
 *     one row contains the full `{"__typename":"Listing", ...}` entity with
 *     the SAME field names as before (constructionYear, breadcrumbs,
 *     listPrice {raw}, tenureForm, agency, listingUrl, images [{id,
 *     primaryLabel}] ...), just DENORMALIZED: nested objects are inline, not
 *     `__ref` links. `client.ts`'s helpers accept both forms.
 *     `self.__next_f` itself is emptied once React hydrates, so we read the
 *     script tags' text, never the global.
 *  3. SEARCH PAGE (`/sok/till-salu`) — Apollo's streaming SSR transport:
 *     `(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push({...})`
 *     inline scripts carrying raw query RESULTS. Each hit is a
 *     `{"__typename":"ListableProperty", ...}` card: a THINNER shape than the
 *     old `Listing` entity (no constructionYear, breadcrumbs, listSqmPrice,
 *     description; price/area/rooms/rent are display strings). We map each
 *     card onto the old `Listing` field names (parsing the display strings
 *     back to numbers in `{raw}` FormattedValue shape) so the rest of the
 *     pipeline is untouched. The missing fields are backfilled per listing by
 *     the detail fetch in `enrichCandidateImages` (job.ts); until then a
 *     search result carries no build year or BRF name.
 *     The same transport also carries Booli's OWN result count for the query:
 *     `...,"totalCount":551,"meta":{...,"title":{"plainText":"Lägenheter till
 *     salu på Södermalm"}}`, once for the till-salu list and again for the
 *     Nyproduktion and Slutpriser variants of the same filter (Phase 14.2,
 *     WATCH-02, R-04). Each becomes a `SearchMeta:<n>` state entry
 *     `{ totalCount, title }` so the headless run can page until it has them
 *     all. A SearchMeta entry NEVER makes a page usable (W6): a page with a
 *     count and no cards still extracts to null, so a Booli card-format change
 *     surfaces as a dead page, never as an empty district.
 *
 * The browser-side body is exported separately (`EXTRACT_STATE_BROWSER_FN`) so
 * it can be executed verbatim in a real browser tab against live Booli pages
 * and in a jsdom unit test against captured fixtures — the same code that
 * runs inside the Apify actor.
 */

/**
 * Browser-side extractor. A self-contained arrow function as a string: no
 * closures over Node scope, no imports, ES2019 syntax only (it runs inside
 * the actor's Chromium, not in our runtime). Returns the state map, or
 * `null` when the page carried no recognisable data at all (a blocked/
 * challenge page), which `transport.ts` treats as a dead render.
 */
export const EXTRACT_STATE_BROWSER_FN = `() => {
  const state = {};
  let found = false;

  const toNumber = (text) => {
    if (typeof text !== "string") return null;
    const m = text.replace(/\\u00a0/g, " ").match(/-?\\d[\\d ]*(?:[.,]\\d+)?/);
    if (!m) return null;
    const n = Number(m[0].replace(/ /g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  // Sold-vs-asking label (e.g. "+12,5 %" or an EN DASH then "1,5 %"). A SEPARATE helper from
  // toNumber on purpose: toNumber's optional "-" does not match the EN DASH
  // (U+2013) or MINUS SIGN (U+2212) Booli writes for a below-asking sale, so
  // reading this label with it turned every discount into a premium (R-04a).
  // Anchored: sign (optional) + number + "%" or null; never a guess.
  const toSignedPct = (text) => {
    if (typeof text !== "string") return null;
    const m = text.replace(/\\u00a0/g, " ").trim().match(/^([+\\-\\u2013\\u2212]?)\\s*(\\d+(?:[.,]\\d+)?)\\s*%/);
    if (!m) return null;
    const n = Number(m[2].replace(",", "."));
    if (!Number.isFinite(n)) return null;
    return m[1] !== "" && m[1] !== "+" && n !== 0 ? -n : n;
  };
  const fv = (n) => (n === null ? null : { __typename: "FormattedValue", raw: n });

  // Walks a parsed value and calls visit(obj) for every plain object.
  const walk = (node, visit, depth) => {
    if (!node || typeof node !== "object" || depth > 80) return;
    if (!Array.isArray(node)) visit(node);
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const v of values) walk(v, visit, depth + 1);
  };

  // Returns the JSON object literal that starts at the "{" at \`start\`.
  const objectFrom = (text, start) => {
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  };
  // Returns the JSON object literal that starts at the "{" enclosing \`idx\`.
  const objectAround = (text, idx) => objectFrom(text, text.lastIndexOf("{", idx));

  const inlineScripts = Array.from(document.scripts)
    .filter((s) => !s.src)
    .map((s) => s.textContent || "");

  // 1. Legacy Pages Router payload.
  const legacy = document.getElementById("__NEXT_DATA__");
  if (legacy && legacy.textContent) {
    try {
      const data = JSON.parse(legacy.textContent);
      const apollo = data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
      if (apollo && typeof apollo === "object") {
        Object.assign(state, apollo);
        found = true;
      }
    } catch (_) {}
  }

  // 2. App Router flight payload (listing detail page).
  const flight = inlineScripts
    .filter((t) => t.startsWith("self.__next_f.push("))
    .map((t) => {
      try {
        const arr = JSON.parse(t.slice("self.__next_f.push(".length, t.lastIndexOf(")")));
        return typeof arr[1] === "string" ? arr[1] : "";
      } catch (_) { return ""; }
    })
    .join("");
  if (flight) {
    for (const line of flight.split("\\n")) {
      const colon = line.indexOf(":");
      if (colon < 1) continue;
      const body = line.slice(colon + 1);
      if (!body.includes('"__typename":"Listing"') && !body.includes('"__typename":"SoldProperty"')) continue;
      try {
        walk(JSON.parse(body), (o) => {
          if ((o.__typename === "Listing" || o.__typename === "SoldProperty") && (o.id || o.booliId)) {
            state[o.__typename + ":" + (o.id || o.booliId)] = o;
            found = true;
          }
        }, 0);
      } catch (_) {}
    }
  }

  // 3. Apollo streaming SSR transport (search / slutpriser pages).
  const transport = inlineScripts.filter((t) => t.includes("ApolloSSRDataTransport")).join("\\n");
  if (transport) {
    const seen = new Set();
    for (const typename of ["ListableProperty", "SoldProperty", "Listing"]) {
      const marker = '"__typename":"' + typename + '"';
      let idx = transport.indexOf(marker);
      while (idx >= 0) {
        const literal = objectAround(transport, idx);
        if (literal && !seen.has(literal)) {
          seen.add(literal);
          try {
            const o = JSON.parse(literal);
            if (o.__typename === "ListableProperty") {
              const dp = {};
              const points = (o.displayAttributes && o.displayAttributes.dataPoints) || [];
              for (const p of points) if (p && p.key && p.value) dp[p.key] = p.value.plainText || "";
              const tp = (o.tracking && o.tracking.properties) || {};
              const id = String(o.listingId || tp.booli_id || "");
              // originId tells the card's kind apart: "listing:<id>" (for
              // sale), "project:<id>" (new construction), "sold:bid:<id>".
              // The slutpriser page mixes all three on one page.
              const kind = String(o.originId || "").split(":")[0] || (o.saleType === "sold" ? "sold" : "listing");
              if (id && kind === "sold") {
                state["SoldProperty:" + id] = {
                  __typename: "SoldProperty",
                  id: id,
                  booliId: id,
                  url: o.url || null,
                  streetAddress: o.title || null,
                  objectType: o.objectType || tp.object_type || null,
                  soldDate: o.displayDate || null,
                  soldPrice: fv(toNumber(o.displayPrice)),
                  soldPricePercentageDiff: fv(toSignedPct(o.priceRemark && o.priceRemark.label)),
                  // Raw passthrough (not persisted: sold-schema.ts copies named
                  // fields only) so node-side code can cross-check the icon.
                  priceRemark: o.priceRemark || null,
                  // sold-schema.ts reads pris/kvm, m², rum, vån from these plainTexts.
                  displayAttributes: o.displayAttributes || null,
                  latitude: o.position ? o.position.latitude : null,
                  longitude: o.position ? o.position.longitude : null,
                };
                found = true;
              } else if (id) {
                const subtitle = typeof o.subtitle === "string" ? o.subtitle.split("\\u00b7").map((s) => s.trim()) : [];
                state["Listing:" + id] = {
                  __typename: "Listing",
                  id: id,
                  booliId: tp.booli_id != null ? String(tp.booli_id) : id,
                  url: o.url || null,
                  streetAddress: o.title || null,
                  descriptiveAreaName: subtitle.length > 1 ? subtitle[1] : null,
                  objectType: o.objectType || tp.object_type || null,
                  listPrice: fv(toNumber(o.displayPrice)),
                  livingArea: fv(toNumber(dp.livingArea)),
                  rooms: fv(toNumber(dp.rooms)),
                  floor: fv(toNumber(dp.floor)),
                  rent: fv(toNumber(dp.rentOrPlotAreaText)),
                  latitude: o.position ? o.position.latitude : null,
                  longitude: o.position ? o.position.longitude : null,
                  images: Array.isArray(o.images) ? o.images : [],
                  amenities: Array.isArray(o.amenities) ? o.amenities : [],
                  displayAttributes: o.displayAttributes || null,
                  upcomingSale: tp.upcoming_sale === true,
                  isNewConstruction: kind === "project" || tp.type === "project" || o.saleType === "newConstruction",
                  agency: o.presenter && o.presenter.name ? { __typename: "Agency", name: o.presenter.name } : null,
                  kommun: tp.municipality || null,
                  saleType: o.saleType || null,
                  displayDate: o.displayDate || null,
                  // primaryStatus.key: "biddingOpen" (Budgivning pågår), "upcomingSale", "newConstruction" ...; null when Booli sets none.
                  statusKey: (o.primaryStatus && o.primaryStatus.key) || null,
                };
                found = true;
              }
            } else if (o.id || o.booliId) {
              state[o.__typename + ":" + (o.id || o.booliId)] = o;
              found = true;
            }
          } catch (_) {}
        }
        idx = transport.indexOf(marker, idx + marker.length);
      }
    }

    // Booli's own result counts (Phase 14.2, R-04). Each "totalCount":N is followed by
    // ,"meta":{...,"title":{"plainText":...}}: cut that meta object forward and keep the
    // count with its title. W6: this branch deliberately never sets \`found\`. Only real
    // Listing / SoldProperty / legacy / flight entities make a page usable, so a page
    // that carries a count but no cards extracts to null and stays a dead page. A change
    // in Booli's card format must surface as a failed source, never as an empty district.
    const countMarker = '"totalCount":';
    const metaMarker = ',"meta":';
    const metaSeen = new Set();
    let metaN = 0;
    let ci = transport.indexOf(countMarker);
    while (ci >= 0) {
      let j = ci + countMarker.length;
      let digits = "";
      while (j < transport.length && transport[j] >= "0" && transport[j] <= "9") { digits += transport[j]; j++; }
      if (digits !== "") {
        let title = null;
        if (transport.startsWith(metaMarker, j) && transport[j + metaMarker.length] === "{") {
          const metaLiteral = objectFrom(transport, j + metaMarker.length);
          if (metaLiteral) {
            try {
              const meta = JSON.parse(metaLiteral);
              if (meta && meta.title && typeof meta.title.plainText === "string") title = meta.title.plainText;
            } catch (_) {}
          }
        }
        const metaId = digits + "|" + title;
        if (!metaSeen.has(metaId)) {
          metaSeen.add(metaId);
          state["SearchMeta:" + metaN] = { __typename: "SearchMeta", totalCount: Number(digits), title: title };
          metaN++;
        }
      }
      ci = transport.indexOf(countMarker, ci + countMarker.length);
    }
  }

  return found ? state : null;
}`;

export const APOLLO_PAGE_FUNCTION = `async function pageFunction(context) {
  const { page } = context;
  const apollo = await page.evaluate(${EXTRACT_STATE_BROWSER_FN});
  return { hasApollo: apollo !== null, __APOLLO_STATE__: apollo };
}`;
