// Signs in through the real OAuth flow (GitHub mocked) and returns an access token for /mcp.
import { exports } from "cloudflare:workers";
import { vi } from "vitest";

const BASE = "https://example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const fetchWorker = (path: string, init?: RequestInit) => exports.default.fetch(`${BASE}${path}`, { redirect: "manual", ...init });
const cookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

export async function accessToken(): Promise<string> {
  const reg = await fetchWorker("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const page = await fetchWorker(`/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s", scope: "mcp", resource: `${BASE}/mcp` })}`);
  const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1];
  const approve = await fetchWorker("/authorize", { method: "POST", headers: { Cookie: cookies(page), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, decision: "approve" }) });
  const state = new URL(approve.headers.get("Location")!).searchParams.get("state")!;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.includes("access_token") ? Response.json({ access_token: "gh" }) : Response.json({ id: 42, login: "owner" });
  });
  const back = await fetchWorker(`/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookies(approve) } });
  spy.mockRestore();
  const code = new URL(back.headers.get("Location")!).searchParams.get("code")!;
  const tok = await fetchWorker("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp` }) });
  return ((await tok.json()) as { access_token: string }).access_token;
}

/** Calls one MCP tool on /mcp with a Bearer token and returns its text. */
export async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetchWorker("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? body;
  return JSON.parse(data).result.content[0].text as string;
}
