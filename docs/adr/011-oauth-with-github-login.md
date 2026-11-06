# ADR 011: OAuth for MCP clients, with GitHub as the login

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |
| **Supersedes** | [ADR 004](004-secret-token-in-the-url.md) |

## Context

In v1 every MCP client connects with one secret token in the URL ([ADR 004](004-secret-token-in-the-url.md)). Whoever sees the URL can connect any client; every client shares the same credential, so they can't be told apart in logs; and the token never expires. Revoking one client means rotating the token and reconnecting all of them ([#12](https://github.com/YudiG12/second-brain-mcp/issues/12)).

The MCP specification defines OAuth 2.1 for remote servers, and the clients used here (Claude on the web and phone, Claude Code, ChatGPT) support it, including dynamic client registration. The server needs someone to answer "is this person the owner?", which means picking a login provider.

## Decision

- **The Worker becomes an OAuth 2.1 authorization server** using Cloudflare's `workers-oauth-provider` library. It handles client registration, authorization codes with PKCE, access and refresh tokens, and stores grants and tokens (hashed) in a KV namespace.
- **The login is "Sign in with GitHub".** The Worker delegates authentication to a GitHub OAuth app and accepts only one GitHub user, by numeric id (not username, which can change). Anyone else is refused after login.
- **Each client gets its own grant.** Claude on the phone, Claude Code and ChatGPT each have separate, expiring access tokens that renew through refresh tokens. A protected admin route lists grants and revokes one, so a lost phone is cut off without touching the other clients.
- **The client identity is logged** with every write, so a change can be traced to the client that made it.
- **Migration:** the token-in-URL route stays during the switch and is removed once every client has reconnected through OAuth. Removing it closes [#12](https://github.com/YudiG12/second-brain-mcp/issues/12).
- **Out of scope:** the Mac's sync hook is not an MCP client. It keeps the admin secret from [ADR 007](007-cloudflare-artifacts-for-the-notes.md) to get Artifacts tokens; moving it to OAuth is a later change.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Keep the token in the URL, rotate it more often** | Still one shared credential, no per-client revocation, and every rotation reconnects every client. |
| **Google as the login** | Equally simple; GitHub was chosen because the owner uses it daily and it is the provider in Cloudflare's remote MCP examples. Swapping providers only changes the login handler. |
| **Cloudflare Access as the login** | Keeps everything inside Cloudflare, but adds Zero Trust configuration for a single user. Worth it once there are several users or teams. |
| **Write a custom OAuth server** | Token handling, PKCE and client registration are easy to get wrong; the library is maintained by Cloudflare for this use. |

## Consequences

**Gained**
- The URL alone grants nothing: connecting requires logging in as the owner.
- Per-client, expiring tokens, revocable one at a time.
- An audit trail of which client changed what.

**Costs**
- **One more dependency in the login path:** if GitHub's login is down, new connections fail (existing tokens keep working until they expire).
- **A GitHub OAuth app and its client secret,** plus a KV namespace, created by the setup script ([ADR 006](006-wrangler-and-a-setup-script-instead-of-terraform.md)).
- **A stolen, logged-in device still has access** until its grant is revoked: OAuth makes revocation possible, not automatic.
- **More moving parts to test:** the login flow, refresh, and the single-user check.

## Revisit when

- The system serves more than one person: allow a list of users, or move to Cloudflare Access.
- A client used here doesn't support MCP OAuth.

## Related

- [ADR 004: Secret token in the URL](004-secret-token-in-the-url.md)
- [ADR 007: Cloudflare Artifacts for the notes](007-cloudflare-artifacts-for-the-notes.md)
- [ADR 006: Wrangler and a setup script instead of Terraform](006-wrangler-and-a-setup-script-instead-of-terraform.md)
- Issue [#12](https://github.com/YudiG12/second-brain-mcp/issues/12)
