import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd, the Workers runtime, with local bindings (Miniflare).
// The Worker is configured here instead of from wrangler.jsonc, so tests never load
// real secrets from .dev.vars and never get bindings that reach remote resources
// (AI, Vectorize). Integration tests add stubs for those explicitly.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      config: false,
      miniflare: {
        compatibilityDate: "2026-06-11",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { MCP_TOKEN: "test-token", GITHUB_TOKEN: "unused", WEBHOOK_SECRET: "test-secret" },
      },
    }),
  ],
});
