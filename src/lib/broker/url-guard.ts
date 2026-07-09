import { promises as dns } from "node:dns";

/**
 * url-guard.ts — SSRF guard for broker-page URLs (LSTG-04, T-06-03).
 *
 * Phase 5's `isBooliUrl` (src/lib/booli/client.ts) is an exact-hostname
 * allowlist ("booli.se" / "*.booli.se") — sufficient there because Booli is
 * a single, fixed, known-good target domain. That pattern CANNOT be reused
 * here: `agencyListingUrl` is Booli-sourced data pointing at an arbitrary
 * third-party broker domain (Vitec Express, Mspecs, Fasad, or a bespoke
 * agency site) — there is no fixed hostname to allowlist, and Booli's own
 * data pipeline is itself a potential attacker-influence vector if it is
 * ever compromised or poisoned.
 *
 * A naive "does the hostname/URL string contain something bad" substring or
 * blocklist check is proven-insufficient (see `isBooliUrl`'s own doc comment
 * re: the WR-03 `.includes()` bypass class of bug). A future reader must NOT
 * "simplify" this into a substring/blocklist check on the URL string — that
 * is exactly the class of bug this guard exists to avoid.
 *
 * Per OWASP's Node.js SSRF guidance
 * [CITED: https://owasp.org/www-community/pages/controls/SSRF_Prevention_in_Nodejs],
 * this guard instead: (1) allowlists the protocol (http/https only), then
 * (2) resolves the hostname via DNS and classifies the RESOLVED IP address
 * against private/loopback/link-local ranges — resolve-then-classify, not a
 * pre-resolution string check. A DNS resolution failure is treated as
 * UNSAFE, never "assume public." This also blocks the cloud-metadata
 * endpoint (169.254.169.254) via the link-local range.
 *
 * IPv6 is classified separately from the IPv4 `PRIVATE_V4_RANGES` table
 * (`isUnsafeIPv6`). A string-prefix check on `::1`/`fe80:` alone is
 * insufficient (BL-1): `dns.lookup` can return a family-6 result for an
 * internal target, and the dangerous forms are the ones a naive check misses
 * — IPv4-mapped IPv6 (`::ffff:169.254.169.254`, `::ffff:10.x`), the
 * unique-local block `fc00::/7`, and the unspecified address `::`. So the
 * classifier UNWRAPS IPv4-mapped/compatible addresses back through
 * `isPrivateIPv4`, and rejects `::1` (loopback), `::` (unspecified), the full
 * `fe80::/10` link-local range, and `fc00::/7` unique-local.
 *
 * CR-01 — DNS-rebinding TOCTOU: a naive "resolve, classify, then call
 * fetch(url) again" implementation lets `fetch`'s own independent DNS
 * resolution diverge from the address just classified as safe (an attacker
 * controlling the hostname's DNS record can re-point it to an internal
 * target between the two resolutions). `resolveSafeExternalUrl` is the fix:
 * it resolves ONCE and returns the validated address/family to the caller,
 * so the caller can PIN the actual TCP connection to that exact address
 * (see `fetch-broker-page.ts`) instead of letting `fetch` re-resolve.
 * `isSafeExternalUrl` remains as a boolean convenience wrapper for callers
 * that only need the yes/no answer and do not perform the actual fetch
 * themselves.
 */

const PRIVATE_V4_RANGES: [string, number][] = [
  ["0.0.0.0", 8], // "this network" / unspecified — many systems treat as loopback-equivalent
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // RFC 6598 carrier-grade NAT — common inside cloud VPCs/containers
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local — also covers cloud metadata (169.254.169.254)
];

function isPrivateIPv4(ip: string): boolean {
  const ipNum = ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const baseNum = base.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipNum & mask) === (baseNum & mask);
  });
}

/**
 * Classifies an IPv6 address as unsafe (BL-1). Unwraps IPv4-mapped
 * (`::ffff:a.b.c.d` and the hex form `::ffff:HHHH:HHHH`) and IPv4-compatible
 * (`::a.b.c.d`) addresses back through `isPrivateIPv4` so an embedded internal
 * v4 target cannot slip past as "public IPv6"; also rejects `::1`, `::`, the
 * whole `fe80::/10` link-local block, and `fc00::/7` unique-local.
 */
function isUnsafeIPv6(address: string): boolean {
  const addr = address.toLowerCase().split("%")[0]; // strip any zone index (fe80::1%eth0)

  // IPv4-mapped/compatible with a dotted-quad tail: re-classify the embedded v4.
  const dotted = addr.match(/^(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return isPrivateIPv4(dotted[1]);

  // IPv4-mapped with a hex tail (::ffff:a9fe:a9fe): reconstruct the v4 and classify.
  const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(v4);
  }

  if (addr === "::1" || addr === "::") return true; // loopback + unspecified
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true; // fc00::/7 unique-local
  return false;
}

function isUnsafeAddress(address: string, family: number): boolean {
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isUnsafeIPv6(address);
  return true; // Unknown family — fail closed.
}

export interface ResolvedSafeAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves `url`'s hostname exactly once and returns the validated address
 * (plus its family) IFF it is safe to connect to: a well-formed http(s) URL
 * whose hostname resolves to a public (non-private, non-loopback,
 * non-link-local) IP address. Returns `null` on any parse/protocol/DNS
 * failure (fail closed) — never throws.
 *
 * CR-01: this is the ONLY DNS resolution that should ever occur for a
 * broker-page fetch. The caller MUST connect to the exact `address`
 * returned here (e.g. via a pinned `undici.Agent` lookup override) rather
 * than calling `fetch(url)` and letting it re-resolve the hostname
 * independently — that second, unrelated resolution is what the
 * DNS-rebinding gap exploited.
 */
export async function resolveSafeExternalUrl(
  url: string,
): Promise<ResolvedSafeAddress | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  try {
    const { address, family } = await dns.lookup(parsed.hostname);
    if (isUnsafeAddress(address, family)) return null;
    return { address, family: family as 4 | 6 };
  } catch {
    return null; // DNS resolution failure — treat as unsafe, not "assume public".
  }
}

/**
 * Boolean convenience wrapper around `resolveSafeExternalUrl` for callers
 * that only need a yes/no safety answer and do NOT themselves perform the
 * outbound fetch (e.g. display-time validation). Any caller that DOES
 * perform the fetch must use `resolveSafeExternalUrl` directly and pin the
 * connection to the returned address — see the CR-01 note above.
 */
export async function isSafeExternalUrl(url: string): Promise<boolean> {
  return (await resolveSafeExternalUrl(url)) !== null;
}
