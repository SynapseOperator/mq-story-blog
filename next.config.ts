import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the reviewed project AGENTS.md stable during local development.
  agentRules: false,
  async headers() {
    return [{ source: "/admin/stories", headers: [
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
    ] }];
  },
  // Only existing public art/legacy synthetic assets may enter Next's shared
  // optimizer. Private administrator images are always served by guarded HTTP.
  images: { localPatterns: [
    { pathname: "/scene/**", search: "" }, { pathname: "/letter/**", search: "" },
    { pathname: "/story-media/**", search: "" },
  ] },
  outputFileTracingIncludes: {
    "/api/admin/media": ["./scripts/media/image-worker.mjs", "./node_modules/sharp/**/*", "./node_modules/@img/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
