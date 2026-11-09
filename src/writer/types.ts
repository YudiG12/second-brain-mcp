// The write path (ADR 008): operations go to one writer per repository, which applies them
// to a working copy under a mutex and pushes. The working copy is a port: Artifacts over Git
// in production, an in-memory fake in tests.

export type Operation =
  | { kind: "write"; path: string; content: string; expectedVersion?: string } // overwriting needs the version read_note returned
  | { kind: "create"; path: string; content: string } // fails with code "exists" if the note exists
  | { kind: "edit"; path: string; oldText: string; newText: string }
  | { kind: "delete"; path: string }
  | { kind: "move"; from: string; to: string };

/** A file change in one commit: content, or null to delete. */
export type Change = { path: string; content: string | null };

export type WriteResult =
  | { status: "ok"; commit: string; paths: string[]; changes: Change[] } // changes: exactly what was committed
  | { status: "failed"; reason: string; code?: "exists" | "conflict" } // nothing was written
  | { status: "busy" } // the branch kept moving; nothing was written
  | { status: "unknown"; reason: string }; // the push may or may not have landed

export type PushOutcome = "ok" | "rejected";

export interface WorkingCopy {
  /** Fetches the remote branch and resets the local branch to it. Returns the head commit. */
  sync(): Promise<string>;
  /** Whether a local copy exists (false after drop or before the first sync). */
  ready(): boolean;
  read(path: string): Promise<string | null>;
  /** Another note whose path differs from this one only in case, or null. */
  caseTwin(path: string): Promise<string | null>;
  /** Commits on top of the local head. Returns the new commit id. */
  commit(changes: Change[], message: string): Promise<string>;
  /** "rejected" when the remote moved (non-fast-forward). Throws on any other failure, including a timeout. */
  push(): Promise<PushOutcome>;
  /** After sync(): whether `commit` is the fetched remote head or one of its ancestors. */
  contains(commit: string): Promise<boolean>;
  /** Forgets the local copy; the next write starts with sync(). */
  drop(): void;
}
