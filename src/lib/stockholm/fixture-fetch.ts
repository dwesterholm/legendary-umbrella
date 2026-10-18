/**
 * fixture-fetch.ts - a `fetch` stand-in that serves saved city pages by URL shape (Phase 14.6), for tests and for a
 * `--dry-run` of the scripts. It never opens a socket. Every request it receives is recorded, so a test can assert
 * the exact URL, method and headers the client sent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureRoute {
  /** Request path, compared case-insensitively. */
  path: string;
  /** When set, the query must carry this key (and the value, when `queryValue` is set too). */
  queryKey?: string;
  queryValue?: string;
  /** A file name inside the fixture directory (served as the body). */
  file?: string;
  /** A literal body (used when there is no `file`). */
  body?: string;
  /** Default 200. */
  status?: number;
  /** Default "text/html; charset=utf-8". */
  contentType?: string | null;
  /** Extra response headers (for example content-length). */
  headers?: Record<string, string>;
  /** Make fetch reject with this error instead of answering (a network failure, a refused redirect). */
  rejectWith?: Error;
  /** How many times the route may answer; after that the next matching route is used. Default unlimited. */
  times?: number;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
}

export type FixtureFetch = ((url: string, init?: RequestInit) => Promise<Response>) & {
  /** Every request received, in order. */
  requests: RecordedRequest[];
};

/** An answer for an unmatched request: 404, so a test that forgot a route fails loudly on the status. */
const NOT_FOUND = "<html><body>no fixture route</body></html>";

export function makeFixtureFetch(dir: string, routes: readonly FixtureRoute[]): FixtureFetch {
  const used = new Map<FixtureRoute, number>();
  const requests: RecordedRequest[] = [];

  const matches = (route: FixtureRoute, url: URL): boolean => {
    if (url.pathname.toLowerCase() !== route.path.toLowerCase()) return false;
    if (route.queryKey === undefined) return true;
    const value = url.searchParams.get(route.queryKey);
    if (value === null) return false;
    return route.queryValue === undefined || value === route.queryValue;
  };

  const fn = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url: input, method: init.method ?? "GET", headers, redirect: init.redirect });

    const route = routes.find((r) => matches(r, url) && (used.get(r) ?? 0) < (r.times ?? Number.POSITIVE_INFINITY));
    if (route === undefined) return new Response(NOT_FOUND, { status: 404, headers: { "content-type": "text/html" } });
    used.set(route, (used.get(route) ?? 0) + 1);
    if (route.rejectWith !== undefined) throw route.rejectWith;

    const body = route.file !== undefined ? readFileSync(join(dir, route.file), "utf8") : (route.body ?? "");
    const responseHeaders: Record<string, string> = { ...(route.headers ?? {}) };
    if (route.contentType !== null) responseHeaders["content-type"] = route.contentType ?? "text/html; charset=utf-8";
    return new Response(body, { status: route.status ?? 200, headers: responseHeaders });
  };

  return Object.assign(fn, { requests });
}
