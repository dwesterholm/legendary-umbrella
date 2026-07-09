import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * `createServiceRoleClient` — a service-role-key Supabase client that
 * BYPASSES RLS entirely (CR-02, 09-REVIEW.md).
 *
 * This is intentionally NOT `server.ts`'s cookie-bound anon-key client: it
 * carries no user session and is authorized purely by
 * `SUPABASE_SERVICE_ROLE_KEY`. Use it ONLY for genuinely trusted,
 * server-only, cross-user paths that have their OWN independent
 * authorization gate before this client is ever constructed — currently
 * that is exactly one call site, `/api/discovery/sweep`'s Vercel Cron
 * route, which verifies `CRON_SECRET` as its literal first action before
 * this client is created. Never construct this client in a path reachable
 * by a plain user request (Server Action, page, or any route without an
 * equivalent secret/role check) — doing so would silently defeat every RLS
 * policy in the project for that request.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` must be set in the deployment environment
 * (Vercel project env vars) for the sweep to function; it is never read
 * client-side and must never be prefixed `NEXT_PUBLIC_`.
 */
export function createServiceRoleClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — the service-role client cannot be constructed.",
    );
  }

  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
