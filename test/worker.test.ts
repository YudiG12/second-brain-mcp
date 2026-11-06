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

  it("no longer serves the GitHub webhook (ADR 007; closes #42 by removal)", async () => {
    const res = await exports.default.fetch("https://example.com/test-token/github-webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha256=", "X-GitHub-Event": "push" },
      body: "{}",
    });
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(202);
  });
});

// Calls an MCP tool over the Streamable HTTP endpoint and returns its text.
async function callTool(name: string, args: Record<string, unknown>) {
  const res = await exports.default.fetch("https://example.com/test-token/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? body;
  return JSON.stringify(JSON.parse(data));
}

describe("read_note path rules (#30)", () => {
  it.each(["../x.md", "a/../../b.md", "notes.txt", "a//b.md"])("refuses %j before touching storage", async (path) => {
    expect(await callTool("read_note", { path })).toMatch(/Invalid path/);
  });
});

describe("admin routes", () => {
  it.each([undefined, "Bearer wrong", "test-admin"])("hide /admin/artifacts-token without the admin secret (%s)", async (auth) => {
    const res = await exports.default.fetch("https://example.com/admin/artifacts-token", {
      method: "POST",
      headers: auth ? { Authorization: auth } : {},
    });
    expect(res.status).toBe(404);
  });
});
