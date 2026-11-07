# Security

## Access model

- **OAuth 2.1** through [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). Clients register by CIMD or dynamic registration; tokens are stored hashed in KV. Access tokens last 1 hour; refresh tokens expire after 30 days unused.
- **GitHub only proves identity:** the sign-in asks for no scopes, and only `OWNER_GITHUB_ID` gets a grant.
- **Redirect allowlist:** only the Claude and ChatGPT connector callbacks and loopback (for local apps). Anything else gets `403` and is logged.
- **Revocation:** `GET /admin/grants` lists grants; `DELETE /admin/grants/<id>` revokes one. Both need the admin secret.
- **Secrets** live only in Worker secrets, a git-ignored `.dev.vars`, and the macOS Keychain (the hook secret, which can only issue short-lived Artifacts tokens).

What it does not do yet: authorization per note. Anyone who signs in sees every note ([ADR 011](docs/adr/011-oauth-with-github-login.md)).

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/YudiG12/second-brain-mcp/security/advisories/new) instead of a public issue.
