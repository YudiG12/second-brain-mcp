# ADR 007: Cloudflare Artifacts for the notes

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |
| **Supersedes** | [ADR 001](001-github-as-source-of-truth.md); the GitHub webhook and the pull throttle of [ADR 003](003-sync-with-claude-code-hooks-and-a-push-webhook.md) |

## Context

[ADR 001](001-github-as-source-of-truth.md) moved the notes to GitHub for history, diffs and the list of deleted files. Its costs, as seen in the v1 review:

- **An external dependency:** a GitHub token in the Worker and an HMAC secret for the webhook.
- **API limits:** 5,000 requests per hour and a secondary limit of about 500 content-creating requests per hour. Not a problem for one user today; it caps how many agents can write later ([ADR 005](005-one-commit-per-edit.md)).
- **Silent staleness after a push.** The webhook answers `202` and indexes in the background with no retry, so a failed indexing run is lost ([#6](https://github.com/YudiG12/second-brain-mcp/issues/6)). This is the Worker's fault, not GitHub's: a Queue would fix it on either backend. GitHub not redelivering failed webhooks is a smaller, secondary risk.

Cloudflare Artifacts (open beta since 2026-10-01, Workers Paid plan) is Git-compatible storage inside Cloudflare, built for many repositories.

## Spike (2026-11-06)

Two half-day spikes on a throwaway namespace with fake notes, deleted afterwards.

| Question | Result |
|---|---|
| Can the Mac push and pull with plain `git`? | Yes: 28 notes pushed in 2.6 s, cloned in 2.5 s, round trip works. |
| Does a push produce an event? | Yes: an `artifacts.repo` `pushed` event reached a Queue consumer about 11 s after the push. |
| Can the Worker read a note? | Yes, through the binding (`repo.readFile`), about 0.9 s cold. |
| Does the event list changed files? | **No.** It lists commits (`before`, `after`), not added, modified or removed files. |
| Can the Worker write through the binding? | **No**, the binding is read-only. Writes go through the Git protocol. |
| Can a Durable Object write with a Git client? | **Yes.** isomorphic-git with an in-memory file system: first write clones in about 1 s and pushes in about 0.6 s; later writes reuse the working copy (push about 0.7 s). Bundle about 200 KB gzipped. |
| What if the Mac pushes in between? | The push is rejected; the Durable Object fetches, re-applies the change and pushes again (about 1.5 s). |
| Simultaneous writes? | Without explicit serialization they interleaved and collided. With an in-memory mutex in the Durable Object, 16 of 16 landed, each waiting for the previous one (see [ADR 008](008-one-durable-object-per-repository.md)). |
| Do Git tokens expire? | Yes: repo-scoped tokens default to 24 h; the TTL is configurable. |

**Verdict: go.** Two findings shape the design: writes need explicit serialization, and under concurrent pushes Artifacts sometimes answered with an unreadable response for a push that had actually landed.

## Decision

Move the notes from GitHub to an Artifacts repository.

- **Reads:** through the Artifacts binding. No token.
- **Writes:** through Git, from one Durable Object that owns the repository ([ADR 008](008-one-durable-object-per-repository.md)). Each write is committed and pushed before the tool answers, so [ADR 005](005-one-commit-per-edit.md) still holds, and `move` becomes a single commit. After the push, the tool enqueues the note for indexing instead of indexing it itself, so the Queue consumer is the only writer to the index ([ADR 009](009-queue-for-indexing-workflow-for-reconciliation.md)). In-tool indexing would only save the few seconds the Queue takes, while Vectorize itself needs seconds to about two minutes to show a change ([#9](https://github.com/YudiG12/second-brain-mcp/issues/9)).
- **Indexing:** the repository's `pushed` events go to a Queue whose consumer runs one batch at a time (`max_concurrency: 1`). For each event:
  - ignore it unless `ref` is `refs/heads/main`;
  - diff the `before` and `after` trees (`readCommit` + `readTree`, descending only into changed subtrees) **only to find which paths changed**; a `before` of all zeros (first push) means "everything";
  - read each changed path **at the current head of `main`**, not at `after`: if it exists, re-index it; if it is gone, delete its vectors.

  Reading at head plus one consumer at a time means a retried or out-of-order message can't overwrite newer content.
- **Reconciliation is still required** ([#7](https://github.com/YudiG12/second-brain-mcp/issues/7)): retries and the dead-letter queue cover the consumer, but delivery from Artifacts to the Queue isn't documented as guaranteed, so the daily reconciliation catches events that never arrive.
- **The Mac:** keeps a Git clone with the Artifacts remote. Its sync hook asks a Worker route for a write token for this one repository, valid for 1 hour, and keeps it in the macOS Keychain until it expires. The route is protected by the Worker's admin secret, sent as `Authorization: Bearer <secret>` on that route only (not in a URL), and the Mac stores that secret in the Keychain. That is still a long-lived credential on the Mac, and it now grants more than before (Git write access and admin routes), until OAuth replaces it ([#12](https://github.com/YudiG12/second-brain-mcp/issues/12)).
- **The sync hook pulls less:** `push` only fetches when there is something to push, and the prompt-time pull runs at most once every 10 minutes (was once a minute), to stay within the included Artifacts operations.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Stay on GitHub, add a Queue** (the webhook only enqueues; a consumer indexes with retries) | Fixes the silent staleness on its own. What it doesn't fix: the external token and webhook secret, every read leaving Cloudflare, and the API limits that cap many writers. Moving to Artifacts removes those; the Queue comes with either choice. |
| **Write to a durable store first, batch commits to Git later** (proposed in ADR 005's "Revisit when") | Faster answers, but two places that can disagree and a commit that can fail after the tool said "Saved". Kept as the path if write latency becomes a problem. |
| **R2 with event notifications** | No Git history or diffs, and the Mac couldn't sync with plain Git. |

## Consequences

**Gained**
- No GitHub token and no webhook secret; reads go through a binding.
- `move` becomes a single commit ([#10](https://github.com/YudiG12/second-brain-mcp/issues/10)).
- No 5,000-per-hour or 500-writes-per-hour GitHub limits.
- Push events land in a Queue whose consumer retries and has a dead-letter queue.

**Costs**
- **Writes need a Git client inside a Durable Object,** with explicit serialization and retries ([ADR 008](008-one-durable-object-per-repository.md)). On GitHub this was one REST call.
- **The indexer must diff trees,** since the event doesn't list changed files.
- **The Mac hook must refresh tokens,** through a new Worker route protected by a long-lived admin secret stored on the Mac.
- **Freshness on the Mac:** a note saved from the phone can take up to 10 minutes to reach the Mac (or until the next session starts).
- **Slower notification:** about 11 s from push to Queue consumer, plus Vectorize's own delay.
- **Artifacts has its own limits** (per Cloudflare's docs): 2,000 Git requests per 10 s per repository, 2,000 control-plane requests per 10 s per namespace, and 1 GB per repository for repositories created from 2026-09-29.
- **Operations are billed** beyond 10,000 a month (billing starts 2026-11-12). The v1 hook pulled on every answer and up to once a minute on prompts: a theoretical maximum of tens of thousands of pulls a month. With the changes above, a rough estimate for one user (8 active hours a day): prompt pulls ≤ 48 a day, session-start pulls ~10, pushes with changes ~20, MCP writes ~10 × (cold clone + push) ~20, so about 100 a day, ~3,000 a month, within the included 10,000. Whether binding reads count as operations is not documented; if they do, `search_notes` (which reads every note per call, [#13](https://github.com/YudiG12/second-brain-mcp/issues/13)) would dominate. Actual usage is measured in [#14](https://github.com/YudiG12/second-brain-mcp/issues/14).
- **Beta:** the API may change. **More lock-in** to Cloudflare, and the Workers Paid plan (US$ 5/month).

## Revisit when

- The Artifacts beta changes its API or proves unreliable.
- The Git write path costs more in bugs and maintenance than it saves; the fallback is GitHub plus a Queue.
- Artifacts adds writes to the binding, or changed files to the push event: both remove a cost above.
- Several users or teams share the system: one repository per unit of work, each with its own Durable Object.

## Related

- [ADR 001](001-github-as-source-of-truth.md) (superseded), [ADR 003](003-sync-with-claude-code-hooks-and-a-push-webhook.md) (webhook part superseded), [ADR 005](005-one-commit-per-edit.md), [ADR 008](008-one-durable-object-per-repository.md)
- [PRD v2](../prd/v2.md)
- Issues [#5](https://github.com/YudiG12/second-brain-mcp/issues/5), [#6](https://github.com/YudiG12/second-brain-mcp/issues/6), [#7](https://github.com/YudiG12/second-brain-mcp/issues/7), [#26](https://github.com/YudiG12/second-brain-mcp/issues/26)
