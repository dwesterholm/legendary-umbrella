import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // apify-client uses dynamic requires that Turbopack can't bundle --
  // load it from node_modules at runtime instead. @anthropic-ai/sdk is added
  // for the same reason (server-only PDF extraction in src/lib/brf/extract.ts).
  serverExternalPackages: ["apify-client", "@anthropic-ai/sdk"],
};

export default nextConfig;
