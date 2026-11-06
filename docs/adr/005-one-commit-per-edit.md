# ADR 005: Every edit is a commit

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-05 |
| **Deciders** | Yudi Ganeko |

## Context

The MCP tools let any client create, edit, move and delete notes ([ADR 001](001-github-as-source-of-truth.md) makes GitHub the source of truth). The Worker is stateless: nothing survives between requests. Each write has to end up in Git, and the question is when.

## Decision

Every write tool commits to GitHub immediately, one commit per edit, before answering. Commit messages say what happened and where it came from, e.g. `edit: projetos/x.md (via MCP)`. `move_note` is the exception that needs two commits (write, then delete).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Batch edits and commit periodically** (e.g. one commit per minute) | The Worker has nowhere to hold pending edits: in memory they are lost if the Worker restarts, and a Durable Object or KV buffer is one more component to run. |
| **Write to a temporary store, consolidate into Git later** | Same problem, plus two places that can disagree. Worth it only at a much higher write volume (see "Revisit when"). |

## Consequences

**Gained**
- **Durable on answer.** When a tool says "Saved", the change is already in Git. There is no temporary state to lose.
- **Granular history.** Each change can be undone on its own, and the log shows what changed, when, and through which path.
- **Fresh for every client.** `read_note` and `search_notes` read GitHub directly, so other clients see a change as soon as it is committed.

**Costs**
- **Each write waits for GitHub:** two or three API calls (fetch the `sha`, write).
- **GitHub API budget:** 5,000 requests per hour, shared by every client.
- **Noisy history:** many small commits.
- **Every commit triggers the webhook,** so every edit is re-embedded.
- **`move_note` is two commits and not atomic** ([#10](https://github.com/YudiG12/second-brain-mcp/issues/10)).

## Revisit when

- **Many agents write at once** (a firm-wide shared memory). The first limits hit are the GitHub rate limit, roughly 2,000 edits an hour across all clients, and the single branch, where concurrent commits collide even on different files. The answer is to take Git off the hot path: write to a durable store first (a Durable Object per document, or D1), answer right away, and batch commits to Git in the background, so Git becomes the history rather than the bottleneck.
- **The notes move to Cloudflare Artifacts (v2),** which is built for agents writing to repositories.

## Related

- [ADR 001: GitHub as the source of truth](001-github-as-source-of-truth.md)
- [ADR 003: Sync with Claude Code hooks and a push webhook](003-sync-with-claude-code-hooks-and-a-push-webhook.md)
- [Spec v1](../spec/v1.md), sections 3 and 6
