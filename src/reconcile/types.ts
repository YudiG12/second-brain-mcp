// Reconciliation (ADR 009, spec v2 §5.3): a Workflow compares the notes with the index manifest
// and enqueues fixes. It never writes the index itself: the Queue consumer stays the only writer.
import type { DropMessage, IndexMessage } from "../indexer/types";
export type { DropMessage };

export type Mode = "daily" | "rebuild";
export type NoteSha = { path: string; sha: string };

/** The few Workflow features we use, so the orchestration can be tested without the runtime. */
export interface Step {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface ReconcileSource {
  head(): Promise<string | null>;
  /** Every Markdown note at a commit with its blob sha. */
  allNotes(commit: string): Promise<NoteSha[]>;
  changedPaths(before: string, after: string): Promise<string[]>;
}

export interface ReconcileIndex {
  /** The manifest rows: what the index says it holds. */
  manifest(): Promise<NoteSha[]>;
  /** Paths with rows in the keyword index (chunks_fts). */
  keywordPaths(): Promise<string[]>;
  /** Path hashes that have vectors (rebuild only). null when listing isn't available. */
  vectorPathHashes(): Promise<string[] | null>;
}

export type ReconcileDeps = {
  source: ReconcileSource;
  index: ReconcileIndex;
  enqueue: (messages: (IndexMessage | DropMessage)[]) => Promise<void>;
  pathHash: (path: string) => Promise<string>;
  alert: (body: string) => Promise<void>;
  /** Marks open dead-letter alerts resolved: the run just fixed whatever they missed. */
  resolveDlqAlerts: () => Promise<void>;
};


export type Report = {
  mode: Mode;
  commit: string | null;
  notes: number;
  enqueued: number;
  fixed: { new: number; changed: number; orphans: number; vectorOrphans: number | null };
  inFlight: number; // changed after the snapshot: not counted as missed
  alerted: boolean;
};

export const BATCH = 20; // items per enqueue step
export const ALERT_ABOVE = 5; // a daily run fixing more than this means events are being lost
