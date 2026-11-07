// Sign-in for MCP clients (ADR 011): the Worker is the OAuth 2.1 authorization server, and the
// owner proves who they are with "Sign in with GitHub". Only one GitHub account, by numeric id,
// can complete it. A consent page comes first and shows where access will be sent, because any
// client can register itself (confused deputy: MCP security best practices).
import { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type AuthEnv = {
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OWNER_GITHUB_ID: string;
};

/**
 * Where access may be sent: the MCP connector callbacks of Claude and ChatGPT (exact paths, since
 * other things on those hosts, like custom GPT actions, have callbacks too), and local apps such
 * as Claude Code (any loopback port and path, per RFC 8252).
 */
export const ALLOWED_REDIRECT_PREFIXES = ["https://claude.ai/api/mcp/", "https://claude.com/api/mcp/", "https://chatgpt.com/connector_platform_oauth_redirect", "https://chat.openai.com/connector_platform_oauth_redirect"];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function redirectAllowed(uri: string) {
  const u = new URL(uri);
  if (LOOPBACK.has(u.hostname)) return true;
  return ALLOWED_REDIRECT_PREFIXES.some((p) => `${u.origin}${u.pathname}`.startsWith(p));
}

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body: string, headers: Headers, status = 200) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.5rem 1rem;margin-right:.5rem}</style>${body}`, { status, headers });
};
const plain = (message: string, status = 400) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

function consentPage(d: ConsentDescription, handle: string) {
  const who = d.clientDomain ? `Published by <strong>${escape(d.clientDomain)}</strong>.` : "This app registered itself; its name is not verified.";
  return `<title>Connect ${escape(d.clientName)}</title>
<h1>Connect ${escape(d.clientName)} to your second brain?</h1>
<p>${who} Access to your notes will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on this computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<p>Next, you'll sign in with GitHub to prove it's you.</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Continue with GitHub</button><button name="decision" value="deny">Cancel</button></form>`;
}

async function s256(verifier: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** GET /authorize shows the consent page; POST /authorize sends the owner to GitHub. */
export async function authorize(req: Request, env: AuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      if (!redirectAllowed(request.redirectUri)) {
        console.warn(JSON.stringify({ auth: "redirect refused", redirectUri: request.redirectUri, clientId: request.clientId }));
        return plain(`This server only connects to Claude, ChatGPT or apps on this computer, not ${new URL(request.redirectUri).host}.`, 403);
      }
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      return html(consentPage(details, consent.handle), consent.headers);
    }
    if (req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(req, handle); // never remembered: consent every time
      const verifier = crypto.randomUUID() + crypto.randomUUID();
      const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      const gh = new URL("https://github.com/login/oauth/authorize");
      gh.search = new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        redirect_uri: new URL("/callback", req.url).toString(),
        state,
        scope: "", // identity only: no access to repositories or anything else
        code_challenge: await s256(verifier),
        code_challenge_method: "S256",
        allow_signup: "false",
      }).toString();
      headers.set("Location", gh.toString());
      return new Response(null, { status: 302, headers });
    }
    return plain("Method not allowed", 405);
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError) return plain(e.description ?? "Invalid authorization request");
    if (e instanceof CimdFetchError) return plain("This app could not be verified (its metadata document couldn't be fetched).");
    throw e;
  }
}

/** GET /callback: GitHub sends the owner back. Only the owner's account completes the grant. */
export async function callback(req: Request, env: AuthEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  let started;
  try {
    // refused without the state's binding cookie, so a GitHub code can't be replayed in another browser
    started = await oauth.finishUpstream<{ verifier: string }>(req);
  } catch (e) {
    if (e instanceof AuthorizationError) return plain("This sign-in link expired or was opened in another browser. Start again from your app.", 400);
    throw e;
  }
  const { request, data, headers } = started;
  const params = new URL(req.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    // cancelled or failed at GitHub: tell the client, which shows its own message
    headers.set("Location", authorizationErrorRedirect(request, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const json = async <T>(r: Response): Promise<T | null> => (r.ok ? ((await r.json().catch(() => null)) as T | null) : null);

  const token = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: new URL("/callback", req.url).toString(), code_verifier: data.verifier }),
  }).then((r) => json<{ access_token?: string; error?: string }>(r));
  if (!token?.access_token) return plain(`GitHub sign-in failed (${token?.error ?? "no token"}). Start again from your app.`, 400);

  const user = await fetcher("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "second-brain-mcp" },
  }).then((r) => json<{ id: number; login: string }>(r));
  // the GitHub token is used only for this check and never stored or logged
  if (!user) return plain("Couldn't read your GitHub account. Start again from your app.", 502);
  if (String(user.id) !== env.OWNER_GITHUB_ID) {
    console.warn(JSON.stringify({ auth: "refused", githubId: user?.id ?? null }));
    return plain("This second brain belongs to someone else.", 403);
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: request.scope,
    props: { githubId: String(user.id) },
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}
