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

**One writer for the index: the Queue consumer.** Three things want to change the index: push events, the reconciliation, and the MCP write tools. Without an order between them, a reconciliation could delete the vectors of a note created while it ran, or re-index an old version over a newer one. So:

- The **Queue consumer is the only component that writes to the index.** Push events, reconciliation fixes and MCP writes (the tools enqueue the note after pushing, [ADR 007](007-cloudflare-artifacts-for-the-notes.md)) all go through the Queue. It runs one batch at a time (`max_concurrency: 1`).
- **Every index write re-checks the note at the head of `main` right before acting:** if the note exists, index what was just read and record that sha; if it is gone, delete its vectors. Nothing acts on a sha remembered from earlier.
- **The manifest records only what was written:** after writing Vectorize, the consumer re-reads the head and records the sha only if the note didn't change meanwhile; otherwise it re-enqueues the note ([ADR 010](010-index-manifest-in-d1.md)). Messages are processed one at a time, also inside a batch.
- **Two message shapes:** a `pushed` event (`ref`, `before`, `after`) from Artifacts, and an `index` message (`path`) from the tools and the reconciliation.

**Indexing each change: a Cloudflare Queue.**
- The `pushed` events go to the Queue.
- A failed message is retried up to 5 times (`max_retries: 5`; the default is 3) with growing delays: the consumer calls `msg.retry({ delaySeconds })` with a delay that doubles each attempt.
- After the last retry, the message goes to a **dead-letter queue**. A small consumer on the dead-letter queue sends a notification and keeps the message for manual replay (a dead-letter queue has no alert of its own, and without a consumer its messages are deleted after 4 days).

**Reconciliation and full rebuild: a Cloudflare Workflow on a daily schedule** (Workflows support cron schedules natively), or started on demand. Each step's result is saved, so a failure resumes from the step that failed. Two runs may overlap (a scheduled and an on-demand one); that is safe because the Workflow only enqueues and the Queue consumer re-checks each path at head.

1. **Snapshot the source:** the head commit of `main`, and every note at that commit with its content sha.
2. **Snapshot the index:** read the manifest (note → sha → chunk count, [ADR 010](010-index-manifest-in-d1.md)).
3. **Compare:** new notes, changed notes (different sha), orphans (in the manifest, not in the source).
4. **Enqueue the fixes:** one Queue message per affected note, in batches of about 20 per step. The consumer applies them with the head re-check above, so a note that changed or reappeared since the snapshot is handled correctly.
5. **Report:** how many notes needed fixing, **excluding notes changed after the snapshot commit** (those are in flight, not missed). A high number means events are being lost and raises a notification.

A **full rebuild** is the same Workflow, except the index snapshot comes from Vectorize instead of the manifest: `list-vectors` returns every id, and orphans are the ids not expected from the source (ids are `hash(path)-seq`, so the comparison is a set difference against the expected ids). `list-vectors` is only available through the REST API and Wrangler, not the binding, so the Workflow needs a Cloudflare API token with Vectorize read access as a secret. Orphan-row removals also go through the Queue, so the consumer stays the only manifest writer. This replaces v1's `/reindex`, which never cleaned up ([#8](https://github.com/YudiG12/second-brain-mcp/issues/8)).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **A Queue for both** | Reconciliation would need its own "where did I stop" bookkeeping; a Workflow saves step results for free. |
| **A Workflow for both** (Artifacts events can start a Workflow directly) | Works, but each push becomes a Workflow instance with step overhead and step billing, for a job that is one atomic task. |
| **A plain Cron-triggered Worker for reconciliation** | No resume: a failure in the middle restarts everything, and one invocation has CPU and subrequest limits that a large repository can hit. |
| **No reconciliation, just retries** | Retries only cover messages that reach the Queue; events that never arrive would still be lost. |
| **The Workflow writes to the index itself** | A second writer racing the consumer: it could delete a note created mid-run or regress one that changed. Enqueueing keeps a single writer. |
| **Blue/green rebuild** (build a fresh index, then switch the binding) | Avoids a half-rebuilt index, but needs a deploy to switch and doubles storage during the build; the enqueue-based rebuild keeps serving search throughout. |

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
- **A Cloudflare API token** for the rebuild's `list-vectors` call: one more secret. It is optional: without it, a rebuild still re-indexes every note and removes manifest orphans, but can't find vectors left without a manifest row (spec v2 §8).
- **Fixes from reconciliation are not instant:** they go through the same Queue as everything else.
- **Up to a day of staleness** for an event that never arrives.

## Revisit when

- The report shows frequent fixes: run reconciliation more often, or investigate event delivery.
- The corpus grows enough that a full snapshot each day is expensive: reconcile incrementally (only notes changed since the last run). A Workflow step's return value is also capped at 1 MiB, so very large note lists would have to be stored outside the step result.

## Related

- [ADR 007: Cloudflare Artifacts for the notes](007-cloudflare-artifacts-for-the-notes.md)
- [ADR 008: One Durable Object per repository for writes](008-one-durable-object-per-repository.md)
- [PRD v2](../prd/v2.md) (P3, P4)
- [ADR 010: The index manifest in D1](010-index-manifest-in-d1.md)
- Issues [#6](https://github.com/YudiG12/second-brain-mcp/issues/6), [#7](https://github.com/YudiG12/second-brain-mcp/issues/7), [#8](https://github.com/YudiG12/second-brain-mcp/issues/8)
