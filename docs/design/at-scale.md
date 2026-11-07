# Design note: Second Brain MCP at scale

| | |
|---|---|
| **Status** | Exploration, not built |
| **Builds on** | [spec v2](../spec/v2.md), [ADR 007](../adr/007-cloudflare-artifacts-for-the-notes.md) to [ADR 012](../adr/012-hybrid-search-with-d1-fts5.md) |

v2 serves one person. This note looks at what changes if it served a team, or many teams (for example a firm whose people and agents share one memory), and which v2 decisions hold.

## What already scales

- **The unit of work is the repository.** A Git commit covers the whole repository, so writes are serialized per repository by one Durable Object ([ADR 008](../adr/008-one-durable-object-per-repository.md)). Different repositories never contend: one repository per team (or per person) shards writes for free, and each Durable Object lives near its users.
- **Reads don't touch the writer.** Notes are read through the Artifacts binding; search reads D1 and Vectorize. Read traffic grows without queueing behind writes.
- **Indexing is idempotent and re-checks the head**, so it can be retried, duplicated or replayed without corrupting the index ([ADR 010](../adr/010-index-manifest-in-d1.md)).
- **Reconciliation is per run, resumable, and only enqueues** ([ADR 009](../adr/009-queue-for-indexing-workflow-for-reconciliation.md)); one Workflow instance per repository would reconcile each independently.

## What has to change

| Area | v2 (one person) | At scale | Why |
|---|---|---|---|
| Write throughput | One repository; ~1.8 writes/s measured in the spike | One repository per team or project | The ceiling is per repository, and a commit is per repository |
| Indexing order | One Queue consumer (`max_concurrency: 1`) for everything | Per-repository ordering: several consumers, with a per-repository lock (or a Durable Object per repository doing the indexing) | One global consumer becomes the bottleneck; order only matters within a repository |
| Index isolation | One Vectorize index, one D1 database | A tenant id in vector metadata and every D1 row, filtered on every query; or an index and a database per large tenant | Search must never return another team's notes |
| Access control | One GitHub account (`OWNER_GITHUB_ID`) | Users and groups (GitHub org or an identity provider via Cloudflare Access), grants scoped to repositories, an audit log per user | Who can read or write which repository becomes the core of the product |
| Authorization in tools | All notes visible to the one user | Every tool checks the caller's scope against the repository and path | MCP clients act for a user; the server enforces, not the client |
| Prompt injection | Notes are data, never instructions | Same rule, plus per-tool least privilege and human approval for irreversible actions | Shared notes can be written by someone else |
| Sync clients | One Mac with a hook | Many devices; the hook's merge strategy already never rewrites local commits; conflict copies need a UI to resolve | More writers per repository means more conflicts |
| Cost | Fits the included tiers | Artifacts operations, Workers AI embeddings and Vectorize queries dominate; embed only changed chunks (the manifest already skips unchanged notes) | Re-embedding is the expensive path |
| Search quality | bge-m3; the similarity floor can't tell "no match" apart ([ADR 012](../adr/012-hybrid-search-with-d1-fts5.md)) | Benchmark models on the tenants' real queries ([#33](https://github.com/YudiG12/second-brain-mcp/issues/33)); a reranker on the fused top results | With more notes, ranking matters more than recall |
| Observability | Logs and an alerts table | Metrics per repository: queue depth, indexing lag, dead letters, reconciliation fixes; alerts to a channel | "No silent failure" has to hold per tenant |

## What I would build first

1. A tenant id end to end (Artifacts namespace or repository, vector metadata, D1 rows), with a test that one tenant's search can't see another's notes.
2. Per-repository indexing order, so the global consumer limit goes away.
3. Access control in the tools, backed by the OAuth grant's user and the repository it was granted for.

## Related

- [Spec v2](../spec/v2.md)
- [ADR 008: One Durable Object per repository](../adr/008-one-durable-object-per-repository.md)
- [ADR 011: OAuth with GitHub sign-in](../adr/011-oauth-with-github-login.md)
