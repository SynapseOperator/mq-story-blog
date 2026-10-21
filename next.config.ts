import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the reviewed project AGENTS.md stable during local development.
  agentRules: false,
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
