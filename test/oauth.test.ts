import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

const BASE = "https://example.com";
const fetchWorker = (path: string, init?: RequestInit) => exports.default.fetch(`${BASE}${path}`, { redirect: "manual", ...init });

async function pkce() {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

async function register(redirectUri: string) {
  const res = await fetchWorker("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Test client", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

const authorizeUrl = (clientId: string, redirectUri: string, challenge: string) =>
  `/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "client-state", scope: "mcp", resource: `${BASE}/mcp` })}`;

const cookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

/** Runs consent and the redirect to GitHub; returns what the callback needs. */
async function startSignIn(redirectUri: string) {
  const clientId = await register(redirectUri);
  const { challenge } = await pkce();
  const page = await fetchWorker(authorizeUrl(clientId, redirectUri, challenge));
  const body = await page.text();
  const handle = body.match(/name="handle" value="([^"]+)"/)![1];
  const approve = await fetchWorker("/authorize", { method: "POST", headers: { Cookie: cookies(page), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, decision: "approve" }) });
  return { page, body, approve };
}

afterEach(() => vi.restoreAllMocks());

describe("OAuth discovery (ADR 011)", () => {
  it("answers /mcp without a token with 401 and a pointer to the resource metadata", async () => {
    const res = await fetchWorker("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("publishes the protected-resource and authorization-server metadata", async () => {
    const pr = (await (await fetchWorker("/.well-known/oauth-protected-resource/mcp")).json()) as any;
    expect(pr.resource).toBe(`${BASE}/mcp`);
    const as = (await (await fetchWorker("/.well-known/oauth-authorization-server")).json()) as any;
    expect(as.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(as.client_id_metadata_document_supported).toBe(true);
  });
});

describe("consent and sign-in", () => {
  it("refuses to send access anywhere but Claude, ChatGPT or this computer", async () => {
    const clientId = await register("https://evil.example/cb");
    const { challenge } = await pkce();
    const res = await fetchWorker(authorizeUrl(clientId, "https://evil.example/cb", challenge));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("evil.example");
  });

  it("shows a consent page naming where access goes, and can't be framed", async () => {
    const { page, body } = await startSignIn("https://claude.ai/api/mcp/auth_callback");
    expect(page.status).toBe(200);
    expect(body).toContain("<strong>claude.ai</strong>");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sends the owner to GitHub with PKCE and no scopes only after consent", async () => {
    const { approve } = await startSignIn("https://claude.ai/api/mcp/auth_callback");
    expect(approve.status).toBe(302);
    const gh = new URL(approve.headers.get("Location")!);
    expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(gh.searchParams.get("scope")).toBe("");
    expect(gh.searchParams.get("code_challenge_method")).toBe("S256");
    expect(gh.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
  });

  const githubAs = (id: number) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gh-token" });
      if (url.startsWith("https://api.github.com/user")) return Response.json({ id, login: "someone" });
      throw new Error(`unexpected fetch ${url}`);
    });

  async function finish(id: number) {
    const { approve } = await startSignIn("https://claude.ai/api/mcp/auth_callback");
    const state = new URL(approve.headers.get("Location")!).searchParams.get("state")!;
    githubAs(id);
    return fetchWorker(`/callback?code=gh-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookies(approve) } });
  }

  it("refuses any GitHub account but the owner's, without creating a grant", async () => {
    const res = await finish(7);
    expect(res.status).toBe(403);
  });

  it("completes for the owner and redirects back to the client with a code", async () => {
    const res = await finish(42);
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("Location")!);
    expect(back.origin).toBe("https://claude.ai");
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(back.searchParams.get("state")).toBe("client-state");
  });

  it("refuses a callback without the browser's binding cookie", async () => {
    const { approve } = await startSignIn("https://claude.ai/api/mcp/auth_callback");
    const state = new URL(approve.headers.get("Location")!).searchParams.get("state")!;
    githubAs(42);
    const res = await fetchWorker(`/callback?code=gh-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
  });
});
