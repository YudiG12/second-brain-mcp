import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// The Worker answers 404 to anything outside the secret prefix (ADR 004, spec v1 §2).
describe("routing", () => {
  it.each(["/", "/mcp", "/wrong-token/mcp", "/test-token"])("returns 404 for %s", async (path) => {
    const res = await exports.default.fetch(`https://example.com${path}`);
    expect(res.status).toBe(404);
  });

  it("rejects a webhook with a bad signature", async () => {
    const res = await exports.default.fetch("https://example.com/test-token/github-webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha256=00", "X-GitHub-Event": "push" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
