# Second Brain MCP

My notes, available to every AI client I use, from one remote [MCP](https://modelcontextprotocol.io) server on Cloudflare.

I keep a "second brain": Markdown notes on ideas, projects, decisions and plans. I use it from Claude Code on my Mac, from Claude on my phone and the web, and from ChatGPT. This server gives all of them the same notes, with keyword and semantic search, and keeps a Git history of every change.

![Architecture of v2](docs/architecture/v2.png)

## What it does

- **Nine MCP tools:** `list_notes`, `read_note`, `search_notes` (hybrid: keyword and meaning), `semantic_search`, `save_idea`, `write_note`, `edit_note`, `move_note`, `delete_note`.
- **Every change is a Git commit**, so anything can be undone ([ADR 005](docs/adr/005-one-commit-per-edit.md)).
- **The Mac keeps a local clone**, synced by Claude Code hooks, so Claude Code reads and writes notes as plain files.
- **Sign-in with OAuth** (GitHub, owner only): each client gets its own grant, which can be revoked.

## How it works (v2)

| Concern | How | Decision |
|---|---|---|
| Where notes live | Cloudflare **Artifacts** (Git), read through a binding | [ADR 007](docs/adr/007-cloudflare-artifacts-for-the-notes.md) |
| Writes | One **Durable Object per repository**: in-memory mutex, operation applied inside the lock, retried on the new tip if the Mac pushed first, confirmed before reporting a failure | [ADR 008](docs/adr/008-one-durable-object-per-repository.md) |
| Indexing | A **Queue**: the only writer of the index, retries and a dead-letter queue, records what it indexed in a **D1 manifest** | [ADR 009](docs/adr/009-queue-for-indexing-workflow-for-reconciliation.md), [ADR 010](docs/adr/010-index-manifest-in-d1.md) |
| Repair | A daily **Workflow** compares notes and index and enqueues fixes; also a full rebuild | [ADR 009](docs/adr/009-queue-for-indexing-workflow-for-reconciliation.md) |
| Search | **D1 FTS5** (keyword) + **Vectorize** (meaning, Workers AI bge-m3), fused by reciprocal rank | [ADR 002](docs/adr/002-semantic-search-with-workers-ai-and-vectorize.md), [ADR 012](docs/adr/012-hybrid-search-with-d1-fts5.md) |
| Access | **OAuth 2.1** (`workers-oauth-provider`), consent page, GitHub sign-in restricted to the owner | [ADR 011](docs/adr/011-oauth-with-github-login.md) |
| Mac sync | Hooks that merge (never rewrite local commits), keep conflict copies, and run one at a time | [spec v2 §5.4](docs/spec/v2.md) |
| Infrastructure | `wrangler.jsonc` + an idempotent setup script; deploy on merge | [ADR 006](docs/adr/006-wrangler-and-a-setup-script-instead-of-terraform.md) |

The full design is in the [v2 spec](docs/spec/v2.md); what v2 changed and fixed is in the [CHANGELOG](CHANGELOG.md).

## Numbers (production, p50 of 10 runs)

| | v1 | v2 |
|---|---|---|
| Write a note | 4.1 s | 2.1 s |
| New note findable by keyword | immediate (reads every note) | ~12 s |
| New note findable by meaning | 122 s | 53 s |
| `search_notes` | 2.8 s, reads every note | 1.5 s, reads none |

Method and raw samples: [spec v2 §10](docs/spec/v2.md), [`docs/measurements/`](docs/measurements/).

## How it was built

v1 was built in a day and documented afterwards: [PRD v1](docs/prd/v1.md), [spec v1](docs/spec/v1.md), [ADR 001 to 005](docs/adr/). Writing the spec surfaced the bugs that became v2's scope ([PRD v2](docs/prd/v2.md)).

v2 was built as a series of small PRs, each with failing tests first, then the implementation, then a review by a separate AI agent with a clean context, then merge and deploy. The [pull requests](https://github.com/YudiG12/second-brain-mcp/pulls?q=is%3Apr+is%3Aclosed) keep the reviews and every red-then-green CI run, with a Vitest UI report per commit.

What would change for a team or many teams: [design note: at scale](docs/design/at-scale.md).

## Repository

```
src/
  index.ts            Worker: OAuth wrapper, MCP tools, admin routes, queue handler
  auth/github.ts      consent page, GitHub sign-in, owner check
  writer/             RepoWriter Durable Object, Artifacts working copy (isomorphic-git)
  indexer/            queue consumer logic and adapters (Artifacts, D1, Vectorize, Workers AI)
  reconcile/          reconciliation Workflow
  search/hybrid.ts    FTS5 query building and rank fusion
clients/claude-code/  the Mac sync hook and its Claude Code settings
migrations/           D1 schema
scripts/              setup, secrets, measurements
test/                 Vitest (inside workerd) and shell tests for the hook
docs/                 PRDs, specs, ADRs, architecture maps, measurements, design notes
```

## Development

Node 24 or later.

```sh
npm ci
npm run typecheck
npm test              # Vitest inside workerd, with local D1, KV, Queues and Workflows
npm run test:ui       # the same tests in the Vitest UI
bash test/hook/run.sh # the sync hook against real Git repositories
```

To deploy your own: [docs/setup.md](docs/setup.md).
