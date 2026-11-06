// The production WorkingCopy: a shallow clone of the Artifacts repository, kept in memory
// (memfs) inside the RepoWriter Durable Object, written with isomorphic-git (ADR 007, ADR 008).
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Volume, createFsFromVolume } from "memfs";
import type { Change, PushOutcome, WorkingCopy } from "./types";

const DIR = "/repo";
const BRANCH = "main";
const AUTHOR = { name: "second-brain-mcp", email: "mcp@second-brain.invalid" };
const TOKEN_TTL = 3600; // seconds
const TOKEN_MARGIN = 300; // renew 5 minutes before expiry (spec v2 §5.1)
const PUSH_TIMEOUT = 15_000; // one slow push must not hold the queue (spec v2 §5.1)
const REJECTED = /non-fast-forward|fetch first|stale|not-fast-forward/i;

type Remote = { url: string; onAuth: () => { username: string; password: string } };

export class ArtifactsWorkingCopy implements WorkingCopy {
  private fs: any = null;
  private cache: object = {}; // isomorphic-git's parsed-pack cache, shared across calls
  private head: string | null = null; // remote tip from the last sync
  private token: { secret: string; url: string; expiresAt: number } | null = null;

  constructor(
    private readonly artifacts: Artifacts,
    private readonly repoName: string,
  ) {}

  ready() {
    return this.fs !== null;
  }

  drop() {
    this.fs = null;
    this.cache = {};
    this.head = null;
  }

  private async remote(): Promise<Remote> {
    if (!this.token || Date.now() > this.token.expiresAt - TOKEN_MARGIN * 1000) {
      using repo = await this.artifacts.get(this.repoName);
      const [info, tok] = await Promise.all([repo.info(), repo.createToken("write", TOKEN_TTL)]);
      this.token = { secret: tok.plaintext.split("?")[0], url: info.remote, expiresAt: Date.parse(tok.expiresAt) };
    }
    const { url, secret } = this.token;
    return { url, onAuth: () => ({ username: "x", password: secret }) };
  }

  async sync() {
    const { url, onAuth } = await this.remote();
    if (!this.fs) {
      const fs = createFsFromVolume(new Volume());
      await git.clone({ fs, http, dir: DIR, url, onAuth, ref: BRANCH, singleBranch: true, depth: 1, cache: this.cache });
      this.fs = fs;
    } else {
      await git.fetch({ fs: this.fs, http, dir: DIR, url, onAuth, ref: BRANCH, singleBranch: true, depth: 1, cache: this.cache });
      const tip = await git.resolveRef({ fs: this.fs, dir: DIR, ref: `refs/remotes/origin/${BRANCH}` });
      await git.writeRef({ fs: this.fs, dir: DIR, ref: `refs/heads/${BRANCH}`, value: tip, force: true });
      await git.checkout({ fs: this.fs, dir: DIR, ref: BRANCH, force: true, cache: this.cache });
    }
    this.head = await git.resolveRef({ fs: this.fs, dir: DIR, ref: BRANCH });
    return this.head;
  }

  async read(path: string) {
    try {
      return (await this.fs.promises.readFile(`${DIR}/${path}`, "utf8")) as string;
    } catch {
      return null;
    }
  }

  async commit(changes: Change[], message: string) {
    for (const c of changes) {
      const file = `${DIR}/${c.path}`;
      if (c.content === null) {
        await this.fs.promises.unlink(file);
        await git.remove({ fs: this.fs, dir: DIR, filepath: c.path });
      } else {
        await this.fs.promises.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
        await this.fs.promises.writeFile(file, c.content);
        await git.add({ fs: this.fs, dir: DIR, filepath: c.path });
      }
    }
    return git.commit({ fs: this.fs, dir: DIR, message, author: AUTHOR });
  }

  async push(): Promise<PushOutcome> {
    const { url, onAuth } = await this.remote();
    try {
      const res = await git.push({ fs: this.fs, http, dir: DIR, url, onAuth, ref: BRANCH, cache: this.cache, signal: AbortSignal.timeout(PUSH_TIMEOUT) });
      if (res.ok) return "ok";
      if (REJECTED.test(`${res.error ?? ""} ${JSON.stringify(res.refs ?? {})}`)) return "rejected";
      throw new Error(`push failed: ${res.error}`);
    } catch (e: any) {
      // the client sees a moved tip: PushRejectedError. The server refuses the ref: GitPushError with per-ref errors.
      if (e?.code === "PushRejectedError") return "rejected";
      if (e?.code === "GitPushError" && REJECTED.test(JSON.stringify(e?.data ?? {}))) return "rejected";
      throw e;
    }
  }

  async contains(commit: string) {
    if (this.head === commit) return true;
    // Walks every parent from the fetched tip (not just the first-parent line: the Mac's sync
    // merges, so a commit can sit on a second parent). Bounded: a lost push is checked right away.
    using repo = await this.artifacts.get(this.repoName);
    const seen = new Set<string>();
    const queue = [this.head ?? (await repo.log({ ref: BRANCH, limit: 1 }))[0]?.hash].filter(Boolean) as string[];
    while (queue.length && seen.size < 200) {
      const hash = queue.shift()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      if (hash === commit) return true;
      const c = await repo.readCommit(hash);
      if (c) queue.push(...c.parents);
    }
    return false;
  }

}
