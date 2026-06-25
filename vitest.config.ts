import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Default vitest globs match only *.test/*.spec — extend it to also pick up
    // the cost-gated eval harness (evals/*.eval.ts) so `npm run eval`
    // (`vitest run evals/extractor.eval.ts`) resolves the file. The eval body
    // self-skips without RUN_LLM_EVALS=1 + a live key, so it adds at most one
    // skipped test to `npm run test` — never any spend in CI.
    include: [
      "**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "evals/**/*.eval.?(c|m)[jt]s?(x)",
    ],
  },
  resolve: {
    alias: {
      // Mirror the tsconfig `@/*` -> `./src/*` path alias so test imports like
      // `@/lib/brf/score` resolve the same way they do in production code.
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
