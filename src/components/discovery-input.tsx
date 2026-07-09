"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { startDiscovery } from "@/actions/start-discovery";
import type { DiscoveryFilter } from "@/lib/discovery/filter-schema";
import { AREA_SEED } from "@/lib/discovery/area-seed";

interface DiscoveryInputProps {
  /** Globally-tripped kill switch signal (from a server-resolved check). */
  killSwitchTripped?: boolean;
}

const AREA_OPTIONS = Object.keys(AREA_SEED);
const ROOM_OPTIONS = [1, 2, 3, 4, 5];

/**
 * `DiscoveryInput` — modeled on `UrlInput`'s `useTransition` + `FormData`
 * shell. Only the free-text field is required; the hard-filter row is
 * entirely optional (09-UI-SPEC.md Component Inventory #1).
 *
 * On a low-confidence parse (`needsConfirmation`), the parsed filter is
 * rendered inline with a "Stämmer detta?" confirm affordance rather than
 * silently proceeding — mirrors the ENRICH-02 confirmation pattern
 * (`BrfMatchConfirmation`).
 */
export function DiscoveryInput({ killSwitchTripped = false }: DiscoveryInputProps) {
  const [freeText, setFreeText] = useState("");
  const [area, setArea] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [roomsMin, setRoomsMin] = useState("");
  const [sizeMin, setSizeMin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<DiscoveryFilter | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function buildFormData(): FormData {
    const formData = new FormData();
    formData.set("free_text", freeText);
    if (area) formData.set("areaQuery", area);
    if (priceMax) formData.set("priceMax", priceMax);
    if (roomsMin) formData.set("roomsMin", roomsMin);
    if (sizeMin) formData.set("sizeMin", sizeMin);
    return formData;
  }

  function submit() {
    startTransition(async () => {
      const result = await startDiscovery(buildFormData());
      if (!result.ok) {
        if (result.needsConfirmation && result.filter) {
          setPendingConfirmation(result.filter);
          return;
        }
        setError(result.error);
        return;
      }
      setPendingConfirmation(null);
      router.push(`/discover/${result.jobId}`);
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!freeText.trim()) {
      setError("Beskriv vad du letar efter för att starta sökningen.");
      return;
    }

    submit();
  }

  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      <CardContent className="space-y-4">
        {killSwitchTripped && (
          <div className="rounded-lg bg-terracotta-50 px-4 py-3">
            <p className="text-sm text-terracotta-600">
              Områdessökning är tillfälligt otillgänglig. Prova att analysera
              en enskild annons via länk istället.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label
              htmlFor="free_text"
              className="text-xs font-medium uppercase tracking-wider text-warm-gray-500"
            >
              Vad letar du efter?
            </Label>
            <Textarea
              id="free_text"
              name="free_text"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder="Beskriv din drömbostad…"
              className="min-h-24 border-warm-gray-200 focus-visible:ring-sage-500"
              disabled={isPending || killSwitchTripped}
            />
          </div>

          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="space-y-2">
              <Label className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
                Område
              </Label>
              <Select value={area} onValueChange={setArea} disabled={isPending || killSwitchTripped}>
                <SelectTrigger className="w-full border-warm-gray-200">
                  <SelectValue placeholder="Valfritt" />
                </SelectTrigger>
                <SelectContent>
                  {AREA_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
                Prisintervall
              </Label>
              <Input
                type="number"
                inputMode="numeric"
                placeholder="Max SEK"
                value={priceMax}
                onChange={(e) => setPriceMax(e.target.value)}
                className="border-warm-gray-200 focus-visible:ring-sage-500"
                disabled={isPending || killSwitchTripped}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
                Antal rum
              </Label>
              <Select
                value={roomsMin}
                onValueChange={setRoomsMin}
                disabled={isPending || killSwitchTripped}
              >
                <SelectTrigger className="w-full border-warm-gray-200">
                  <SelectValue placeholder="Valfritt" />
                </SelectTrigger>
                <SelectContent>
                  {ROOM_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}+ rum
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
                Storlek (kvm)
              </Label>
              <Input
                type="number"
                inputMode="numeric"
                placeholder="Min kvm"
                value={sizeMin}
                onChange={(e) => setSizeMin(e.target.value)}
                className="border-warm-gray-200 focus-visible:ring-sage-500"
                disabled={isPending || killSwitchTripped}
              />
            </div>
          </div>

          {pendingConfirmation && (
            <div className="rounded-lg border border-warm-gray-200 bg-warm-gray-50 px-4 py-3 space-y-2">
              <p className="text-sm font-medium text-warm-gray-700">
                Stämmer detta?
              </p>
              <p className="text-sm text-warm-gray-600">
                Område: {pendingConfirmation.areaQuery || "---"} · Max pris:{" "}
                {pendingConfirmation.priceMax ?? "---"} · Min rum:{" "}
                {pendingConfirmation.roomsMin ?? "---"} · Min kvm:{" "}
                {pendingConfirmation.sizeMin ?? "---"}
              </p>
              <Button
                type="button"
                onClick={submit}
                disabled={isPending}
                className="bg-sage-600 text-white hover:bg-sage-700 h-11 px-6"
              >
                Ja, stämmer — starta sökning
              </Button>
            </div>
          )}

          {error && <p className="text-sm text-terracotta-600">{error}</p>}

          <Button
            type="submit"
            className="bg-sage-600 text-white hover:bg-sage-700 h-11 px-6"
            disabled={isPending || killSwitchTripped}
          >
            {isPending ? (
              <span className="flex items-center gap-2">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Startar...
              </span>
            ) : (
              "Starta sökning"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
