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
    // Phase 8 Plan 4: the first React-component tests in this repo (RTL render
    // of brf-confirm.tsx / brf-section.tsx) need a DOM. Each such test file
    // opts into jsdom via a `// @vitest-environment jsdom` docblock at the top
    // of the file (Vitest's per-file environment override) rather than
    // flipping the global default — every other test (actions/lib) stays on
    // the lighter "node" environment unchanged, avoiding any risk of
    // destabilizing the existing 384-test suite.
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      // Mirror the tsconfig `@/*` -> `./src/*` path alias so test imports like
      // `@/lib/brf/score` resolve the same way they do in production code.
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
