import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/indexer/indexer";
import { ZERO_SHA, type Deps, type PushedEvent } from "../src/indexer/types";
import { FakeEmbedder, FakeIndex, FakeManifest, FakeNotes, FakeQueue } from "./fakes/indexer";

let notes: FakeNotes, index: FakeIndex, embedder: FakeEmbedder, manifest: FakeManifest, queue: FakeQueue, deps: Deps;

beforeEach(() => {
  notes = new FakeNotes({ "a.md": "alpha", "b.md": "bravo", "img.png": "binary" });
  index = new FakeIndex();
  embedder = new FakeEmbedder();
  manifest = new FakeManifest();
  queue = new FakeQueue();
  deps = { notes, index, embedder, manifest, enqueue: queue.enqueue, repoName: "notes" };
});

const pushed = (before: string, after: string, ref = "refs/heads/main", repoName = "notes"): PushedEvent => ({
  type: "cf.artifacts.repo.pushed",
  source: { type: "artifacts.repo", namespace: "second-brain", repoName },
  payload: { ref, before, after },
});

describe("index(path) (spec v2 §5.2)", () => {
  it("indexes a note and records exactly that version in the manifest", async () => {
    expect(await handle({ type: "index", path: "a.md", reason: "write" }, deps)).toEqual({ kind: "indexed", path: "a.md", chunks: 1 });
    expect(index.pathsIndexed()).toEqual(["a.md"]);
    expect(await manifest.get("a.md")).toEqual({ path: "a.md", sha: "sha(alpha)", chunks: 1 });
  });

  it("skips a note already indexed at this version (the duplicate every MCP write produces)", async () => {
    await handle({ type: "index", path: "a.md", reason: "write" }, deps);
    expect(await handle({ type: "index", path: "a.md", reason: "write" }, deps)).toEqual({ kind: "skipped", path: "a.md" });
    expect(embedder.calls).toBe(1);
  });

  it("re-indexes on a rebuild even if the manifest says it's current", async () => {
    await handle({ type: "index", path: "a.md", reason: "write" }, deps);
    index.vectors.clear(); // vectors lost behind a correct manifest row
    expect((await handle({ type: "index", path: "a.md", reason: "rebuild" }, deps)).kind).toBe("indexed");
    expect(index.pathsIndexed()).toEqual(["a.md"]);
  });

  it("deletes the vectors and the manifest row of a note that no longer exists", async () => {
    await handle({ type: "index", path: "a.md", reason: "write" }, deps);
    notes.commit({ "a.md": null });
    expect(await handle({ type: "index", path: "a.md", reason: "write" }, deps)).toEqual({ kind: "deleted", path: "a.md" });
    expect(index.pathsIndexed()).toEqual([]);
    expect(await manifest.get("a.md")).toBeNull();
  });

  it("deletes leftover chunks when a note shrinks (#11)", async () => {
    const long = Array.from({ length: 5 }, (_, i) => `${"x".repeat(1100)}${i}`).join("\n\n");
    notes.commit({ "a.md": long });
    await handle({ type: "index", path: "a.md", reason: "write" }, deps);
    expect(index.vectors.size).toBe(5);
    notes.commit({ "a.md": "short" });
    await handle({ type: "index", path: "a.md", reason: "write" }, deps);
    expect(index.vectors.size).toBe(1);
    expect((await manifest.get("a.md"))?.chunks).toBe(1);
  });

  it("records nothing and re-enqueues when the note changes while it's being indexed", async () => {
    notes.afterRead = () => notes.commit({ "a.md": "alpha v2" });
    expect(await handle({ type: "index", path: "a.md", reason: "write" }, deps)).toEqual({ kind: "requeued", path: "a.md" });
    expect(await manifest.get("a.md")).toBeNull();
    expect(queue.sent).toEqual([{ type: "index", path: "a.md", reason: "write" }]);
  });

  it("re-enqueues when a deleted note reappears while deleting", async () => {
    notes.commit({ "a.md": null });
    notes.afterRead = () => notes.commit({ "a.md": "back" });
    expect(await handle({ type: "index", path: "a.md", reason: "write" }, deps)).toEqual({ kind: "requeued", path: "a.md" });
  });

  it("throws when embedding fails, so the queue retries, and records nothing", async () => {
    embedder.fail = true;
    await expect(handle({ type: "index", path: "a.md", reason: "write" }, deps)).rejects.toThrow(/Workers AI/);
    expect(await manifest.get("a.md")).toBeNull();
  });
});

describe("pushed events", () => {
  it("fans out the changed Markdown paths as index messages", async () => {
    const before = await notes.head();
    const after = notes.commit({ "a.md": "alpha v2", "c.md": "charlie", "b.md": null, "img.png": "other" });
    expect(await handle(pushed(before!, after), deps)).toEqual({ kind: "fanned-out", paths: ["a.md", "b.md", "c.md"] });
    expect(queue.sent.map((m) => m.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("treats a first push (before = zeros) as every note", async () => {
    expect(await handle(pushed(ZERO_SHA, (await notes.head())!), deps)).toEqual({ kind: "fanned-out", paths: ["a.md", "b.md"] });
  });

  it("ignores pushes to other branches and other repositories", async () => {
    const head = (await notes.head())!;
    expect((await handle(pushed(head, head, "refs/heads/draft"), deps)).kind).toBe("ignored");
    expect((await handle(pushed(head, head, "refs/heads/main", "notes-staging"), deps)).kind).toBe("ignored");
    expect(queue.sent).toEqual([]);
  });
});
