"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { analyzeBrf, type AnalyzeBrfResult } from "@/actions/analyze-brf";

interface BrfUploadProps {
  analysisId: string;
  /** Called when the upload kicks off so the parent can switch to progress. */
  onStarted?: () => void;
  /**
   * Called when the server action returns an error. The parent switches to
   * "progress" on onStarted and unmounts this component, so a local setError
   * would be invisible — the parent must own failure display.
   */
  onFailed?: (error: string) => void;
  /** Optional broker listing URL — a non-blocking deep-link to find the PDF (D-02). */
  agencyListingUrl?: string;
}

/** Client-side mirror of the server limit (D-14, ASVS V5 — UX fast-fail only). */
const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * `BrfUpload` — the login-gated PDF dropzone (D-05 gate is enforced server-side
 * in {@link analyzeBrf}; this component is only rendered for logged-in users by
 * `BrfSection`). Adapts `url-input.tsx`: client validation, FormData, a
 * `startTransition` server-action call, errors in `text-terracotta-600`.
 *
 * Guided manual upload is the locked acquisition path (D-01/D-02) — there is no
 * free API for BRF årsredovisningar today, so we help the user find the PDF on
 * the broker's page rather than scrape it (auto-fetch is the v2 path, D-03).
 */
export function BrfUpload({
  analysisId,
  onStarted,
  onFailed,
  agencyListingUrl,
}: BrfUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  /** Client validation before any submit (D-14). Returns null if valid. */
  function validate(f: File): string | null {
    if (f.type !== "application/pdf") {
      return "Endast PDF-filer stods";
    }
    if (f.size > MAX_PDF_BYTES) {
      return "Filen ar for stor - max 20 MB";
    }
    return null;
  }

  function selectFile(f: File | null | undefined) {
    setError(null);
    if (!f) return;
    const validationError = validate(f);
    if (validationError) {
      setError(validationError);
      setFile(null);
      return;
    }
    setFile(f);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!file) {
      setError("Valj en PDF-fil forst");
      return;
    }
    // Re-validate at submit time (defence in depth — the server re-checks too).
    const validationError = validate(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    onStarted?.();

    startTransition(async () => {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("analysisId", analysisId);

      const result: AnalyzeBrfResult = await analyzeBrf(formData);
      if (!result.ok) {
        // Hand the error to the parent — this component has been unmounted by the
        // onStarted view switch, so a local setError would never render.
        setError(result.error);
        onFailed?.(result.error);
      }
    });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    selectFile(e.dataTransfer.files?.[0]);
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl space-y-4">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          isDragging
            ? "border-sage-500 bg-sage-50"
            : "border-warm-gray-200 bg-warm-gray-50 hover:border-sage-400"
        }`}
      >
        <span className="text-sm font-medium text-warm-gray-700">
          {file ? file.name : "Slapp arsredovisningen har eller klicka for att valja"}
        </span>
        <span className="text-xs text-warm-gray-500">PDF, max 20 MB</span>
        <input
          ref={inputRef}
          type="file"
          name="file"
          accept="application/pdf"
          className="hidden"
          disabled={isPending}
          onChange={(e) => selectFile(e.target.files?.[0])}
        />
      </button>

      <p className="text-xs text-warm-gray-500">
        Hitta arsredovisningen pa maklarens sida (vanligast).
        {agencyListingUrl && (
          <>
            {" "}
            <a
              href={agencyListingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sage-700 underline hover:text-sage-800"
            >
              Oppna maklarens sida
            </a>
          </>
        )}
      </p>

      <Button
        type="submit"
        className="bg-sage-600 text-white hover:bg-sage-700 h-11 px-6"
        disabled={isPending || !file}
      >
        {isPending ? (
          <span className="flex items-center gap-2">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            Analyserar...
          </span>
        ) : (
          "Analysera BRF"
        )}
      </Button>

      {error && <p className="text-sm text-terracotta-600">{error}</p>}
    </form>
  );
}
