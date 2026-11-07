import type { Change, PushOutcome, WorkingCopy } from "../../src/writer/types";

type Commit = { id: string; parent: string | null; files: Map<string, string>; message: string };

/** A remote Git branch in memory. A push succeeds only if it builds on the current head (fast-forward). */
export class FakeRemote {
  private n = 0;
  commits = new Map<string, Commit>();
  head: string;

  constructor(files: Record<string, string> = {}) {
    this.head = this.add(null, new Map(Object.entries(files)), "seed");
  }

  add(parent: string | null, files: Map<string, string>, message: string) {
    const id = `c${this.n++}`;
    this.commits.set(id, { id, parent, files, message });
    return id;
  }

  /** Simulates someone else (the Mac) pushing a change. */
  pushFromElsewhere(changes: Record<string, string | null>, message = "mac") {
    const files = new Map(this.commits.get(this.head)!.files);
    for (const [p, c] of Object.entries(changes)) c === null ? files.delete(p) : files.set(p, c);
    this.head = this.add(this.head, files, message);
  }

  files() {
    return Object.fromEntries(this.commits.get(this.head)!.files);
  }

  /** Commits after the seed, oldest first. */
  history() {
    const out: Commit[] = [];
    for (let c = this.commits.get(this.head); c && c.parent; c = c.parent ? this.commits.get(c.parent) : undefined) out.unshift(c);
    return out;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 1));

/** A working copy of FakeRemote. Every call awaits, so concurrent callers interleave as they would over the network. */
export class FakeWorkingCopy implements WorkingCopy {
  private base: string | null = null; // remote commit the local branch started from
  private local: { id: string; files: Map<string, string> } | null = null;
  pushes = 0;
  syncs = 0;
  /** Run before the next push reaches the remote: lets a test move the remote in between. */
  beforePush: (() => void) | null = null;
  /** Runs after a lost push response, before the writer checks the remote (e.g. the Mac pushes on top). */
  beforeConfirm: (() => void) | null = null;
  /** "error-landed": the push lands but the response is lost. "error": it doesn't land. */
  failNextPush: "error-landed" | "error" | null = null;
  failSync = false;
  failCommit = false;

  constructor(readonly remote: FakeRemote) {}

  ready() {
    return this.local !== null;
  }

  async sync() {
    await tick();
    this.syncs++;
    if (this.failSync) throw new Error("network down");
    const head = this.remote.commits.get(this.remote.head)!;
    this.base = head.id;
    this.local = { id: head.id, files: new Map(head.files) };
    return head.id;
  }

  async read(path: string) {
    await tick();
    if (!this.local) throw new Error("no working copy");
    return this.local.files.get(path) ?? null;
  }

  async caseTwin(path: string) {
    await tick();
    for (const p of this.local?.files.keys() ?? []) if (p !== path && p.toLowerCase() === path.toLowerCase()) return p;
    return null;
  }

  async commit(changes: Change[], message: string) {
    await tick();
    if (this.failCommit) throw new Error("disk full");
    if (!this.local) throw new Error("no working copy");
    const files = new Map(this.local.files);
    for (const c of changes) c.content === null ? files.delete(c.path) : files.set(c.path, c.content);
    const id = this.remote.add(this.local.id, files, message); // stored, but not on the branch until pushed
    this.local = { id, files };
    return id;
  }

  async push(): Promise<PushOutcome> {
    await tick();
    this.pushes++;
    const hook = this.beforePush; // cleared before running, so a hook can re-arm itself
    this.beforePush = null;
    hook?.();
    if (!this.local) throw new Error("no working copy");
    const failure = this.failNextPush;
    this.failNextPush = null;
    if (failure === "error") throw new Error("push failed");
    if (this.remote.commits.get(this.local.id)!.parent !== this.remote.head) return "rejected";
    this.remote.head = this.local.id;
    this.base = this.local.id;
    if (failure === "error-landed") {
      this.beforeConfirm?.();
      throw new Error("unreadable response");
    }
    return "ok";
  }

  async contains(commit: string) {
    await tick();
    for (let c = this.remote.commits.get(this.remote.head); c; c = c.parent ? this.remote.commits.get(c.parent) : undefined) if (c.id === commit) return true;
    return false;
  }

  drop() {
    this.local = null;
    this.base = null;
  }
}
