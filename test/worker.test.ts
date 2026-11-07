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

  it.each(["/test-token/reindex", "/test-token/anything"])("serves only /mcp under the token prefix (%s is 404)", async (path) => {
    const res = await exports.default.fetch(`https://example.com${path}`, { method: "POST" });
    expect(res.status).toBe(404);
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
  // There is no ARTIFACTS binding in tests: reaching storage would fail with a TypeError, not "Invalid path".
  it.each(["../x.md", "a/../../b.md", "notes.txt", "a//b.md", "/x.md"])("refuses %j before touching storage", async (path) => {
    expect(await callTool("read_note", { path })).toMatch(/Invalid path/);
  });
});

describe("admin routes", () => {
  it("lets the hook secret through to the Artifacts token route", async () => {
    // there's no ARTIFACTS binding in tests: getting past auth means reaching it and failing there
    const call = exports.default.fetch("https://example.com/hook/artifacts-token", { method: "POST", headers: { Authorization: "Bearer test-hook" } });
    await expect(call).rejects.toThrow(/reading 'get'/);
  });

  it("starts a rebuild with the admin secret and returns its instance id", async () => {
    const res = await exports.default.fetch("https://example.com/admin/reconcile?mode=rebuild", { method: "POST", headers: { Authorization: "Bearer test-admin" } });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; mode: string };
    expect(body.mode).toBe("rebuild");
    expect(body.id).toMatch(/^manual-rebuild-[0-9a-f-]{36}$/);
  });

  it.each([
    ["/hook/artifacts-token", undefined],
    ["/hook/artifacts-token", "Bearer wrong"],
    ["/hook/artifacts-token", "Bearer test-admin"], // the admin secret can't get Artifacts tokens (#39)
    ["/admin/artifacts-token", "Bearer test-admin"], // the old route is gone
    ["/admin/reconcile", "Bearer test-hook"], // the hook secret can't reach admin routes
    ["/admin/reconcile", undefined],
    ["/admin/reconcile", "Bearer wrong"],
  ])("hide %s without its own secret (%s)", async (route, auth) => {
    const res = await exports.default.fetch(`https://example.com${route}`, {
      method: "POST",
      headers: auth ? { Authorization: auth } : {},
    });
    expect(res.status).toBe(404);
  });
});
