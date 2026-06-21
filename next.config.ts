import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // apify-client uses dynamic requires that Turbopack can't bundle --
  // load it from node_modules at runtime instead. @anthropic-ai/sdk is added
  // for the same reason (server-only PDF extraction in src/lib/brf/extract.ts).
  serverExternalPackages: ["apify-client", "@anthropic-ai/sdk"],
  // src/lib/market/geo.ts reads src/data/deso.geojson at runtime via fs (not a
  // bundler import — it's ~5 MB, server-only). A production build's file-tracing
  // would otherwise not see the dynamic read and could omit the artifact from the
  // server bundle → readFileSync throws → empty DeSO set → AREA panel null. Trace
  // it in explicitly so `next build`/`next start` ships it.
  outputFileTracingIncludes: {
    "/**": ["./src/data/deso.geojson"],
  },
};

export default nextConfig;
