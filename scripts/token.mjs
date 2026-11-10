#!/usr/bin/env node
// Gets an OAuth access token for /mcp through the real sign-in flow, for scripts like measure.py.
// Approve once: the client id and refresh token stay in the macOS Keychain (service "second-brain-cli").
// Later runs reuse the access token while it lasts (1 h) or refresh it (grant lives 30 days without use),
// and open the browser only when both fail. Prints ONLY the token on stdout, so it can go into a variable:
//   export ACCESS_TOKEN=$(node scripts/token.mjs) && python3 scripts/measure.py 10
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";

const BASE = process.env.SECOND_BRAIN_URL || execFileSync("node", ["scripts/config.mjs", "PUBLIC_URL"], { encoding: "utf8" }).trim();
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const log = (m) => process.stderr.write(m + "\n");

const KC = "second-brain-cli";
const kcRead = () => { try { return JSON.parse(execFileSync("security", ["find-generic-password", "-s", KC, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return null; } };
const kcWrite = (v) => execFileSync("security", ["add-generic-password", "-U", "-s", KC, "-a", process.env.USER || "me", "-w", JSON.stringify(v)]);
const save = (client_id, t) => kcWrite({ base: BASE, client_id, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 });

const saved = kcRead();
if (saved && saved.base === BASE) {
  if (saved.expires_at - Date.now() > 10 * 60_000) { process.stdout.write(saved.access_token); log("Reused the saved token."); process.exit(0); }
  if (saved.refresh_token) {
    const r = await fetch(`${BASE}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refresh_token, client_id: saved.client_id }) });
    if (r.ok) { const t = await r.json(); save(saved.client_id, { refresh_token: saved.refresh_token, ...t }); process.stdout.write(t.access_token); log("Refreshed the token, no browser needed."); process.exit(0); }
    log(`Refresh failed (${r.status}); signing in again.`);
  }
}

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const redirect = `http://127.0.0.1:${server.address().port}/callback`;

const reg = await fetch(`${BASE}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "measure script", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
const { client_id } = await reg.json();

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));
const url = `${BASE}/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, scope: "mcp", resource: `${BASE}/mcp` })}`;

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no sign-in after 3 minutes")), 180_000);
  server.on("request", (req, res) => {
    const u = new URL(req.url, redirect);
    if (u.pathname !== "/callback") return res.writeHead(404).end();
    const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(ok ? "Signed in. You can close this tab." : "Sign-in failed.");
    clearTimeout(timer);
    ok ? resolve(u.searchParams.get("code")) : reject(new Error(`callback without a valid code: ${u.searchParams.get("error") ?? "state mismatch"}`));
  });
  log("Opening the browser to approve and sign in with GitHub...");
  execFile("open", [url]);
});
server.close();

const tok = await fetch(`${BASE}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: verifier, resource: `${BASE}/mcp` }) });
if (!tok.ok) throw new Error(`token exchange failed: ${tok.status} ${await tok.text()}`);
const t = await tok.json();
save(client_id, t);
process.stdout.write(t.access_token);
log("Got a token and saved it in the Keychain.");
