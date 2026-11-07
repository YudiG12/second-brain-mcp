# ADR 011: OAuth for MCP clients, with GitHub as the login

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |
| **Supersedes** | [ADR 004](004-secret-token-in-the-url.md) |

## Context

In v1 every MCP client connects with one secret token in the URL ([ADR 004](004-secret-token-in-the-url.md)). Whoever sees the URL can connect any client; every client shares the same credential, so they can't be told apart in logs; and the token never expires. Revoking one client means rotating the token and reconnecting all of them ([#12](https://github.com/YudiG12/second-brain-mcp/issues/12)).

The MCP specification defines OAuth 2.1 for remote servers, and the clients used here (Claude on the web and phone, Claude Code, and ChatGPT where the plan allows custom connectors) support it. Clients identify themselves through a client metadata document (CIMD, preferred by the current MCP specification) or dynamic client registration (DCR, older and still common). The server needs someone to answer "is this person the owner?", which means picking a login provider.

## Decision

- **The Worker becomes an OAuth 2.1 authorization server** using Cloudflare's `workers-oauth-provider` (pinned 1.x; earlier versions had redirect-URI and PKCE advisories). It handles client identification (CIMD, with DCR kept for compatibility), authorization codes with PKCE, and access and refresh tokens, stored in a KV namespace (tokens, codes and secrets hashed; grant properties encrypted). One Worker serves both the OAuth endpoints and the MCP endpoint, which the library supports; splitting them is not worth it for one user.
- **A consent page comes before the login.** Anyone can register a client, so a malicious client could send the owner an authorization link with its own redirect address and, since GitHub doesn't ask again after the first approval, receive a valid code. To stop that, every authorization first shows the owner a consent page with the client's name and **redirect host**, with `state` bound to the browser, and consent is never remembered across clients. New clients are also limited to known redirect hosts (claude.ai, chatgpt.com and loopback for Claude Code).
- **The login is "Sign in with GitHub", for one user.** In the GitHub callback, the Worker reads the numeric user id from `GET /user` (not the username, which can change) and compares it with the owner's **before** completing the authorization, so no grant is ever created for anyone else. It requests no GitHub scopes and doesn't keep the GitHub token.
- **Each client gets its own grant**, with a 1-hour access token renewed by a refresh token. The grant expires after 30 days of inactivity (an idle limit, so clients in regular use don't have to log in again every month). Claude on the web and on the phone share one connector, and its tokens live on Anthropic's servers, not on the device (the same for ChatGPT): revoking that grant cuts off Claude everywhere, and a stolen phone is secured by signing out of the Claude account, not by OAuth alone.
- **Revocation:** an admin route lists and revokes grants. A daily job (the reconciliation schedule, [ADR 009](009-queue-for-indexing-workflow-for-reconciliation.md)) purges expired grants and orphans left by clients that registered again.
- **The client id and grant id are logged** with every write, so a change can be traced to the client that made it. Client names are self-declared, so the log uses the ids.
- **Unauthenticated requests to `/mcp` return `401`** with a `WWW-Authenticate` header pointing to the protected-resource metadata, so clients can discover the login, instead of v1's `404`.
- **Migration with an end date:** the new Worker starts with OAuth only; the v1 Worker and its token in the URL keep running only until every client has reconnected, at most one week after v2 is deployed, and then the v1 Worker is deleted. Until then the old URL is still a way in. Deleting it closes [#12](https://github.com/YudiG12/second-brain-mcp/issues/12).
- **Out of scope:** the Mac's sync hook is not an MCP client. It keeps the admin secret from [ADR 007](007-cloudflare-artifacts-for-the-notes.md), which also protects the admin routes, including grant revocation. Replacing it with a scoped credential is [#39](https://github.com/YudiG12/second-brain-mcp/issues/39).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Keep the token in the URL, rotate it more often** | Still one shared credential, no per-client revocation, and every rotation reconnects every client. |
| **Google as the login** | Equally simple; GitHub was chosen because the owner uses it daily and it is the provider in Cloudflare's remote MCP examples. Swapping providers only changes the login handler. |
| **Cloudflare Access as the login** | Keeps everything inside Cloudflare, but adds Zero Trust configuration for a single user. Worth it once there are several users or teams. |
| **Separate Workers for authorization and for the MCP endpoint** (the library's recommendation for larger setups) | Isolates token handling from the tools, but adds a deploy and a binding for one user. |
| **Write a custom OAuth server** | Token handling, PKCE and client registration are easy to get wrong; the library is maintained by Cloudflare for this use. |

## Consequences

**Gained**
- The URL alone grants nothing: connecting requires logging in as the owner.
- Per-client, expiring tokens, revocable one at a time.
- Protection against a malicious client redirecting the owner's login (consent page with the redirect host).
- An audit trail of which client changed what.

**Costs**
- **One more dependency in the login path:** if GitHub's login is down, new connections fail (existing tokens keep working until they expire).
- **A GitHub OAuth app and its client secret,** plus a KV namespace, created by the setup script ([ADR 006](006-wrangler-and-a-setup-script-instead-of-terraform.md)).
- **A stolen, logged-in device still has access** until the account is signed out or the grant revoked: OAuth makes revocation possible, not automatic.
- **Revocation is not instant everywhere:** KV is eventually consistent, so a revoked token can keep working for up to about a minute in other locations.
- **A consent click on every new connection.**
- ~~The admin secret on the Mac can revoke grants~~: resolved by [#39](https://github.com/YudiG12/second-brain-mcp/issues/39); the Mac holds only a hook secret.
- **More moving parts to test:** the login flow, refresh, and the single-user check.

## Revisit when

- The system serves more than one person: allow a list of users, or move to Cloudflare Access.
- A client used here doesn't support MCP OAuth or CIMD.
- The admin secret is replaced ([#39](https://github.com/YudiG12/second-brain-mcp/issues/39)).

## Related

- [ADR 004: Secret token in the URL](004-secret-token-in-the-url.md)
- [ADR 007: Cloudflare Artifacts for the notes](007-cloudflare-artifacts-for-the-notes.md)
- [ADR 006: Wrangler and a setup script instead of Terraform](006-wrangler-and-a-setup-script-instead-of-terraform.md)
- Issue [#12](https://github.com/YudiG12/second-brain-mcp/issues/12)
