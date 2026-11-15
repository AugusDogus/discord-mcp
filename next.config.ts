import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image (docs/self-hosting.md) runs the traced standalone server.
  output: "standalone",
  // Loaded from node_modules at runtime: bundled, ws loses its optional native
  // helpers and Discord's gateways close before the handshake.
  serverExternalPackages: ["ws"],
  cacheComponents: true,
  partialPrefetching: true,
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
