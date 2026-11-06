// Production adapters for the indexer's ports.
import type { Embedder, Manifest, ManifestRow, NotesSource, Vector, VectorIndex } from "./types";
import { ZERO_SHA } from "./types";

const EMBED_MODEL = "@cf/baai/bge-m3"; // multilingual, 1024 dimensions

/** Reads the notes through the Artifacts binding: no clone, no token (ADR 007). */
export class ArtifactsNotes implements NotesSource {
  constructor(
    private readonly artifacts: Artifacts,
    private readonly repoName: string,
  ) {}

  async head() {
    using repo = await this.artifacts.get(this.repoName);
    const [c] = await repo.log({ ref: "main", limit: 1 });
    return c?.hash ?? null;
  }

  /** Walks the tree to the note's entry: its blob sha, without reading the content. */
  private async entry(repo: ArtifactsRepo, path: string, commit: string) {
    const c = await repo.readCommit(commit);
    if (!c) return null;
    let tree = c.treeHash;
    const parts = path.split("/");
    for (const [i, name] of parts.entries()) {
      const e = (await repo.readTree(tree))?.find((x) => x.name === name);
      if (!e) return null;
      if (i === parts.length - 1) return e.type === "blob" ? e.hash : null;
      if (e.type !== "tree") return null;
      tree = e.hash;
    }
    return null;
  }

  async shaAt(path: string, commit: string) {
    using repo = await this.artifacts.get(this.repoName);
    return this.entry(repo, path, commit);
  }

  async noteAt(path: string, commit: string) {
    using repo = await this.artifacts.get(this.repoName);
    const sha = await this.entry(repo, path, commit);
    if (!sha) return null;
    const blob = await repo.readBlob(sha);
    return blob ? { sha, content: await blob.text() } : null;
  }

  async changedPaths(before: string, after: string) {
    using repo = await this.artifacts.get(this.repoName);
    const treeOf = async (commit: string) => (commit === ZERO_SHA ? null : ((await repo.readCommit(commit))?.treeHash ?? null));
    const out: string[] = [];
    // walks both trees, descending only into subtrees whose hashes differ
    const diff = async (a: string | null, b: string | null, base: string): Promise<void> => {
      if (a === b) return;
      const [ea, eb] = await Promise.all([a ? repo.readTree(a) : [], b ? repo.readTree(b) : []]);
      const left = new Map((ea ?? []).map((e) => [e.name, e]));
      const right = new Map((eb ?? []).map((e) => [e.name, e]));
      await Promise.all(
        [...new Set([...left.keys(), ...right.keys()])].map(async (name) => {
          const l = left.get(name), r = right.get(name);
          if (l?.hash === r?.hash) return;
          const path = base + name;
          const lt = l?.type === "tree" ? l.hash : null, rt = r?.type === "tree" ? r.hash : null;
          if (lt || rt) await diff(lt, rt, path + "/");
          if ((l?.type === "blob" || r?.type === "blob") && path.endsWith(".md")) out.push(path);
        }),
      );
    };
    await diff(await treeOf(before), await treeOf(after), "");
    return out.sort();
  }
}

export class D1Manifest implements Manifest {
  constructor(private readonly db: D1Database) {}

  async get(path: string) {
    return this.db.prepare("SELECT path, sha, chunks FROM manifest WHERE path = ?").bind(path).first<ManifestRow>();
  }

  async put(row: ManifestRow) {
    await this.db
      .prepare("INSERT INTO manifest (path, sha, chunks, indexed_at) VALUES (?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET sha = excluded.sha, chunks = excluded.chunks, indexed_at = excluded.indexed_at")
      .bind(row.path, row.sha, row.chunks, new Date().toISOString())
      .run();
  }

  async remove(path: string) {
    await this.db.prepare("DELETE FROM manifest WHERE path = ?").bind(path).run();
  }
}

export class VectorizeAdapter implements VectorIndex {
  constructor(private readonly vectors: globalThis.VectorizeIndex) {}
  async upsert(vs: Vector[]) {
    await this.vectors.upsert(vs);
  }
  async deleteByIds(ids: string[]) {
    await this.vectors.deleteByIds(ids);
  }
}

export class WorkersAiEmbedder implements Embedder {
  constructor(private readonly ai: Ai) {}
  async embed(texts: string[]) {
    const res = (await this.ai.run(EMBED_MODEL as any, { text: texts })) as unknown as { data: number[][] };
    return res.data;
  }
}
