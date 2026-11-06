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
    expect(queue.sent).toEqual([{ type: "index", path: "a.md", reason: "write", requeues: 1 }]);
  });

  it("re-enqueues with a delay and a counter, and gives up (throws) after 5 requeues", async () => {
    notes.afterRead = () => notes.commit({ "a.md": "alpha v2" });
    await handle({ type: "index", path: "a.md", reason: "write", requeues: 4 }, deps);
    expect(queue.sent).toEqual([{ type: "index", path: "a.md", reason: "write", requeues: 5 }]);
    expect(queue.delays).toEqual([30]);
    notes.afterRead = () => notes.commit({ "a.md": "alpha v3" });
    await expect(handle({ type: "index", path: "a.md", reason: "write", requeues: 5 }, deps)).rejects.toThrow(/kept changing/);
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

describe("drop(pathHash) (rebuild)", () => {
  it("deletes the vectors of a path hash no note produces", async () => {
    await index.upsert([{ id: "ghost-0", values: [1], metadata: { path: "ghost.md", seq: 0, text: "" } }, { id: "ghost-49", values: [1], metadata: { path: "ghost.md", seq: 49, text: "" } }]);
    expect(await handle({ type: "drop", pathHash: "ghost" } as any, deps)).toEqual({ kind: "dropped", pathHash: "ghost" });
    expect(index.vectors.size).toBe(0);
  });
});

describe("drop(pathHash), re-checked at head", () => {
  it("re-indexes instead of dropping when a note at the head now produces that hash", async () => {
    const { pathHash } = await import("../src/lib/notes");
    notes.commit({ "new.md": "created after the rebuild's snapshot" });
    const h = await pathHash("new.md");
    expect(await handle({ type: "drop", pathHash: h }, deps)).toEqual({ kind: "requeued", path: "new.md" });
    expect(queue.sent).toEqual([{ type: "index", path: "new.md", reason: "rebuild" }]);
  });
});

describe("pushed events", () => {
  it("ignores message types it doesn't know, instead of failing into the dead-letter queue", async () => {
    expect((await handle({ type: "cf.artifacts.repo.cloned" } as any, deps)).kind).toBe("ignored");
    expect((await handle({ nonsense: true } as any, deps)).kind).toBe("ignored");
  });

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
