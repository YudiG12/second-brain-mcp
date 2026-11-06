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

type Remote = { url: string; onAuth: () => { username: string; password: string } };

export class ArtifactsWorkingCopy implements WorkingCopy {
  private fs: any = null;
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
      await git.clone({ fs, http, dir: DIR, url, onAuth, ref: BRANCH, singleBranch: true, depth: 1 });
      this.fs = fs;
    } else {
      await git.fetch({ fs: this.fs, http, dir: DIR, url, onAuth, ref: BRANCH, singleBranch: true, depth: 1 });
      const tip = await git.resolveRef({ fs: this.fs, dir: DIR, ref: `refs/remotes/origin/${BRANCH}` });
      await git.writeRef({ fs: this.fs, dir: DIR, ref: `refs/heads/${BRANCH}`, value: tip, force: true });
      await git.checkout({ fs: this.fs, dir: DIR, ref: BRANCH, force: true });
    }
    return git.resolveRef({ fs: this.fs, dir: DIR, ref: BRANCH });
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
      const res = await git.push({ fs: this.fs, http, dir: DIR, url, onAuth, ref: BRANCH });
      if (res.ok) return "ok";
      const reason = `${res.error ?? ""} ${JSON.stringify(res.refs ?? {})}`;
      if (/fast-forward|fetch first|stale|non-ff/i.test(reason)) return "rejected";
      throw new Error(`push failed: ${reason}`);
    } catch (e: any) {
      if (e?.code === "PushRejectedError") return "rejected";
      throw e;
    }
  }

  async contains(commit: string) {
    using repo = await this.artifacts.get(this.repoName);
    const log = await repo.log({ ref: BRANCH, limit: 100 });
    return log.some((c) => c.hash === commit);
  }
}
