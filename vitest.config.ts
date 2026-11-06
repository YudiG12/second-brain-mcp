import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd, the Workers runtime, with local bindings (Miniflare).
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: { bindings: { MCP_TOKEN: "test-token", GITHUB_TOKEN: "unused", WEBHOOK_SECRET: "test-secret" } },
    }),
  ],
});
