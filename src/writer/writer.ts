import type { Change, Operation, WorkingCopy, WriteResult } from "./types";

const MAX_ATTEMPTS = 3; // pushes before giving up as busy (spec v2 §5.1)

class OperationError extends Error {
  constructor(message: string, readonly code?: "exists") {
    super(message);
  }
}

/** Turns an operation into file changes, reading the working copy. Throws OperationError if it can't apply. */
async function changesFor(op: Operation, read: (path: string) => Promise<string | null>, caseTwin: (path: string) => Promise<string | null>): Promise<Change[]> {
  // macOS keeps names case-insensitive: Nota.md and nota.md would be one file on the Mac's clone
  const target = op.kind === "move" ? op.to : op.kind === "write" || op.kind === "create" ? op.path : null;
  if (target) {
    const twin = await caseTwin(target);
    if (twin && !(op.kind === "move" && twin === op.from)) throw new OperationError(`${twin} already exists; note names can't differ only in case`);
  }
  switch (op.kind) {
    case "write":
      return [{ path: op.path, content: op.content }];
    case "create":
      if ((await read(op.path)) !== null) throw new OperationError(`${op.path} already exists`, "exists");
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
  return op.kind === "move" ? `move: ${op.from} -> ${op.to}` : `${op.kind === "create" ? "write" : op.kind}: ${op.path}`;
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
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Everything before the push can only fail without writing anything.
      let changes: Change[];
      let commit: string;
      try {
        if (!this.copy.ready()) await this.copy.sync();
        changes = await changesFor(op, (p) => this.copy.read(p), (p) => this.copy.caseTwin(p));
        commit = await this.copy.commit(changes, message(op));
      } catch (e) {
        if (!(e instanceof OperationError)) this.copy.drop(); // the copy may be half-written; nothing was committed if it's an OperationError
        return { status: "failed", reason: e instanceof Error ? e.message : String(e), ...(e instanceof OperationError && e.code ? { code: e.code } : {}) };
      }
      const ok = { status: "ok" as const, commit, paths: changes.map((c) => c.path).sort(), changes };
      let outcome;
      try {
        outcome = await this.copy.push();
      } catch (e) {
        return this.confirm(ok, e);
      }
      if (outcome === "ok") return ok;
      // rejected: the branch moved. Fetch the new tip and re-run the operation on it.
      try {
        await this.copy.sync();
      } catch (e) {
        this.copy.drop();
        return { status: "failed", reason: `the branch moved and fetching it failed: ${String(e)}` };
      }
    }
    return { status: "busy" };
  }

  /** After a push error: the push may have landed. Check the remote before reporting. */
  private async confirm(ok: Extract<WriteResult, { status: "ok" }>, error: unknown): Promise<WriteResult> {
    try {
      await this.copy.sync();
      if (await this.copy.contains(ok.commit)) return ok;
      return { status: "failed", reason: `push failed: ${String(error)}` };
    } catch {
      this.copy.drop();
      return { status: "unknown", reason: `push failed and the remote could not be checked: ${String(error)}` };
    }
  }
}
