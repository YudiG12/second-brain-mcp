import { chunk, idsFrom, pathHash } from "../lib/notes";
import type { Deps, IndexMessage, Outcome, PushedEvent, QueueMessage } from "./types";

const BRANCH_REF = "refs/heads/main";

/** Handles one queue message. Throws on failure, so the queue retries it. */
export async function handle(msg: QueueMessage, deps: Deps): Promise<Outcome> {
  return msg.type === "index" ? indexPath(msg, deps) : fanOut(msg, deps);
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
    await deps.index.deleteByIds(await idsFrom(path, parts.length)); // leftovers from a longer version
    if ((await currentSha(path, deps)) !== note.sha) return requeue(msg, deps);
    await deps.manifest.put({ path, sha: note.sha, chunks: parts.length });
    return { kind: "indexed", path, chunks: parts.length };
  }

  await deps.index.deleteByIds(await idsFrom(path, 0)); // the whole id range, whatever the manifest says
  await deps.manifest.remove(path);
  if ((await currentSha(path, deps)) !== null) return requeue(msg, deps);
  return { kind: "deleted", path };
}

async function currentSha(path: string, deps: Deps) {
  const head = await deps.notes.head();
  return head ? ((await deps.notes.noteAt(path, head))?.sha ?? null) : null;
}

async function requeue(msg: IndexMessage, deps: Deps): Promise<Outcome> {
  await deps.enqueue([msg]);
  return { kind: "requeued", path: msg.path };
}
