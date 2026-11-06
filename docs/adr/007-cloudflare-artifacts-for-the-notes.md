# ADR 007: Cloudflare Artifacts for the notes

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |
| **Supersedes** | [ADR 001](001-github-as-source-of-truth.md); the GitHub-webhook part of [ADR 003](003-sync-with-claude-code-hooks-and-a-push-webhook.md) |

## Context

[ADR 001](001-github-as-source-of-truth.md) moved the notes to GitHub for history, diffs and the list of deleted files. Its costs, as seen in the v1 review:

- **An external dependency:** a GitHub token in the Worker, an HMAC secret for the webhook, and every read is an HTTP call outside Cloudflare.
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
| Eight simultaneous writes? | All eight landed, in order, once writes were explicitly serialized (see [ADR 008](008-one-durable-object-per-repository.md)). Without that, they interleaved and collided. |
| Do Git tokens expire? | Yes: repo-scoped tokens default to 24 h; the TTL is configurable. |

**Verdict: go.** Two findings shape the design: writes need explicit serialization, and under concurrent pushes Artifacts sometimes answered with an unreadable response for a push that had actually landed.

## Decision

Move the notes from GitHub to an Artifacts repository.

- **Reads:** through the Artifacts binding. No token.
- **Writes:** through Git, from one Durable Object that owns the repository ([ADR 008](008-one-durable-object-per-repository.md)). Each write is committed and pushed before the tool answers, so [ADR 005](005-one-commit-per-edit.md) still holds.
- **Indexing:** the repository's `pushed` events go to a Queue. The consumer diffs the `before` and `after` trees (`readCommit` + `readTree`, descending only into changed subtrees) **only to find which paths changed**, then reads each path **at the current head of `main`**, not at `after`. That way a retried or out-of-order message never writes stale content. A `before` of all zeros (first push) means "index everything".
- **The Mac:** keeps a Git clone with the Artifacts remote. Its sync hook gets a write token for this one repository from a Worker route, valid for 1 hour, instead of storing a long-lived one. Until OAuth lands, that route is protected by the Worker's admin secret ([PRD v2](../prd/v2.md), E4); a leaked secret would also grant Git write access to the notes, so it stays out of URLs.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Stay on GitHub, add a Queue** (the webhook only enqueues; a consumer indexes with retries) | Fixes the silent staleness on its own. What it doesn't fix: the external token and webhook secret, every read leaving Cloudflare, and the API limits that cap many writers. Moving to Artifacts removes those; the Queue comes with either choice. |
| **Write to a durable store first, batch commits to Git later** (proposed in ADR 005's "Revisit when") | Faster answers, but two places that can disagree and a commit that can fail after the tool said "Saved". Kept as the path if write latency becomes a problem. |
| **R2 with event notifications** | No Git history or diffs, and the Mac couldn't sync with plain Git. |

## Consequences

**Gained**
- No GitHub token and no webhook secret; reads go through a binding.
- No 5,000-per-hour or 500-writes-per-hour GitHub limits.
- Push events land in a Queue with retries and a dead-letter queue.

**Costs**
- **Writes need a Git client inside a Durable Object,** with explicit serialization and retries ([ADR 008](008-one-durable-object-per-repository.md)). On GitHub this was one REST call.
- **The indexer must diff trees,** since the event doesn't list changed files.
- **The Mac hook must refresh tokens,** through a new Worker route.
- **Slower notification:** about 11 s from push to Queue consumer, plus Vectorize's own delay.
- **Artifacts has its own limits** (per Cloudflare's docs): 2,000 Git requests per 10 s per repository, 2,000 control-plane requests per 10 s per namespace, and 1 GB per repository for repositories created from 2026-09-29.
- **Operations are billed** beyond 10,000 a month (billing starts 2026-11-12). The sync hook used to pull at most once a minute, which could reach about 43,000 pulls a month on heavy days, so the pull throttle goes to once every 10 minutes (at most about 4,300 a month). Whether binding reads count as operations is not documented; actual usage is measured in [#14](https://github.com/YudiG12/second-brain-mcp/issues/14).
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
