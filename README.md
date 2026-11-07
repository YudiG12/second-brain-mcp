<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png"><img src="docs/assets/banner-light.png" alt="Second Brain MCP: your Markdown notes in every AI client" width="100%"></picture></p>

<p align="center"><a href="https://github.com/YudiG12/second-brain-mcp/actions/workflows/ci.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/YudiG12/second-brain-mcp/ci.yml?branch=main&style=flat-square&label=tests&labelColor=1B2632"></a> <img alt="Cloudflare Workers" src="https://img.shields.io/badge/runtime-Cloudflare_Workers-F38020?style=flat-square&labelColor=1B2632&logo=cloudflare&logoColor=white"> <img alt="MCP" src="https://img.shields.io/badge/protocol-MCP-5A4BD1?style=flat-square&labelColor=1B2632"> <img alt="OAuth 2.1" src="https://img.shields.io/badge/auth-OAuth_2.1-2F8A5B?style=flat-square&labelColor=1B2632"> <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-8A6A3F?style=flat-square&labelColor=1B2632"></a> <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3767A8?style=flat-square&labelColor=1B2632&logo=typescript&logoColor=white"></p>

**A remote MCP server that gives every AI client the same Markdown notes**: Claude Code on the Mac, Claude on the web and phone, ChatGPT. Search by keyword or by meaning; every change is a Git commit. Deploy your own on Cloudflare.

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/hld-dark.png"><img src="docs/assets/hld-light.png" alt="High-level design: the Mac and any other client talk MCP to a Worker on Cloudflare, which keeps the notes in Artifacts and embeds them with Workers AI into Vectorize" width="720"></picture></p>

<p align="center"><sub>A simplified view. Every component, with the decision behind it: <a href="ARCHITECTURE.md">ARCHITECTURE.md</a>.</sub></p>

## Deploy your own

Each deployment serves one person: your notes, your Cloudflare account, and only your GitHub account can sign in. You need a Cloudflare account on the Workers Paid plan, Node 24 or later, and a GitHub account.

1. **Fork and install.** `npm ci`, then `npx wrangler login`.
2. **Point it at your account.** Everything owner-specific lives in one file, `wrangler.jsonc`: `account_id`, and in `vars` `PUBLIC_URL` (`https://<worker>.<your-subdomain>.workers.dev`), `CF_ACCOUNT_ID` and `OWNER_GITHUB_ID` (your numeric GitHub id: `gh api user --jq .id`). The scripts and CI read it from there ([`scripts/config.mjs`](scripts/config.mjs)). Then `npm run types`.
3. **Create a GitHub OAuth app** (Settings → Developer settings → OAuth Apps) with the callback `<PUBLIC_URL>/callback`. Put its client id in `GITHUB_CLIENT_ID`.
4. **Create the resources.** `scripts/setup.sh` creates the Vectorize index, the Artifacts repository, the D1 database, the queues and the push subscription. It is safe to run again; copy the D1 id it prints into `wrangler.jsonc`.
5. **Add your notes.** Push your Markdown notes (at least one commit) to the Artifacts repository before the first deploy; the [setup guide](docs/setup.md) has the token command.
6. **Deploy and set secrets.** `npx wrangler deploy`, then `scripts/secrets.sh github-oauth` and `scripts/secrets.sh admin`.
7. **Build the index.** `POST <PUBLIC_URL>/admin/reconcile?mode=rebuild` with `Authorization: Bearer <ADMIN_SECRET>`.
8. **Optional, a Mac clone.** `scripts/secrets.sh hook`, then follow [clients/claude-code](clients/claude-code/README.md): link the hook, write `~/.config/second-brain/hook.env` with your `NOTES_DIR` and `SECOND_BRAIN_URL`, and add the hooks to your Claude Code settings.

Every command, in order: [docs/setup.md](docs/setup.md).

## How to use

Add your server as a remote MCP connector in each client, then sign in with GitHub on the consent page. The address is your `PUBLIC_URL` plus `/mcp`:

| Client | Where |
|---|---|
| Claude (web, desktop, phone) | Settings → Connectors → Add custom connector |
| ChatGPT | Settings → Connectors → Create (developer mode) |
| Claude Code | `claude mcp add --transport http second-brain <PUBLIC_URL>/mcp` |

Then just ask. The client picks the tool:

| You ask | Tool |
|---|---|
| "What did I decide about the Acme proposal?" | `search_notes` (keyword + meaning) |
| "Save this idea: …" | `save_idea` |
| "Read projects/acme.md" | `read_note`, `list_notes` |
| "In the plan note, change the deadline to Friday" | `edit_note` (also `write_note`, `move_note`, `delete_note`) |

Each client gets its own grant, which expires and can be revoked ([SECURITY.md](SECURITY.md)).

## Links

- [ARCHITECTURE.md](ARCHITECTURE.md): the low-level design, every component with the decision behind it
- [Decisions (ADRs)](docs/adr/) · [Spec v2](docs/spec/v2.md) · [PRD v2](docs/prd/v2.md)
- [Performance](docs/measurements/README.md): v1 vs v2, measured in production
- [At scale](docs/design/at-scale.md): what changes for a team
- [CHANGELOG](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
