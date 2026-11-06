import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// The Worker answers 404 to anything outside the secret prefix (ADR 004, spec v1 §2).
describe("routing", () => {
  it.each(["/", "/mcp", "/wrong-token/mcp", "/test-token"])("returns 404 for %s", async (path) => {
    const res = await exports.default.fetch(`https://example.com${path}`);
    expect(res.status).toBe(404);
  });

  it("passes requests under the secret prefix to the MCP handler", async () => {
    const res = await exports.default.fetch("https://example.com/test-token/mcp");
    expect(res.status).not.toBe(404);
  });

  it("rejects a webhook with a bad signature", async () => {
    const res = await exports.default.fetch("https://example.com/test-token/github-webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha256=00", "X-GitHub-Event": "push" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a webhook with no signature header", async () => {
    const res = await exports.default.fetch("https://example.com/test-token/github-webhook", {
      method: "POST",
      headers: { "X-GitHub-Event": "push" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  // Malformed signatures (empty or odd length) crash the hex parser and return 500. Issue #42.
  it.fails.each(["sha256=", "sha256=0"])("rejects a malformed signature %j with 401", async (sig) => {
    const res = await exports.default.fetch("https://example.com/test-token/github-webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "push" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
