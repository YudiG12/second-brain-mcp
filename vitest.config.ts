import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd, the Workers runtime, with local bindings (Miniflare).
// The Worker is configured here instead of from wrangler.jsonc, so tests never load
// real secrets from .dev.vars and never get bindings that reach remote resources
// (AI, Vectorize). Integration tests add stubs for those explicitly.
export default defineConfig({
  test: {
    includeTaskLocation: true, // lets the PR report link each test to its line
    // In CI: GitHub annotations and job summary, a JSON report for the PR comment, and the
    // Vitest UI as a static site (reports/html) published per PR.
    reporters: (globalThis as any).process?.env.GITHUB_ACTIONS
      ? ["default", "github-actions", ["json", { outputFile: "reports/tests.json" }], ["html", { outputFile: "reports/html/index.html" }]]
      : ["default"],
  },
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      config: false,
      miniflare: {
        compatibilityDate: "2026-06-11",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { MCP_TOKEN: "test-token", ADMIN_SECRET: "test-admin", NOTES_REPO: "notes" },
      },
    }),
  ],
});
