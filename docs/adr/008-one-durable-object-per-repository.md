# ADR 008: One Durable Object per repository for writes

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |

## Context

v1 can silently lose a concurrent edit: `edit_note` reads the note, computes the new text, and only then fetches the file's `sha`, so another edit in between is overwritten ([#5](https://github.com/YudiG12/second-brain-mcp/issues/5)).

In v2 the notes move to Cloudflare Artifacts, whose binding is read-only, so the Worker writes through Git ([ADR 007](007-cloudflare-artifacts-for-the-notes.md)). That changes what has to be serialized. A Git commit is a snapshot of the **whole repository** that points to the previous commit, and `main` points to the latest one. Two edits to *different* notes, started from the same commit, race for the tip of the branch: the first push wins, the second is rejected because the tip moved.

## Decision

All writes go through **one Durable Object per repository**, which:

- **serializes writes explicitly** with `ctx.blockConcurrencyWhile`. A Durable Object runs one piece of code at a time, but while it awaits network I/O (the push) it lets other requests in. In the spike, eight simultaneous writes interleaved and collided until each write was wrapped in `blockConcurrencyWhile`; then all eight landed, in order, with no retries;
- **keeps a working copy** of the repository (a shallow clone, isomorphic-git on an in-memory file system), so only the first write after the object starts pays for a clone (about 1 s); later writes only push (about 0.7 s). If the object is evicted, the next write clones again. Persisting the working copy in the object's SQLite storage is deferred until cold clones become slow;
- **retries when the Mac pushed in between:** the push is rejected, the object fetches the new tip, re-applies the change and pushes again;
- **confirms before reporting failure:** if a push returns an error or an unreadable response, the object checks the branch head before answering, because under concurrency Artifacts sometimes failed to answer for a push that had landed. A write is reported as failed only if its commit is not on `main`;
- **answers only after the push succeeds,** so "Saved" means the change is in Artifacts.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **One Durable Object per note** | Serializes edits to the same note, but two different notes still race for the branch tip and one push is rejected. Right while writes went through the GitHub REST API (the conflict was per file), wrong once commits are per repository. |
| **Rely on the Durable Object's single-threading, no explicit serialization** | Disproved by the spike: requests interleave across awaits on network I/O. |
| **Read content and `sha` together, retry on `409`** | Fixes the lost update on the GitHub REST API only. |
| **Clone into the Worker on every write, no state** | Downloads the repo on every write, and concurrent writes conflict and need retries. |

## Consequences

**Gained**
- No lost edits and no rejected pushes between MCP writes (8/8 in the spike).
- Fast writes after the first one: about 0.7 s.
- Fits within limits: 128 MB memory per object against notes of about 1.3 MB today.

**Costs**
- **One queue per repository.** `blockConcurrencyWhile` holds every other request until the write finishes, so a slow push blocks everyone behind it (head-of-line blocking), and many concurrent writers make the queue long. A single object also has a soft limit of about 1,000 requests per second.
- **Deploys overlap:** after a deploy, the previous version kept answering for a while (longer than 20 s in the spike). New code must work alongside the old one during a rollout, and any persisted state must stay readable by both.
- **Large binary files don't fit** a 2 MB storage row if the working copy is ever persisted: images or PDFs would live elsewhere, such as R2.

**Mitigations, when needed**
- **Shard by repository:** one repository per client or team, each with its own Durable Object.
- **A timeout on the push,** so one slow write fails clearly instead of holding the queue.
- **Group commits:** when several writes are waiting, apply them in one commit and one push.

## Revisit when

- Write latency grows because of the queue (watch queue time and push duration).
- Cold clones become slow as the repository grows: persist the working copy.
- The system serves several users or teams: split into one repository per unit of work.

## Related

- [ADR 007: Cloudflare Artifacts for the notes](007-cloudflare-artifacts-for-the-notes.md)
- [ADR 005: Every edit is a commit](005-one-commit-per-edit.md)
- [Issue #5](https://github.com/YudiG12/second-brain-mcp/issues/5)
