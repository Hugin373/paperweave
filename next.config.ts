import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Self-contained server bundle for the Docker image.
  output: "standalone",
  poweredByHeader: false,
  // pdf.js (server-side text extraction), its native canvas (page images) and the local embedding model
  // runtime must not be bundled.
  serverExternalPackages: ["unpdf", "@napi-rs/canvas", "@huggingface/transformers", "onnxruntime-node", "sharp"],
  // The container runs `node scripts/migrate.mjs` before starting; make sure the migrator ships.
  outputFileTracingIncludes: {
    "/api/health": ["./node_modules/drizzle-orm/**/*", "./node_modules/postgres/**/*", "./drizzle/**/*"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
