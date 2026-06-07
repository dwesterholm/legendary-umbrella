import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
  },
  resolve: {
    alias: {
      // Mirror the tsconfig `@/*` -> `./src/*` path alias so test imports like
      // `@/lib/brf/score` resolve the same way they do in production code.
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
