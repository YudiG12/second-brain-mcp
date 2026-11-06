import { chunk, idsFrom, MAX_CHUNKS, pathHash } from "../lib/notes";
import type { Deps, IndexMessage, Outcome, PushedEvent, QueueMessage } from "./types";
import { ZERO_SHA } from "./types";

const BRANCH_REF = "refs/heads/main";
const MAX_REQUEUES = 5; // a note that keeps changing during indexing goes to retries, then the dead-letter queue
const REQUEUE_DELAY = 30; // seconds: let the burst of changes settle

/** Handles one queue message. Throws on failure, so the queue retries it. */
export async function handle(msg: QueueMessage, deps: Deps): Promise<Outcome> {
  if (msg?.type === "index") return indexPath(msg, deps);
  if (msg?.type === "cf.artifacts.repo.pushed") return fanOut(msg, deps);
  if (msg?.type === "drop") return drop(msg.pathHash, deps);
  return { kind: "ignored", why: `unknown message type: ${String((msg as any)?.type)}` };
}

/**
 * Rebuild only: removes vectors whose path hash no note produces. Re-checked at the head first: a
 * note created after the rebuild's snapshot may produce it now, and then it's re-indexed instead.
 */
async function drop(hash: string, deps: Deps): Promise<Outcome> {
  const head = await deps.notes.head();
  // chunk 0 carries the path in its metadata: one lookup instead of walking every note
  const known = await deps.index.pathOf(`${hash}-0`);
  if (known) {
    if (head && (await deps.notes.shaAt(known, head)) && (await pathHash(known)) === hash) {
      await deps.enqueue([{ type: "index", path: known, reason: "rebuild" }]);
      return { kind: "requeued", path: known };
    }
    await deps.index.deleteByIds(Array.from({ length: MAX_CHUNKS }, (_, i) => `${hash}-${i}`));
    return { kind: "dropped", pathHash: hash };
  }
  // no chunk 0 (only leftovers): fall back to checking every note at the head
  const paths = head ? await deps.notes.changedPaths(ZERO_SHA, head) : [];
  for (const path of paths) {
    if ((await pathHash(path)) === hash) {
      await deps.enqueue([{ type: "index", path, reason: "rebuild" }]);
      return { kind: "requeued", path };
    }
  }
  await deps.index.deleteByIds(Array.from({ length: MAX_CHUNKS }, (_, i) => `${hash}-${i}`));
  return { kind: "dropped", pathHash: hash };
}

/** A push only says which commits changed: turn it into one index message per changed note. */
async function fanOut(ev: PushedEvent, deps: Deps): Promise<Outcome> {
  if (ev.source.repoName !== deps.repoName) return { kind: "ignored", why: `other repository: ${ev.source.repoName}` };
  if (ev.payload.ref !== BRANCH_REF) return { kind: "ignored", why: `other ref: ${ev.payload.ref}` };
  // a first push (before = all zeros) lists every note; changedPaths handles it
  const paths = await deps.notes.changedPaths(ev.payload.before, ev.payload.after);
  if (paths.length) await deps.enqueue(paths.map((path) => ({ type: "index", path, reason: "write" })));
  return { kind: "fanned-out", paths };
}

/**
 * Brings one note's index entries in line with the head of main. Always reads at the head (never
 * at the commit an event named), and records in the manifest only what it actually wrote: if the
 * note changed while indexing, it records nothing and re-enqueues (ADR 010).
 */
async function indexPath(msg: IndexMessage, deps: Deps): Promise<Outcome> {
  const { path } = msg;
  const head = await deps.notes.head();
  const note = head ? await deps.notes.noteAt(path, head) : null;

  if (note) {
    const row = await deps.manifest.get(path);
    if (row?.sha === note.sha && msg.reason !== "rebuild") return { kind: "skipped", path };
    const parts = chunk(note.content);
    const h = await pathHash(path);
    if (parts.length) {
      const values = await deps.embedder.embed(parts);
      await deps.index.upsert(parts.map((text, seq) => ({ id: `${h}-${seq}`, values: values[seq], metadata: { path, seq, text: text.slice(0, 1500) } })));
    }
    if (parts.length < MAX_CHUNKS) await deps.index.deleteByIds(await idsFrom(path, parts.length)); // leftovers from a longer version
    if ((await currentSha(path, head!, note.sha, deps)) !== note.sha) return requeue(msg, deps);
    await deps.manifest.put({ path, sha: note.sha, chunks: parts.length });
    return { kind: "indexed", path, chunks: parts.length };
  }

  await deps.index.deleteByIds(await idsFrom(path, 0)); // the whole id range, whatever the manifest says
  await deps.manifest.remove(path);
  if ((await currentSha(path, head, null, deps)) !== null) return requeue(msg, deps);
  return { kind: "deleted", path };
}

/** The note's sha at the head now. If the head hasn't moved since we read it, that's what we read. */
async function currentSha(path: string, readAt: string | null, readSha: string | null, deps: Deps) {
  const head = await deps.notes.head();
  if (head === readAt) return readSha;
  return head ? deps.notes.shaAt(path, head) : null;
}

async function requeue(msg: IndexMessage, deps: Deps): Promise<Outcome> {
  const requeues = (msg.requeues ?? 0) + 1;
  if (requeues > MAX_REQUEUES) throw new Error(`${msg.path} kept changing while being indexed (${MAX_REQUEUES} requeues)`);
  await deps.enqueue([{ ...msg, requeues }], REQUEUE_DELAY);
  return { kind: "requeued", path: msg.path };
}
