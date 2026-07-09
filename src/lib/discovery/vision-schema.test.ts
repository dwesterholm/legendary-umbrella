import { describe, it, expect } from "vitest";
import {
  preFilterSchema,
  visionDeepPassSchema,
  visionResultSchema,
  VISION_CONFIDENCE_THRESHOLD,
} from "@/lib/discovery/vision-schema";

/**
 * Walks a Zod object schema's shape recursively, collecting a flat list of
 * `{ path, def }` leaf descriptors — used below to statically assert the
 * "no more than 3 nullable leaves, zero numeric-constraint chains" shape
 * discipline (11-RESEARCH.md Pitfall 3 / project memory
 * `anthropic-structured-output-limits`). Mocked/parse tests alone would NOT
 * catch this class of bug — only a live API smoke (Plan 02's job) or this
 * kind of static shape assertion does.
 */
function collectLeaves(
  schema: unknown,
  path: string[] = [],
  out: { path: string; schema: unknown }[] = [],
): { path: string; schema: unknown }[] {
  const def = (schema as { def?: { type?: string; shape?: Record<string, unknown> } })
    ?.def;
  if (def?.type === "object" && def.shape) {
    for (const [key, value] of Object.entries(def.shape)) {
      collectLeaves(value, [...path, key], out);
    }
    return out;
  }
  out.push({ path: path.join("."), schema });
  return out;
}

/** True when a Zod schema node is (or wraps) a `.nullable()`. */
function isNullable(schema: unknown): boolean {
  const def = (schema as { def?: { type?: string } })?.def;
  return def?.type === "nullable";
}

/** True when a Zod number schema carries a min/max/int check (the 400-trap shape). */
function hasNumericConstraint(schema: unknown): boolean {
  const def = (schema as { def?: { type?: string; checks?: unknown[] } })?.def;
  if (def?.type !== "number") return false;
  return Array.isArray(def.checks) && def.checks.length > 0;
}

describe("visionDeepPassSchema — slim single-nullable-leaf discipline (400-trap guard)", () => {
  it("has exactly 4 top-level attribute fields (kitchen/bathroom/overall/remodelPotential)", () => {
    const shape = (visionDeepPassSchema as unknown as { def: { shape: Record<string, unknown> } })
      .def.shape;
    expect(Object.keys(shape).sort()).toEqual([
      "bathroom",
      "kitchen",
      "overall",
      "remodelPotential",
    ]);
  });

  it("has at most 4 nullable leaf fields total", () => {
    const leaves = collectLeaves(visionDeepPassSchema);
    const nullableLeaves = leaves.filter((l) => isNullable(l.schema));
    expect(nullableLeaves.length).toBeLessThanOrEqual(4);
    expect(nullableLeaves.map((l) => l.path).sort()).toEqual([
      "bathroom.claim",
      "kitchen.claim",
      "overall.claim",
      "remodelPotential.claim",
    ]);
  });

  it("has zero numeric .min()/.max()/.int() constraint chains anywhere", () => {
    const leaves = collectLeaves(visionDeepPassSchema);
    const constrained = leaves.filter((l) => hasNumericConstraint(l.schema));
    expect(constrained).toEqual([]);
  });

  it("parses a well-formed deep-pass response for all 4 attributes", () => {
    const result = visionDeepPassSchema.safeParse({
      kitchen: { claim: "Köket verkar renoverat", imageIndex: 1, whatWasSeen: "nya vitvaror", confidence: 0.8 },
      bathroom: { claim: null, imageIndex: 0, whatWasSeen: "", confidence: 0 },
      overall: { claim: "Allmänt skick verkar gott", imageIndex: 2, whatWasSeen: "nytt golv", confidence: 0.7 },
      remodelPotential: {
        claim: "Planlösningen antyder att en vägg eventuellt kan vara värt att undersöka — kräver konstruktör / väggutredning.",
        imageIndex: 3,
        whatWasSeen: "planritning med öppen planlösning mellan kök och vardagsrum",
        confidence: 0.65,
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("preFilterSchema — slim Haiku triage shape", () => {
  it("is a slim boolean-only shape with no nullable unions", () => {
    const leaves = collectLeaves(preFilterSchema);
    const nullableLeaves = leaves.filter((l) => isNullable(l.schema));
    expect(nullableLeaves).toEqual([]);
    expect(leaves.map((l) => l.path)).toEqual(["worthDeepPass"]);
  });

  it("parses a well-formed pre-filter response", () => {
    const result = preFilterSchema.safeParse({ worthDeepPass: true });
    expect(result.success).toBe(true);
  });
});

describe("visionResultSchema — persisted read-guard", () => {
  it("accepts a well-formed VisionResult", () => {
    const result = visionResultSchema.safeParse({
      claims: [
        {
          attribute: "kitchen",
          claim: "Köket verkar renoverat",
          imageIndex: 1,
          whatWasSeen: "nya vitvaror",
          confidence: 0.8,
        },
      ],
      imageUrlsUsed: ["https://bcdn.booli.se/img/1.jpg"],
      model: "claude-sonnet-4-6",
      costSek: 0.29,
      ranAt: "2026-07-07T12:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  it("accepts a well-formed VisionResult with a remodelPotential claim", () => {
    const result = visionResultSchema.safeParse({
      claims: [
        {
          attribute: "remodelPotential",
          claim:
            "Planlösningen antyder att en vägg eventuellt kan vara värt att undersöka. Kräver konstruktör / väggutredning.",
          imageIndex: 1,
          whatWasSeen: "planritning",
          confidence: 0.65,
        },
      ],
      imageUrlsUsed: ["https://bcdn.booli.se/img/1.jpg"],
      model: "claude-sonnet-4-6",
      costSek: 0.29,
      ranAt: "2026-07-07T12:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  it("accepts a VisionResult with an empty claims array (ran, nothing assessable)", () => {
    const result = visionResultSchema.safeParse({
      claims: [],
      imageUrlsUsed: ["https://bcdn.booli.se/img/1.jpg"],
      model: "claude-haiku-4-5-20251001",
      costSek: 0.08,
      ranAt: "2026-07-07T12:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a claim with a non-numeric imageIndex", () => {
    const result = visionResultSchema.safeParse({
      claims: [
        {
          attribute: "kitchen",
          claim: "Köket verkar renoverat",
          imageIndex: "1",
          whatWasSeen: "nya vitvaror",
          confidence: 0.8,
        },
      ],
      imageUrlsUsed: ["https://bcdn.booli.se/img/1.jpg"],
      model: "claude-sonnet-4-6",
      costSek: 0.29,
      ranAt: "2026-07-07T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});

describe("VISION_CONFIDENCE_THRESHOLD", () => {
  it("is 0.6, mirroring parseIntent's low-confidence fail-safe posture", () => {
    expect(VISION_CONFIDENCE_THRESHOLD).toBe(0.6);
  });
});
