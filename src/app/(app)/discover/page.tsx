import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DiscoveryInput } from "@/components/discovery-input";

/**
 * `/discover` — the free-text discovery entry point (DISC-01).
 *
 * FIRST check: `DISCOVERY_ENABLED !== "true"` -> `notFound()`. This is
 * defense-in-depth on top of `startDiscovery`'s own literal-first-line flag
 * check (Plan 03) — a direct URL visit while the flag is off resolves the
 * SAME way a missing analysis resolves, never a "feature disabled" message
 * (avoids leaking that a hidden feature exists — 09-UI-SPEC.md Feature Flag
 * Contract).
 */
export default async function DiscoverPage() {
  if (process.env.DISCOVERY_ENABLED !== "true") {
    notFound();
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    notFound();
  }

  return (
    <div className="flex flex-col items-center gap-8">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-semibold text-warm-gray-900">
          Sök efter drömbostad
        </h1>
        <p className="mt-1 text-warm-gray-500">
          Beskriv vad du letar efter — vi söker igenom aktuella annonser åt
          dig.
        </p>
      </div>
      <DiscoveryInput />
    </div>
  );
}
