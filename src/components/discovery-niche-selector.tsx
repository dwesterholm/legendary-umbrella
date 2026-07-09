"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { NicheId } from "@/lib/discovery/niches";

interface DiscoveryNicheSelectorProps {
  value: NicheId | "none";
  onChange: (next: NicheId | "none") => void;
}

/**
 * `DiscoveryNicheSelector` — the controlled Select for the 4 fixed niche
 * options (DISC-03). Selection state is OWNED BY THE PARENT
 * (`DiscoveryResults`) — this component has no internal `useState`, mirroring
 * the RESEARCH.md illustrative skeleton's controlled-component contract.
 *
 * Reuses the existing `Select` primitive (`src/components/ui/select.tsx`,
 * already installed in Phase 9) — no new shadcn component, no new registry
 * surface (10-UI-SPEC.md Design System discretion).
 *
 * Selecting an option is the "action" — there is no submit button, and
 * choosing a value fires `onChange` immediately so the parent can re-sort the
 * already-fetched candidates client-side (no Server Action, no network).
 */
export function DiscoveryNicheSelector({
  value,
  onChange,
}: DiscoveryNicheSelectorProps) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
        Sortera efter
      </span>
      <Select value={value} onValueChange={(next) => onChange(next as NicheId | "none")}>
        <SelectTrigger className="w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Ingen (som hittad)</SelectItem>
          <SelectItem value="renovation-upside">Renoveringspotential</SelectItem>
          <SelectItem value="turnkey">Inflyttningsklar</SelectItem>
          <SelectItem value="imminent-stambyte">
            Stambyte planerat — föreningen betalar
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
