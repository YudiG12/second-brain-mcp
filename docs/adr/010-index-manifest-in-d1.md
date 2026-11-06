# ADR 010: The index manifest in D1

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |

## Context

Reconciliation ([ADR 009](009-queue-for-indexing-workflow-for-reconciliation.md)) compares the notes with the index. Taking a snapshot of the notes is easy (one tree read at the head of `main`). Taking a snapshot of the index is not: Vectorize only lists ids through the REST API, not the binding, and an id (`hash(path)-seq`) doesn't say which content version it holds.

There are two other needs:
- **Knowing what is actually indexed:** a late or retried message must not leave the manifest claiming a version that isn't in Vectorize, or reconciliation would never fix it.

## Decision

Keep a **manifest of what is in the index** in a D1 table:

| Column | Meaning |
|---|---|
| `path` (primary key) | The note's path |
| `sha` | The content sha of the version currently indexed |
| `chunks` | How many chunks that version has |
| `indexed_at` | When it was indexed |

- **Only the Queue consumer writes it,** the same component that writes Vectorize ([ADR 009](009-queue-for-indexing-workflow-for-reconciliation.md)), including during a full rebuild.
- **The consumer handles one message at a time** (`max_concurrency: 1`, and messages in a batch processed sequentially, not in parallel).
- **Record only what was written:** for each note, the consumer reads the content at the head of `main`, writes Vectorize, then **re-reads the head**. If the note's sha is still the one it indexed, it records that sha in the manifest; if the note changed in the meantime, it records nothing and re-enqueues the note. So the manifest never claims a version that isn't in Vectorize. (A content sha has no order, so "newer wins" can't be decided by comparing shas; the post-write check replaces that.)
- **Skip work that is already done:** if the manifest already holds the head sha for a note, the consumer skips the embedding. This absorbs the duplicate message every MCP write produces (the tool enqueues the note, and the Durable Object's push also emits a `pushed` event).
- **Deletes don't depend on it:** a delete removes the whole id range `hash(path)-0` to `hash(path)-(MAX_CHUNKS-1)`, then the row, so vectors written before a failed manifest update can't be left behind.
- **Reconciliation reads it** as the index snapshot, so the daily run never has to list Vectorize. Only a full rebuild does.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Store the sha in the metadata of each note's chunk 0 in Vectorize** | No extra component, but no conditional write (a late upsert simply wins), and listing all ids still needs the REST API and a Cloudflare token. |
| **List Vectorize on every reconciliation** (`list-vectors`) | Needs a token in the Worker, scans the whole index daily, and still doesn't say which version each id holds. |
| **KV** | Eventually consistent (writes take up to about a minute to be visible everywhere), no conditional writes, and listing all keys is paginated and slower than one `SELECT`. |
| **The Durable Object's own SQLite** | Durable, but it couples the manifest to the Git writer and makes the Workflow and the consumer call the Durable Object for every read. |

## Consequences

**Gained**
- A cheap, exact index snapshot: one `SELECT`.
- The manifest always matches what is in Vectorize, so reconciliation can trust it.
- Skipping duplicate indexing work.

**Costs**
- **One more store to keep in sync with Vectorize.** If a write updates Vectorize but fails before the manifest, the two disagree until reconciliation sees the missing or old row and re-indexes the note: an extra re-index, never a missing one, since deletes use the full id range.
- **D1 limits and pricing:** negligible at this volume (Workers Paid includes 25 billion rows read and 50 million rows written a month).

## Revisit when

- The manifest and Vectorize often disagree in reconciliation reports.
- Vectorize gains conditional writes or listing through the binding, which would make the manifest redundant.

## Related

- [ADR 009: A Queue for indexing, a Workflow for reconciliation](009-queue-for-indexing-workflow-for-reconciliation.md)
- [ADR 007: Cloudflare Artifacts for the notes](007-cloudflare-artifacts-for-the-notes.md)
- Issues [#7](https://github.com/YudiG12/second-brain-mcp/issues/7), [#9](https://github.com/YudiG12/second-brain-mcp/issues/9)
- [ADR 006](006-wrangler-and-a-setup-script-instead-of-terraform.md)
