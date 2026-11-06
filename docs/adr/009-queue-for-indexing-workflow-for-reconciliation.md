# ADR 009: A Queue for indexing, a Workflow for reconciliation

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |

## Context

In v1, indexing after a push runs in the background with no retry, so a failure leaves the index silently stale ([#6](https://github.com/YudiG12/second-brain-mcp/issues/6)). Nothing ever compares the notes with the index, so missed updates and deletions stay forever ([#7](https://github.com/YudiG12/second-brain-mcp/issues/7)), and `/reindex` only upserts existing notes, so it can't remove what shouldn't be there ([#8](https://github.com/YudiG12/second-brain-mcp/issues/8)).

In v2, every push to the notes repository emits an Artifacts `pushed` event ([ADR 007](007-cloudflare-artifacts-for-the-notes.md)). Delivery of those events isn't documented as guaranteed, so even with retries something has to catch what never arrives.

The two jobs have different shapes:

| | Indexing a change | Reconciliation |
|---|---|---|
| Size | One push: a few notes | Every note in the repository |
| Shape | One atomic task: re-run it whole if it fails | Several steps; a failure halfway should resume, not restart |
| Frequency | Every push | Once a day, or on demand |

## Decision

**Indexing each change: a Cloudflare Queue.**
- The `pushed` events go to the Queue. One consumer runs at a time (`max_concurrency: 1`), as ADR 007 requires for ordering.
- A failed message is retried with growing delays, up to 5 times. After that it goes to a **dead-letter queue**, and anything landing there raises an alert.
- The consumer's work is idempotent (stable ids, upserts, read at the head of `main`), so a retry never duplicates or regresses anything.

**Reconciliation and full rebuild: a Cloudflare Workflow**, started daily by a Cron Trigger, or on demand. Each step's result is saved, so a failure resumes from the step that failed:

1. **Snapshot the source:** list every note at the head of `main`, with its content sha.
2. **Snapshot the index:** read the manifest (note → sha → chunk count, ADR 010, to be written).
3. **Compare:** new notes (not in the manifest), changed notes (different sha), orphans (in the manifest, not in the source).
4. **Re-index in batches** of about 20 notes, one step per batch: read, embed, upsert, update the manifest.
5. **Delete orphans:** their vectors and their manifest rows.
6. **Report:** how many notes were fixed. A high number means events are being lost and raises an alert.

A **full rebuild** is the same Workflow with an empty index snapshot: everything is "new", and orphans are found through Vectorize's `list-vectors`. This replaces v1's `/reindex`, which never cleaned up ([#8](https://github.com/YudiG12/second-brain-mcp/issues/8)).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **A Queue for both** | Reconciliation would need its own "where did I stop" bookkeeping; a Workflow saves step results for free. |
| **A Workflow for both** (Artifacts events can start a Workflow directly) | Works, but each push becomes a Workflow instance with step overhead and step billing, for a job that is one atomic task. |
| **A plain Cron-triggered Worker for reconciliation** | No resume: a failure in the middle restarts everything, and one invocation has CPU and subrequest limits that a large repository can hit. |
| **No reconciliation, just retries** | Retries only cover messages that reach the Queue; events that never arrive would still be lost. |

## Consequences

**Gained**
- No silent staleness: failed indexing is retried, and what still fails is visible in the dead-letter queue.
- Missed events and deletions are healed within a day.
- A real rebuild that also removes orphans.
- The reconciliation report doubles as a health signal for event delivery.

**Costs**
- **Two mechanisms** to configure, monitor and test instead of one.
- **Workflow billing:** steps and storage (500,000 steps a month included on Workers Paid). One user's daily run is a few dozen steps.
- **Every step must be idempotent,** because Workflows and Queues both re-run work after failures.
- **Up to a day of staleness** for an event that never arrives.

## Revisit when

- The report shows frequent fixes: run reconciliation more often, or investigate event delivery.
- The corpus grows enough that a full snapshot each day is expensive: reconcile incrementally (only notes changed since the last run).

## Related

- [ADR 007: Cloudflare Artifacts for the notes](007-cloudflare-artifacts-for-the-notes.md)
- ADR 010: the reconciliation manifest (to be written)
- Issues [#6](https://github.com/YudiG12/second-brain-mcp/issues/6), [#7](https://github.com/YudiG12/second-brain-mcp/issues/7), [#8](https://github.com/YudiG12/second-brain-mcp/issues/8)
