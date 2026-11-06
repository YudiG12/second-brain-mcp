# ADR 004: A secret token in the URL as authentication

| | |
|---|---|
| **Status** | Accepted for v1; superseded by [ADR 011](011-oauth-with-github-login.md) in v2 |
| **Date** | 2026-11-05 |
| **Deciders** | Yudi Ganeko |

## Context

v1 has one user and three MCP clients: Claude Code, Claude on the phone (and web) and ChatGPT. The custom connector screens of Claude and ChatGPT accept a URL, or OAuth, but have no way to set a request header. The goal for v1 was to have all three clients connected the same day.

## Decision

Every route lives under a secret prefix: `/<MCP_TOKEN>/mcp`, `/<MCP_TOKEN>/github-webhook`, `/<MCP_TOKEN>/reindex`. The token is 48 random hex characters (192 bits), stored as a Worker secret.

Any request without the exact prefix gets **404 Not found**, not 401, so the endpoint doesn't advertise that something exists there. That is obscurity, not the actual protection: what protects the server is that a 192-bit random token can't be guessed.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Bearer token in a header** (`Authorization: Bearer …`) | The standard for APIs, and it leaks less than a URL. But Claude on the phone and ChatGPT can't send custom headers, so only Claude Code would work. |
| **OAuth** | The proper answer: every client gets its own expiring, revocable access, and it works in all three clients. Needs an authorization server (login, tokens, refresh), which was more than v1 needed for one user. Cloudflare's `workers-oauth-provider` library is the planned path. |
| **No authentication** | The notes are private. |

## Consequences

**Gained**
- Works in every MCP client from day one, with nothing but a URL.
- Simple: one secret, one check in the router.

**Costs**
- **Leaks easily.** A URL ends up in places a header doesn't: logs, browser history, screenshots, the config of every client it was pasted into, and **GitHub's webhook settings and delivery logs**, since the webhook URL contains the same token. A leaked URL gives full access; the 404 doesn't help.
- **All or nothing.** Whoever has the URL can read, edit and delete every note. Mitigated by [ADR 001](001-github-as-source-of-truth.md): every change is a commit and can be undone.
- **No identity.** The server can't tell who is calling, so there is no per-user access control and no audit of who did what.
- **Never expires.** The token is valid until it is rotated by hand.
- **Rotation breaks every client at once.** There is one token, so changing it means reconnecting all clients; a single client can't be revoked on its own.

## Revisit when

- **v2:** replace it with OAuth ([#12](https://github.com/YudiG12/second-brain-mcp/issues/12)). With OAuth the Worker should answer **401** with a `WWW-Authenticate` header: MCP clients use that response to start the login flow, and hiding the endpoint no longer matters.
- Before anyone other than me uses the server.
- If the URL is ever shown or shared by mistake: rotate the token immediately.

## Related

- [ADR 001: GitHub as the source of truth](001-github-as-source-of-truth.md)
- [Spec v1](../spec/v1.md), sections 2 and 7
