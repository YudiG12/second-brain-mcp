import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ArtifactsNotes, D1Manifest } from "../src/indexer/adapters";
import { ZERO_SHA } from "../src/indexer/types";

const testEnv = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

describe("D1Manifest (real local D1, real migrations)", () => {
  beforeAll(() => applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS));

  it("stores, replaces and removes a row", async () => {
    const m = new D1Manifest(testEnv.DB);
    expect(await m.get("a.md")).toBeNull();
    await m.put({ path: "a.md", sha: "s1", chunks: 2 });
    await m.put({ path: "a.md", sha: "s2", chunks: 3 });
    expect(await m.get("a.md")).toEqual({ path: "a.md", sha: "s2", chunks: 3 });
    await m.remove("a.md");
    expect(await m.get("a.md")).toBeNull();
  });
});

// A minimal stand-in for the Artifacts binding: commits and Git trees as plain objects.
interface Tree {
  [name: string]: string | Tree; // file content, or a subtree
}
function fakeArtifacts(commits: Record<string, Tree>) {
  const objects = new Map<string, { kind: "tree"; entries: { name: string; hash: string; type: "tree" | "blob" }[] } | { kind: "blob"; content: string }>();
  let n = 0;
  const store = (t: Tree): string => {
    const entries = Object.entries(t).map(([name, v]) => {
      if (typeof v === "string") {
        const hash = `blob:${v}`;
        objects.set(hash, { kind: "blob", content: v });
        return { name, hash, type: "blob" as const };
      }
      return { name, hash: store(v), type: "tree" as const };
    });
    const key = JSON.stringify(entries);
    const existing = [...objects.entries()].find(([, o]) => o.kind === "tree" && JSON.stringify(o.entries) === key);
    if (existing) return existing[0];
    const hash = `tree${n++}`;
    objects.set(hash, { kind: "tree", entries });
    return hash;
  };
  const trees = Object.fromEntries(Object.entries(commits).map(([id, t]) => [id, store(t)]));
  const ids = Object.keys(commits);
  const repo = {
    log: async () => [{ hash: ids.at(-1) }],
    readCommit: async (h: string) => (trees[h] ? { hash: h, treeHash: trees[h] } : null),
    readTree: async (h: string) => {
      const o = objects.get(h);
      return o?.kind === "tree" ? o.entries : null;
    },
    readBlob: async (h: string) => {
      const o = objects.get(h);
      return o?.kind === "blob" ? new Blob([o.content]) : null;
    },
    [(Symbol as any).dispose]() {},
  };
  return { get: async () => repo } as unknown as Artifacts;
}

describe("ArtifactsNotes (tree walking over the binding)", () => {
  const notes = new ArtifactsNotes(
    fakeArtifacts({
      c1: { "a.md": "alpha", ideias: { "x.md": "x", "y.md": "y" }, deep: { er: { "z.md": "z" } }, "img.png": "bin" },
      c2: { "a.md": "alpha v2", ideias: { "x.md": "x", "w.md": "w" }, deep: { er: { "z.md": "z" } }, "img.png": "bin2" },
    }),
    "notes",
  );

  it("reads the head and a nested note with its blob sha", async () => {
    expect(await notes.head()).toBe("c2");
    expect(await notes.noteAt("ideias/x.md", "c2")).toEqual({ sha: "blob:x", content: "x" });
    expect(await notes.noteAt("ideias/y.md", "c2")).toBeNull();
    expect(await notes.noteAt("ideias", "c2")).toBeNull(); // a folder is not a note
  });

  it("lists only the Markdown paths that changed, skipping unchanged subtrees", async () => {
    expect(await notes.changedPaths("c1", "c2")).toEqual(["a.md", "ideias/w.md", "ideias/y.md"]);
  });

  it("lists every Markdown path on a first push", async () => {
    expect(await notes.changedPaths(ZERO_SHA, "c1")).toEqual(["a.md", "deep/er/z.md", "ideias/x.md", "ideias/y.md"]);
  });
});
