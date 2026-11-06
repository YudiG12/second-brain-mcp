# ADR 008: One Durable Object per repository for writes

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |

## Context

v1 can silently lose a concurrent edit: `edit_note` reads the note, computes the new text, and only then fetches the file's `sha`, so another edit in between is overwritten ([#5](https://github.com/YudiG12/second-brain-mcp/issues/5)).

In v2 the notes move to Cloudflare Artifacts, and the Artifacts binding is read-only, so the Worker writes through Git (ADR 007, in review). That changes what has to be serialized. A Git commit is a snapshot of the **whole repository** that points to the previous commit, and `main` points to the latest one. Two edits to *different* notes, started from the same commit, race for the tip of the branch: the first push wins, the second is rejected because the tip moved.

## Decision

All writes go through **one Durable Object per repository**. It:

- handles one request at a time, so writes are queued instead of racing;
- keeps a working copy of the repository in its SQLite storage (each Git object stored separately; a row is limited to 2 MB), so a write only fetches what changed since the last one;
- commits and pushes with a Git client (isomorphic-git); if the Mac pushed in between and the push is rejected, it fetches again and retries;
- answers only after the push succeeds, so "Saved" means the change is in Artifacts.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **One Durable Object per note** | Serializes edits to the same note, but two different notes still race for the branch tip and one push is rejected. Right while writes went through the GitHub REST API (the conflict was per file), wrong once commits are per repository. |
| **Read content and `sha` together, retry on `409`** | Fixes the lost update on the GitHub REST API only. |
| **Clone into the Worker on every write, no state** | Downloads the repo on every write, and concurrent writes conflict and need retries. |

## Consequences

**Gained**
- No lost edits and no rejected pushes between MCP writes.
- Fast writes: the working copy is already in the Durable Object.
- Fits within limits: 10 GB storage and 128 MB memory per object, against notes of about 1.3 MB today.

**Costs**
- **One queue per repository.** A slow push blocks every write behind it (head-of-line blocking), and many concurrent writers make the queue long. A single object also has a soft limit of about 1,000 requests per second.
- **A custom storage adapter** so the Git client can read and write objects in the Durable Object's SQLite.
- **Large binary files don't fit in one row** (2 MB): images or PDFs would have to live elsewhere, such as R2.

**Mitigations, when needed**
- **Shard by repository:** one repository per client or team, each with its own Durable Object.
- **A timeout on the push,** so one slow write fails clearly instead of holding the queue.
- **Group commits:** when several writes are waiting, apply them in one commit and one push.

## Revisit when

- Write latency grows because of the queue (watch queue depth and push duration).
- The system serves several users or teams: split into one repository per unit of work.

## Related

- [Issue #5](https://github.com/YudiG12/second-brain-mcp/issues/5)
- [ADR 005: Every edit is a commit](005-one-commit-per-edit.md)
