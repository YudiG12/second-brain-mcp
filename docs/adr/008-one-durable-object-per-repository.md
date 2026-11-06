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

All writes go through **one Durable Object per repository**.

- **It receives operations, not content.** The Worker sends `write(path, content)`, `edit(path, old_text, new_text)`, `move(from, to)` or `delete(path)`. The object reads and changes its own working copy while holding the lock, so a read-modify-write can't be interleaved. Reading through the binding in the Worker and sending the result would bring #5 back.
- **It serializes writes with an in-memory mutex** (a promise chain: each write starts when the previous one settles). A Durable Object runs one piece of code at a time, but while it awaits network I/O (the push) it lets other requests in. In the spike, simultaneous writes without explicit serialization interleaved and collided; with the mutex, 16 of 16 simultaneous writes landed, each waiting for the previous one (about 0.54 s per write).
- **It keeps a working copy** of the repository: a shallow clone, isomorphic-git on an in-memory file system. A write on a warm object only pushes. An idle object is evicted after a short time (on the order of a minute or two), so for one user writing occasionally **most writes are cold**: about 1 s of clone plus the push, and each clone is a billed Artifacts operation ([ADR 007](007-cloudflare-artifacts-for-the-notes.md), Costs). Persisting the working copy in the object's SQLite storage is deferred until cold clones become a problem.
- **It authenticates to Artifacts** with a repo-scoped token from the binding (`createToken`), reused until shortly before it expires.
- **When the Mac pushed in between,** the push is rejected; the object fetches the new tip and **re-runs the operation** on it. For `edit`, that means checking again that `old_text` appears exactly once, and failing if it doesn't, instead of replaying a result computed from the old tip.
- **It confirms before reporting failure.** If a push returns an error or an unreadable response, the object checks the remote branch head and resets its local branch to it. The write is reported as failed only if its commit is not on `main`, and as "unknown" if the check itself fails, so a client doesn't blindly write twice. Under concurrency, Artifacts sometimes failed to answer for a push that had landed.
- **It answers only after the push succeeds,** so "Saved" means the change is in Artifacts. Each operation is still its own commit ([ADR 005](005-one-commit-per-edit.md)), and `move` becomes a single commit, which fixes the non-atomic move ([#10](https://github.com/YudiG12/second-brain-mcp/issues/10)).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **One Durable Object per note** | Serializes edits to the same note, but two different notes still race for the branch tip and one push is rejected. Right while writes went through the GitHub REST API (the conflict was per file), wrong once commits are per repository. |
| **Rely on the Durable Object's single-threading, no explicit serialization** | Disproved by the spike: requests interleave across awaits on network I/O. |
| **`ctx.blockConcurrencyWhile` around each write** | Also serialized correctly in the spike, but Cloudflare reserves it for initialization: it has a 30 s timeout and resets the object (losing the working copy and every queued request) on timeout or on a thrown error, and it blocks every other call to the object, even a health check. |
| **Read content and `sha` together, retry on `409`** | Fixes the lost update on the GitHub REST API only. |
| **Clone into the Worker on every write, no state** | Downloads the repo on every write, and concurrent writes conflict and need retries. |
| **Write to a durable store first, batch commits to Git later** | See [ADR 007](007-cloudflare-artifacts-for-the-notes.md): kept as the path if write latency becomes a problem. |

## Consequences

**Gained**
- No lost or rejected MCP writes (16/16 simultaneous writes in the spike). The acceptance test is #5's: two concurrent edits to the same note, and to different notes, lose nothing.
- One commit per move ([#10](https://github.com/YudiG12/second-brain-mcp/issues/10)).
- Fits within limits: 128 MB of memory per isolate, against notes of about 1.3 MB today.

**Costs**
- **One queue per repository, with a ceiling.** At about 0.54 s per write, one repository handles roughly 1.8 writes per second (about 6,500 an hour). That is well above GitHub's ~500 content-creating requests per hour, but it is a cap. A slow push also blocks every write behind it (head-of-line blocking).
- **Cold writes are slower,** since an idle object loses its working copy.
- **Deploys overlap:** after a deploy, the previous version kept answering for a while (longer than 20 s in the spike). Code must tolerate old and new versions during a rollout, and a reset in the middle of a push falls into the "confirm before reporting failure" path. Cloudflare guarantees one instance per object ID at a time (to verify against the Durable Objects known-issues page for the update window).
- **Large binary files don't fit** a 2 MB storage row if the working copy is ever persisted: images or PDFs would live elsewhere, such as R2.

**Mitigations, when needed**
- **Shard by repository:** one repository per client or team, each with its own Durable Object.
- **A timeout on the push,** so one slow write fails clearly instead of holding the queue.
- **One push for several waiting commits:** each operation stays its own commit (ADR 005 holds), but they go out in a single push.

## Revisit when

- Writes approach about one per second per repository, or queue time shows up in write latency.
- Cold clones become slow as the repository grows: persist the working copy.
- The system serves several users or teams: split into one repository per unit of work.

## Related

- [ADR 007: Cloudflare Artifacts for the notes](007-cloudflare-artifacts-for-the-notes.md)
- [ADR 005: Every edit is a commit](005-one-commit-per-edit.md)
- Issues [#5](https://github.com/YudiG12/second-brain-mcp/issues/5), [#10](https://github.com/YudiG12/second-brain-mcp/issues/10)
