# ADR 010: The index manifest in D1

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |

## Context

Reconciliation ([ADR 009](009-queue-for-indexing-workflow-for-reconciliation.md)) compares the notes with the index. Taking a snapshot of the notes is easy (one tree read at the head of `main`). Taking a snapshot of the index is not: Vectorize only lists ids through the REST API, not the binding, and an id (`hash(path)-seq`) doesn't say which content version it holds.

There are two other needs:
- **Out-of-order writes:** a late or retried message carrying an old version of a note must not overwrite a newer one.
- **Deletes:** to remove a note's vectors, the indexer must know how many chunks it had.

## Decision

Keep a **manifest of what is in the index** in a D1 table:

| Column | Meaning |
|---|---|
| `path` (primary key) | The note's path |
| `sha` | The content sha of the version currently indexed |
| `chunks` | How many chunks that version has |
| `indexed_at` | When it was indexed |

- **Every index write updates it,** in the Queue consumer, the only index writer ([ADR 009](009-queue-for-indexing-workflow-for-reconciliation.md)).
- **Updates are conditional:** a write records its sha only if the row is missing or holds a different version than the one just read at the head of `main`. A message that read an older version loses the race and changes nothing.
- **Deletes use it:** the indexer deletes ids `hash(path)-0` to `hash(path)-(chunks-1)`, then the row.
- **Reconciliation reads it** as the index snapshot, so the daily run never has to list Vectorize. Only a full rebuild does.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Store the sha in the metadata of each note's chunk 0 in Vectorize** | No extra component, but no conditional write (a late upsert simply wins), and listing all ids still needs the REST API and a Cloudflare token. |
| **List Vectorize on every reconciliation** (`list-vectors`) | Needs a token in the Worker, scans the whole index daily, and still doesn't say which version each id holds. |
| **KV** | Eventually consistent (writes take up to about a minute to be visible everywhere), no conditional writes, and listing all keys is paginated and slower than one `SELECT`. |
| **The Durable Object's own SQLite** | Would tie the manifest to the writer's lifecycle and make the Workflow and consumer call the Durable Object for every read. |

## Consequences

**Gained**
- A cheap, exact index snapshot: one `SELECT`.
- Protection against stale writes, the same idea as a versioned upsert in an event consumer.
- Deletes without listing Vectorize.

**Costs**
- **One more store to keep in sync with Vectorize.** If a write updates Vectorize but fails before the manifest, the two disagree until reconciliation; the order is Vectorize first, manifest last, so a disagreement only causes an extra re-index, never a missing one.
- **D1 limits and pricing:** negligible at this volume (Workers Paid includes 25 billion rows read and 50 million rows written a month).

## Revisit when

- The manifest and Vectorize often disagree in reconciliation reports.
- Vectorize gains conditional writes or listing through the binding, which would make the manifest redundant.

## Related

- [ADR 009: A Queue for indexing, a Workflow for reconciliation](009-queue-for-indexing-workflow-for-reconciliation.md)
- [ADR 007: Cloudflare Artifacts for the notes](007-cloudflare-artifacts-for-the-notes.md)
- Issues [#7](https://github.com/YudiG12/second-brain-mcp/issues/7), [#9](https://github.com/YudiG12/second-brain-mcp/issues/9)
