// The indexer (ADR 009, ADR 010, spec v2 §5.2): the Queue consumer is the only writer of the
// semantic index (Vectorize) and of the manifest (D1). Ports keep the logic testable.

/** Messages on the index-jobs queue (spec v2 §4.5). */
export type PushedEvent = {
  type: "cf.artifacts.repo.pushed";
  source: { type: "artifacts.repo"; namespace: string; repoName: string };
  payload: { ref: string; before: string; after: string };
};
export type IndexMessage = {
  type: "index";
  path: string;
  reason: "write" | "reconcile" | "rebuild";
  /** How many times the post-write check re-enqueued this note; capped, so it can't spin forever. */
  requeues?: number;
};
/** Rebuild only: a path hash with vectors that no note produces. */
export type DropMessage = { type: "drop"; pathHash: string };
export type QueueMessage = PushedEvent | IndexMessage | DropMessage;

export const ZERO_SHA = "0".repeat(40);

export interface NotesSource {
  /** Head commit of main, or null for an empty repository. */
  head(): Promise<string | null>;
  /** The note at a commit: its blob sha and text, or null if the path doesn't exist there. */
  noteAt(path: string, commit: string): Promise<{ sha: string; content: string } | null>;
  /** Just the blob sha of a note at a commit (no content), or null. */
  shaAt(path: string, commit: string): Promise<string | null>;
  /** Markdown paths that differ between two commits (every .md path when `before` is all zeros). */
  changedPaths(before: string, after: string): Promise<string[]>;
}

export type Vector = { id: string; values: number[]; metadata: { path: string; seq: number; text: string } };

export interface VectorIndex {
  upsert(vectors: Vector[]): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export type ManifestRow = { path: string; sha: string; chunks: number };

export interface Manifest {
  get(path: string): Promise<ManifestRow | null>;
  put(row: ManifestRow): Promise<void>;
  remove(path: string): Promise<void>;
}

export type Enqueue = (messages: IndexMessage[], delaySeconds?: number) => Promise<void>;

export type Deps = { notes: NotesSource; index: VectorIndex; embedder: Embedder; manifest: Manifest; enqueue: Enqueue; repoName: string };

/** What happened to one message (for logs and tests). */
export type Outcome =
  | { kind: "ignored"; why: string }
  | { kind: "fanned-out"; paths: string[] }
  | { kind: "skipped"; path: string } // already indexed at this version
  | { kind: "indexed"; path: string; chunks: number }
  | { kind: "deleted"; path: string }
  | { kind: "dropped"; pathHash: string }
  | { kind: "requeued"; path: string }; // the note changed while indexing; nothing recorded
