import type { Embedder, IndexMessage, Manifest, ManifestRow, NotesSource, Vector, VectorIndex } from "../../src/indexer/types";

/** A linear history of note snapshots. Commit ids are "c0", "c1"...; blob shas are derived from content. */
export class FakeNotes implements NotesSource {
  commits: Record<string, string>[] = [];
  /** Runs right after the next noteAt() call: lets a test change the notes mid-indexing. */
  afterRead: (() => void) | null = null;

  constructor(files: Record<string, string> = {}) {
    this.commits.push({ ...files });
  }

  commit(changes: Record<string, string | null>) {
    const next = { ...this.commits.at(-1)! };
    for (const [p, c] of Object.entries(changes)) c === null ? delete next[p] : (next[p] = c);
    this.commits.push(next);
    return this.id(this.commits.length - 1);
  }

  id(n: number) {
    return `c${n}`;
  }

  async head() {
    return this.id(this.commits.length - 1);
  }

  async shaAt(path: string, commit: string) {
    return (await this.noteAt(path, commit))?.sha ?? null;
  }

  async noteAt(path: string, commit: string) {
    const files = this.commits[Number(commit.slice(1))];
    const content = files?.[path];
    const hook = this.afterRead;
    this.afterRead = null;
    hook?.();
    return content === undefined ? null : { sha: `sha(${content})`, content };
  }

  async changedPaths(before: string, after: string) {
    const a = before.startsWith("0000") ? {} : this.commits[Number(before.slice(1))];
    const b = this.commits[Number(after.slice(1))];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => p.endsWith(".md") && a[p] !== b[p]).sort();
  }
}

export class FakeIndex implements VectorIndex {
  vectors = new Map<string, Vector>();
  async upsert(vs: Vector[]) {
    for (const v of vs) this.vectors.set(v.id, v);
  }
  async deleteByIds(ids: string[]) {
    for (const id of ids) this.vectors.delete(id);
  }
  async pathOf(id: string) {
    return this.vectors.get(id)?.metadata.path ?? null;
  }
  pathsIndexed() {
    return [...new Set([...this.vectors.values()].map((v) => v.metadata.path))].sort();
  }
}

export class FakeKeywords {
  rows = new Map<string, string[]>();
  async replace(path: string, chunks: string[]) {
    this.rows.set(path, chunks);
  }
  async remove(path: string) {
    this.rows.delete(path);
  }
}

export class FakeEmbedder implements Embedder {
  calls = 0;
  fail = false;
  async embed(texts: string[]) {
    this.calls++;
    if (this.fail) throw new Error("Workers AI unavailable");
    return texts.map((t) => [t.length, 1, 0]);
  }
}

export class FakeManifest implements Manifest {
  rows = new Map<string, ManifestRow>();
  async get(path: string) {
    return this.rows.get(path) ?? null;
  }
  async put(row: ManifestRow) {
    this.rows.set(row.path, row);
  }
  async remove(path: string) {
    this.rows.delete(path);
  }
}

export class FakeQueue {
  sent: IndexMessage[] = [];
  delays: number[] = [];
  enqueue = async (ms: IndexMessage[], delaySeconds?: number) => {
    this.sent.push(...ms);
    if (delaySeconds !== undefined) this.delays.push(delaySeconds);
  };
}
