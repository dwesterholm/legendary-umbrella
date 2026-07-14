"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { analyzeUrl, type AnalyzeResult } from "@/actions/analyze";
import type { ListingData } from "@/lib/schemas/listing";

interface UrlInputProps {
  onResult?: (
    data: ListingData,
    partial: boolean,
    missingFields?: string[],
    brokerFetchFailed?: boolean
  ) => void;
  onLoadingChange?: (loading: boolean) => void;
}

export function UrlInput({ onResult, onLoadingChange }: UrlInputProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side validation
    if (!url.includes("booli.se")) {
      setError("Ange en giltig Booli-lank");
      return;
    }

    onLoadingChange?.(true);

    startTransition(async () => {
      const formData = new FormData();
      formData.set("url", url);

      let result: AnalyzeResult;
      try {
        result = await analyzeUrl(formData);
      } catch {
        // redirect() throws NEXT_REDIRECT -- this is expected behavior
        // for authenticated users being redirected to /analysis/[id]
        onLoadingChange?.(false);
        return;
      }

      onLoadingChange?.(false);

      if (result.error) {
        setError(result.error);
        return;
      }

      if (result.data) {
        onResult?.(
          result.data,
          result.partial ?? false,
          result.missingFields,
          result.brokerFetchFailed
        );
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-xl space-y-3">
      <div className="flex gap-3">
        <Input
          type="url"
          name="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Klistra in en Booli-lank..."
          className="flex-1 border-warm-gray-200 focus-visible:ring-sage-500 h-11"
          disabled={isPending}
          required
        />
        <Button
          type="submit"
          className="bg-sage-600 text-white hover:bg-sage-700 h-11 px-6"
          disabled={isPending}
        >
          {isPending ? (
            <span className="flex items-center gap-2">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Analyserar...
            </span>
          ) : (
            "Analysera"
          )}
        </Button>
      </div>
      {error && (
        <p className="text-sm text-terracotta-600">{error}</p>
      )}
    </form>
  );
}
