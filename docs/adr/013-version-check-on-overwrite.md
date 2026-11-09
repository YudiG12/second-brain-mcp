# ADR 013: A version check on whole-note overwrites

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Deciders** | Yudi Ganeko |

## Context

Writes are serialized by one Durable Object per repository ([ADR 008](008-one-durable-object-per-repository.md)). That protects an operation only if its whole read-modify-write happens inside the lock.

- `edit_note` sends "replace this passage with that one". The writer reads the note inside the lock, so a concurrent change either merges or fails ("old_text appears 0 times").
- `write_note` sends the whole new text. The agent read the note **earlier, outside the lock**, while the model thought about it. Two agents that read the same version and both overwrite lose the first change silently (a lost update). It happens even with two MCP clients and no Mac: each push succeeds, so the retry on a rejected push never runs. Re-running the operation on a new tip also doesn't help, because re-running an overwrite writes the stale text again.

## Decision

Optimistic concurrency, like an HTTP ETag with `If-Match`:

- A note's **version** is the first 12 hex characters of the SHA-256 of its content. `read_note` returns it in a separate content block, so an agent rewriting the note doesn't copy it into the text.
- `write_note` takes an optional `expected_version`. Inside the lock, the writer compares it with the current version:
  - matches: write;
  - differs, or the note was deleted: `failed` with code `conflict`, nothing written, and a message telling the agent to read again and redo its change;
  - missing on an existing note: `conflict` too. Overwriting needs a version; creating a new note doesn't.
- The check runs on every attempt, so when a push is rejected and the operation re-runs on the new tip, a change the Mac pushed to the same note is a conflict too.
- **The agent resolves the conflict**, not the server: only the agent knows what the change was meant to do.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Lock on `read_note` until the write (pessimistic) | The critical section would include the model's think time, which is unbounded; most reads never write; a client can vanish holding the lock, so it would need leases, and leases need fencing tokens, which are a version check anyway. The Mac writes through Git and wouldn't honour the lock. |
| Server-side three-way merge (base = the version the agent read) | Fewer conflicts, but needs the base content and a merge algorithm. Worth it if conflicts become common; for one user they're rare. |
| An LLM on the server resolves conflicts | It doesn't know the intent, it would decide silently, and it adds model cost to a path that has none. |
| Keep last-write-wins and only nudge agents to `edit_note` | An instruction, not a contract: an agent can ignore it and lose data silently. |

## Consequences

- No silent lost update through MCP. A stale overwrite fails loudly instead.
- An extra field on `write_note`, and occasionally a re-read and a retry by the agent.
- Clients that overwrote existing notes without reading them first now get a conflict and must read first.
- The Mac clone is unchanged: its pushes merge, and a real conflict is kept as a `.conflict` copy (#50).
