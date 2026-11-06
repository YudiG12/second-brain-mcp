# ADR 007: Cloudflare Artifacts for the notes

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |
| **Supersedes** | [ADR 001](001-github-as-source-of-truth.md) |

## Context

[ADR 001](001-github-as-source-of-truth.md) moved the notes to GitHub for history, diffs and the list of deleted files. It worked, but the review of v1 and the plan for v2 exposed its costs:

- **An external dependency:** a GitHub token in the Worker, a webhook secret, and every read is an HTTP call outside Cloudflare.
- **API limits:** 5,000 requests per hour, and a secondary limit of about 500 content-creating requests per hour, which caps how many agents can write.
- **A webhook with no retry:** a failed delivery is never redelivered, so the index silently goes stale, and missed deletions never heal ([#6](https://github.com/YudiG12/second-brain-mcp/issues/6)).

Cloudflare Artifacts (open beta since 2026-10-01, Workers Paid plan) is Git-compatible storage inside Cloudflare, built for many repositories (one per project, user or agent).

## Spike (2026-11-06)

A half-day spike on a throwaway namespace, deleted afterwards:

| Question | Result |
|---|---|
| Can the Mac push and pull with plain `git`? | Yes: 28 notes pushed in 2.6 s, cloned in 2.5 s, round trip works. |
| Does a push produce an event? | Yes: an `artifacts.repo` `pushed` event reached a Queue consumer about 11 s after the push. |
| Can the Worker read a note? | Yes, through the binding (`repo.readFile`), about 0.9 s cold. |
| Does the event list changed files? | **No.** It lists commits (`before`, `after`), not added/modified/removed files. |
| Can the Worker write? | **Not through the binding**, which is read-only. Writes go through the Git protocol. |
| Do Git tokens expire? | Yes: repo-scoped tokens default to 24 hours; the TTL is configurable. |

## Decision

Move the notes from GitHub to an Artifacts repository.

- **Reads:** the Worker reads through the Artifacts binding. No token.
- **Writes:** through Git, from a Durable Object that owns the repository ([ADR 008](008-one-durable-object-per-repository.md)).
- **Indexing:** subscribe the repository's `pushed` events to a Queue. The indexer diffs the `before` and `after` trees (`readCommit` + `readTree`, only descending into changed subtrees) to find added, modified and removed notes.
- **The Mac:** keeps a Git clone with the Artifacts remote. The sync hook asks the Worker for a fresh repo-scoped token instead of storing a long-lived one.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Stay on GitHub** | Keeps the token, the API limits and the webhook without retry. A Durable Object could serialize writes in front of GitHub too, so concurrency alone isn't a reason to move; the limits and the event path are. |
| **R2 with event notifications** | No Git history or diffs, and no way for the Mac to sync with plain Git. |

## Consequences

**Gained**
- No GitHub token and no webhook secret: access is through a binding.
- No 5,000-per-hour API cap or 500-writes-per-hour secondary limit.
- Push events land in a Queue, with retries and a dead-letter queue, instead of a webhook that fails silently.
- Ready for many repositories: one per client or team at scale.

**Costs**
- **Writes need a Git client inside a Durable Object** (isomorphic-git): commit, push, and retry when the Mac pushes in between. On GitHub this was one REST call.
- **The indexer must diff trees,** since the event doesn't list changed files.
- **The Mac hook must refresh tokens.**
- **Beta:** the API may change.
- **More lock-in** to Cloudflare, and the Workers Paid plan (US$ 5/month; Artifacts usage at this volume stays within the included 10,000 operations and 1 GB).

## Revisit when

- The Artifacts beta changes its API or proves unreliable.
- The Git write path costs more in bugs and maintenance than it saves.
- Artifacts adds a write API to the binding, or changed files to the push event: both would remove a cost above.

## Related

- [ADR 001: GitHub as the source of truth](001-github-as-source-of-truth.md) (superseded)
- [ADR 003: Sync with Claude Code hooks and a push webhook](003-sync-with-claude-code-hooks-and-a-push-webhook.md)
- [Issue #26](https://github.com/YudiG12/second-brain-mcp/issues/26)
