import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["longport"],
  // Inline this flag so Vercel builds eliminate the scheduler import entirely.
  env: { ATLAS_SELF_HOSTED: process.env.VERCEL === "1" ? "false" : "true" },
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "./backups/**/*", "./.env*"],
  },
  poweredByHeader: false,
  devIndicators: false,
  logging: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
