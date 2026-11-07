import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { accessToken, callTool } from "./helpers/oauth";

// Unknown routes are 404; /mcp needs an OAuth token.
describe("routing", () => {
  it.each(["/", "/wrong-token/mcp", "/test-token", "/test-token/mcp", "/test-token/reindex"])("returns 404 for %s (the token-in-URL route is gone, #52)", async (path) => {
    const res = await exports.default.fetch(`https://example.com${path}`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("answers /mcp without a token with 401", async () => {
    expect((await exports.default.fetch("https://example.com/mcp", { method: "POST" })).status).toBe(401);
  });
});

describe("read_note path rules (#30)", () => {
  let token = "";
  beforeAll(async () => {
    token = await accessToken();
  });
  // There is no ARTIFACTS binding in tests: reaching storage would fail with a TypeError, not "Invalid path".
  it.each(["../x.md", "a/../../b.md", "notes.txt", "a//b.md", "/x.md"])("refuses %j before touching storage", async (path) => {
    expect(await callTool(token, "read_note", { path })).toMatch(/Invalid path/);
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
