import type { Change, Operation, WorkingCopy, WriteResult } from "./types";

const MAX_ATTEMPTS = 3; // pushes before giving up as busy (spec v2 §5.1)

class OperationError extends Error {}

/** Turns an operation into file changes, reading the working copy. Throws OperationError if it can't apply. */
async function changesFor(op: Operation, read: (path: string) => Promise<string | null>): Promise<Change[]> {
  switch (op.kind) {
    case "write":
      return [{ path: op.path, content: op.content }];
    case "edit": {
      const current = await read(op.path);
      if (current === null) throw new OperationError(`${op.path} doesn't exist`);
      const count = current.split(op.oldText).length - 1;
      if (count !== 1) throw new OperationError(`old_text appears ${count} times in ${op.path}; it must appear exactly once`);
      return [{ path: op.path, content: current.replace(op.oldText, () => op.newText) }];
    }
    case "delete":
      if ((await read(op.path)) === null) throw new OperationError(`${op.path} doesn't exist`);
      return [{ path: op.path, content: null }];
    case "move": {
      const body = await read(op.from);
      if (body === null) throw new OperationError(`${op.from} doesn't exist`);
      if ((await read(op.to)) !== null) throw new OperationError(`${op.to} already exists`);
      return [
        { path: op.from, content: null },
        { path: op.to, content: body },
      ];
    }
  }
}

function message(op: Operation) {
  return op.kind === "move" ? `move: ${op.from} -> ${op.to}` : `${op.kind}: ${op.path}`;
}

/**
 * The only Git writer for one repository (ADR 008). Writes run one at a time (an in-memory mutex:
 * a promise chain), each applied to the working copy inside the lock, committed and pushed.
 */
export class Writer {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly copy: WorkingCopy) {}

  run(op: Operation): Promise<WriteResult> {
    const result = this.queue.then(() => this.apply(op));
    this.queue = result.catch(() => {});
    return result;
  }

  private async apply(op: Operation): Promise<WriteResult> {
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!this.copy.ready()) await this.copy.sync();
        const changes = await changesFor(op, (p) => this.copy.read(p));
        const commit = await this.copy.commit(changes, message(op));
        let outcome;
        try {
          outcome = await this.copy.push();
        } catch (e) {
          return await this.confirm(commit, e);
        }
        if (outcome === "ok") return { status: "ok", commit, paths: changes.map((c) => c.path).sort() };
        await this.copy.sync(); // rejected: the branch moved; re-run the operation on the new tip
      }
      return { status: "busy" };
    } catch (e) {
      if (e instanceof OperationError) {
        if (this.copy.ready()) await this.copy.sync().catch(() => this.copy.drop()); // discard nothing-to-push state
        return { status: "failed", reason: e.message };
      }
      this.copy.drop();
      return { status: "unknown", reason: String(e) };
    }
  }

  /** After a push error: the push may have landed. Check the remote before reporting. */
  private async confirm(commit: string, error: unknown): Promise<WriteResult> {
    try {
      await this.copy.sync();
      if (await this.copy.contains(commit)) return { status: "ok", commit, paths: [] };
      return { status: "failed", reason: `push failed: ${String(error)}` };
    } catch {
      this.copy.drop();
      return { status: "unknown", reason: `push failed and the remote could not be checked: ${String(error)}` };
    }
  }
}
