<p align="center"><img src="docs/assets/banner.png" alt="Second Brain MCP: my Markdown notes in every AI client" width="100%"></p>

<p align="center"><a href="https://github.com/YudiG12/second-brain-mcp/actions/workflows/ci.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/YudiG12/second-brain-mcp/ci.yml?branch=main&style=flat-square&label=tests&labelColor=1B2632"></a> <img alt="Cloudflare Workers" src="https://img.shields.io/badge/runtime-Cloudflare_Workers-F38020?style=flat-square&labelColor=1B2632&logo=cloudflare&logoColor=white"> <img alt="MCP" src="https://img.shields.io/badge/protocol-MCP-5A4BD1?style=flat-square&labelColor=1B2632"> <img alt="OAuth 2.1" src="https://img.shields.io/badge/auth-OAuth_2.1-2F8A5B?style=flat-square&labelColor=1B2632"> <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3767A8?style=flat-square&labelColor=1B2632&logo=typescript&logoColor=white"></p>

**One remote MCP server that gives every AI client I use the same Markdown notes**: Claude Code on my Mac, Claude on the web and phone, and ChatGPT. Search by keyword or by meaning, and every change is a Git commit.

<p align="center"><img src="docs/assets/hld.png" alt="High-level design: the Mac and any other client talk MCP to a Worker on Cloudflare, which keeps the notes in Artifacts and embeds them with Workers AI into Vectorize" width="100%"></p>

Clients talk MCP to a Worker on Cloudflare. The notes live in Git (Cloudflare Artifacts); Workers AI turns them into embeddings stored in Vectorize. The Mac also keeps a plain Git clone, synced by Claude Code hooks. The full, low-level design is in [docs/architecture](docs/architecture/README.md).

## How to use

Add the server as a remote MCP connector in your client, then sign in with GitHub on the consent page:

```
https://second-brain-mcp.yudiganeko.workers.dev/mcp
```

| Client | Where |
|---|---|
| Claude (web, desktop, phone) | Settings → Connectors → Add custom connector |
| ChatGPT | Settings → Connectors → Create (developer mode) |
| Claude Code | `claude mcp add --transport http second-brain https://second-brain-mcp.yudiganeko.workers.dev/mcp` |

Then just ask. The client picks the tool:

| You ask | Tool |
|---|---|
| "What did I decide about the Acme proposal?" | `search_notes` (keyword + meaning) |
| "Save this idea: …" | `save_idea` |
| "Read projects/acme.md" | `read_note`, `list_notes` |
| "In the plan note, change the deadline to Friday" | `edit_note` (also `write_note`, `move_note`, `delete_note`) |

Only the owner's GitHub account can sign in. Each client gets its own grant, which expires and can be revoked ([SECURITY.md](SECURITY.md)).

## Install your own

You need a Cloudflare account on the Workers Paid plan, Node 24 or later, and a GitHub account.

1. **Fork and install.** `npm ci`, then `npx wrangler login`.
2. **Point it at your account.** In `wrangler.jsonc`, set `PUBLIC_URL`, `CF_ACCOUNT_ID` and `OWNER_GITHUB_ID` (your numeric GitHub id: `gh api user --jq .id`).
3. **Create a GitHub OAuth app** (Settings → Developer settings → OAuth Apps) with the callback `<PUBLIC_URL>/callback`. Put its client id in `GITHUB_CLIENT_ID`.
4. **Create the resources.** `scripts/setup.sh` creates the Vectorize index, the Artifacts repository, the D1 database, the queues and the push subscription. It is safe to run again; copy the D1 id it prints into `wrangler.jsonc`.
5. **Add your notes.** Push your Markdown notes to the Artifacts repository once (the [setup guide](docs/setup.md) has the token command).
6. **Deploy and set secrets.** `npx wrangler deploy`, then `scripts/secrets.sh github-oauth`, `scripts/secrets.sh admin` and, for the Mac hook, `scripts/secrets.sh hook`.
7. **Build the index.** `POST <PUBLIC_URL>/admin/reconcile?mode=rebuild` with `Authorization: Bearer <ADMIN_SECRET>`.
8. **Connect a client** as in [How to use](#how-to-use).
9. **Optional, the Mac clone.** Copy `clients/claude-code/notes-sync.sh` to `~/.claude/hooks/` and merge `clients/claude-code/settings.hooks.json` into your Claude Code settings ([details](clients/claude-code/README.md)).

The step-by-step with every command is in [docs/setup.md](docs/setup.md).

## Links

- [Low-level design](docs/architecture/README.md): every component, with the decision behind it
- [Decisions (ADRs)](docs/adr/) · [Spec v2](docs/spec/v2.md) · [PRD v2](docs/prd/v2.md)
- [Performance](docs/measurements/README.md): v1 vs v2, measured in production
- [At scale](docs/design/at-scale.md): what changes for a team
- [CHANGELOG](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
