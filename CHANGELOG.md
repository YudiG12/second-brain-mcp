# Changelog

## v2 (2026-11-06)

Built in one day as a series of PRs, each one red tests first, then green, then a review by a separate agent with a clean context before merge. Decisions in [ADR 006](docs/adr/006-wrangler-and-a-setup-script-instead-of-terraform.md) to [ADR 012](docs/adr/012-hybrid-search-with-d1-fts5.md); design in [spec v2](docs/spec/v2.md).

### Changed
- **Notes live in Cloudflare Artifacts**, not GitHub: Git storage inside Cloudflare, read through a binding, no external token or rate limit ([ADR 007](docs/adr/007-cloudflare-artifacts-for-the-notes.md), #44).
- **Writes go through one Durable Object per repository** (`RepoWriter`): an in-memory mutex serializes them, the operation is applied inside the lock, a push rejected because the Mac pushed first is re-run on the new tip, and a lost push response is confirmed against the remote before reporting ([ADR 008](docs/adr/008-one-durable-object-per-repository.md), #44).
- **Indexing runs on a Queue** with retries and a dead-letter queue; the consumer is the only writer of the index, records what it indexed in a D1 manifest, and skips work already done ([ADR 009](docs/adr/009-queue-for-indexing-workflow-for-reconciliation.md), [ADR 010](docs/adr/010-index-manifest-in-d1.md), #46).
- **`search_notes` is hybrid**: a D1 FTS5 keyword index and Vectorize, fused by reciprocal rank; it no longer reads every note ([ADR 012](docs/adr/012-hybrid-search-with-d1-fts5.md), #53).
- **OAuth 2.1 with GitHub sign-in** replaces the token in the URL: consent page, exact redirect allowlist, owner-only, per-client grants that can be revoked ([ADR 011](docs/adr/011-oauth-with-github-login.md), #51, #55).
- **The Mac sync hook** merges instead of rebasing, so local commits are never rewritten; conflicts keep the remote version and save the local one as a `.conflict` copy; one sync at a time per clone; its own scoped secret (#50).
- **Infrastructure from the repo**: `wrangler.jsonc` + idempotent `scripts/setup.sh`, English names everywhere, deploy on merge ([ADR 006](docs/adr/006-wrangler-and-a-setup-script-instead-of-terraform.md), #43).

### Added
- Daily **reconciliation** and an on-demand **rebuild** as a Cloudflare Workflow (#48).
- **Tests and CI**: 147 Vitest tests running inside workerd (local D1, KV, Queues, Workflows), 48 shell scenarios for the hook, a per-commit test report with the Vitest UI on every PR (#41 and later).
- **Measurements** of v1 and v2 in production ([spec v2 §10](docs/spec/v2.md), #45, #54).
- Admin routes to list and revoke OAuth grants, and to start a reconciliation or rebuild.

### Fixed
- Concurrent edits to the same note could silently lose one (#5).
- `move_note` was two commits, not atomic (#10).
- Failed indexing was never retried (#6); deleted notes stayed in the index (#7); `/reindex` was not a real rebuild (#8).
- `read_note` didn't validate paths (#30); `save_idea` overwrote same-day ideas (#31).
- The sync hook stopped silently on a rebase conflict (#15) and collided across sessions (#16).

### Measured (p50, production)
| | v1 | v2 |
|---|---|---|
| Write | 4.1 s | 2.1 s |
| New note findable by keyword | — | ~12 s |
| New note findable by meaning | 122 s | 53 s |
| `search_notes` | 2.8 s (reads all notes) | 1.5 s (reads none) |

## v1 (2026-11-05)

A remote MCP server on Cloudflare Workers over a GitHub repo of Markdown notes: nine tools, semantic search with Workers AI (bge-m3) and Vectorize, a push webhook to re-index, Claude Code hooks to keep the Mac's clone in sync, and a secret token in the URL. Documented after the fact in [PRD v1](docs/prd/v1.md), [spec v1](docs/spec/v1.md) and [ADR 001 to 005](docs/adr/).
