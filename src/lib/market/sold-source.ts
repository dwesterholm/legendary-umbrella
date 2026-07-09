/**
 * sold-source.ts — thin re-export shim (Phase 5 unification, PRICE-01 success
 * criterion 4). The sold-price (slutpriser) transport that used to live here
 * has been absorbed VERBATIM into `src/lib/booli/client.ts`, so active
 * listings, area search, AND sold comps now share ONE `runPlaywrightRender`
 * transport + fallback tree.
 *
 * This module is kept ONLY so the import path `@/lib/market/sold-source`
 * stays valid — `enrich-market-context.ts` and `sold-source.test.ts` resolve
 * their imports here UNCHANGED (the true PRICE-01 no-op-migration guarantee).
 * Do NOT re-add logic here; add it to `src/lib/booli/client.ts` instead.
 */
export {
  fetchSoldComps,
  resolveAreaId,
  type SoldSourceQuery,
  type PriceTier,
  type Breadcrumb,
} from "@/lib/booli/client";
