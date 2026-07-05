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
  // src/lib/report/pdf/fonts.ts also reads .ttf files at runtime via an absolute
  // process.cwd() path (server-only PDF render). Same dynamic-read tracing gap as
  // the geojson — trace the fonts in so the production server bundle keeps them
  // (RESEARCH Pitfall 2); without this Font.register throws ENOENT in prod.
  outputFileTracingIncludes: {
    "/**": ["./src/data/deso.geojson", "./src/lib/report/pdf/fonts/*.ttf"],
  },
  experimental: {
    // BRF årsredovisning PDFs are uploaded through the `analyzeBrf` Server Action
    // as multipart FormData. Server Actions default to a 1 MB request-body cap,
    // which rejected any real PDF (>1 MB) with a framework-level 413 BEFORE the
    // action ran — making the client-/server-side 20 MB MAX_PDF_BYTES check
    // unreachable. Raise the limit above that 20 MB app cap, with headroom for
    // multipart boundary overhead. NOTE: platform limits still apply on top of
    // this — e.g. Vercel caps a serverless request body at ~4.5 MB regardless of
    // this setting; a production deploy there would need client-direct upload to
    // Supabase Storage (signed URL) instead of passing the file through the action.
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
