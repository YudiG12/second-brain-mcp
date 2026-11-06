# ADR 003: Sync with Claude Code hooks and a GitHub push webhook

| | |
|---|---|
| **Status** | Accepted for v1; in v2, [ADR 007](007-cloudflare-artifacts-for-the-notes.md) supersedes the GitHub webhook (push events into a Queue) and the pull throttle (10 minutes, and no fetch on `push` without changes) |
| **Date** | 2026-11-05 |
| **Deciders** | Yudi Ganeko |

## Context

With GitHub as the source of truth ([ADR 001](001-github-as-source-of-truth.md)), two copies must follow it:

1. **The clone on the Mac**, where the agents read and write notes as local files.
2. **The Vectorize index**, which must reflect every added, edited and deleted note ([ADR 002](002-semantic-search-with-workers-ai-and-vectorize.md)).

The first version synced with a script run by hand, which meant changes waited until someone remembered to run it.

## Decision

Sync both copies on events, not on a schedule:

- **Mac ↔ GitHub: Claude Code hooks** ([`clients/claude-code`](../../clients/claude-code/)). Pull when a session starts and on each message (at most once a minute); commit and push after each answer.
- **GitHub → index: a push webhook.** GitHub calls the Worker on every push; the Worker verifies the HMAC signature and re-indexes the notes that changed or removes the ones deleted.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **A scheduled job on the Mac** (launchd or cron running pull and push every few minutes) | Runs even when Claude Code is closed and retries on its own, but the agent could read notes minutes out of date, and it runs all day when nothing changes. |
| **Polling GitHub from the Worker** (a Cron Trigger checking for changes every minute) | Heals itself, since anything missed is picked up on the next run, but updates are slower and every check spends GitHub API calls even when nothing changed. |
| **Manual script** (the first version) | Depended on remembering to run it. |

## Consequences

**Gained**
- The agent pulls right before it reads and pushes right after it writes, so it doesn't work on stale notes.
- Re-indexing starts seconds after a push, and nothing runs when nothing changes. The change becomes searchable after webhook delivery plus Vectorize's own delay (median under 30 seconds, p99 under 2 minutes, per Cloudflare); we observed about a minute.

**Costs**
- **Tied to Claude Code.** Sync only runs inside Claude Code sessions: an edit made in another editor waits for the next session, and another AI client would need its own hooks.
- **Setup on each machine:** a symlink and a settings block.
- **Failures are silent on both sides.** A webhook that fails is never retried, since GitHub doesn't redeliver on its own; edits heal on the next change, deletions never do ([#6](https://github.com/YudiG12/second-brain-mcp/issues/6)). On the Mac, a rebase conflict or two sessions running git at once stop sync without an error ([#15](https://github.com/YudiG12/second-brain-mcp/issues/15), [#16](https://github.com/YudiG12/second-brain-mcp/issues/16)).
- **A public endpoint:** the webhook relies on the HMAC secret so only GitHub can call it.

The production answer to the silent failures is to keep events for freshness and add a periodic reconciliation as a safety net ([#7](https://github.com/YudiG12/second-brain-mcp/issues/7)).

## Revisit when

- **v2, for resilience:** add retries ([#6](https://github.com/YudiG12/second-brain-mcp/issues/6)) and reconciliation ([#7](https://github.com/YudiG12/second-brain-mcp/issues/7)), and make hook failures visible.
- **The notes move to Cloudflare Artifacts (v2).** The webhook would be replaced by whatever change notification Artifacts provides, which is still to be confirmed. The Mac side stays Git, with a different remote.
- **Notes start being edited outside Claude Code** often enough that waiting for the next session hurts.

## Related

- [ADR 001: GitHub as the source of truth](001-github-as-source-of-truth.md)
- [ADR 002: Semantic search with Workers AI and Vectorize](002-semantic-search-with-workers-ai-and-vectorize.md)
- [Spec v1](../spec/v1.md), sections 5.2 and 5.5
