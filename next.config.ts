import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // apify-client uses dynamic requires that Turbopack can't bundle --
  // load it from node_modules at runtime instead
  serverExternalPackages: ["apify-client"],
};

export default nextConfig;
