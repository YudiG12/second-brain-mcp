import { beforeEach, describe, expect, it } from "vitest";
import { runReconcile } from "../src/reconcile/reconcile";
import type { NoteSha, ReconcileDeps, Step } from "../src/reconcile/types";

let source: NoteSha[], manifest: NoteSha[], vectorHashes: string[] | null, sent: any[], alerts: string[], stepNames: string[], changedAfter: string[];
let deps: ReconcileDeps;
const step: Step = { do: async (name, fn) => (stepNames.push(name), fn()) };

beforeEach(() => {
  source = [
    { path: "a.md", sha: "a1" },
    { path: "b.md", sha: "b2" }, // changed
    { path: "c.md", sha: "c1" }, // new
  ];
  manifest = [
    { path: "a.md", sha: "a1" },
    { path: "b.md", sha: "b1" },
    { path: "gone.md", sha: "g1" }, // orphan
  ];
  vectorHashes = null;
  sent = [];
  alerts = [];
  stepNames = [];
  changedAfter = [];
  deps = {
    source: {
      head: async () => (stepNames.some((n) => n.startsWith("report")) ? "c2" : "c1"),
      allNotes: async () => source,
      changedPaths: async () => changedAfter,
    },
    index: { manifest: async () => manifest, vectorPathHashes: async () => vectorHashes },
    enqueue: async (ms) => void sent.push(...ms),
    pathHash: async (p) => `h(${p})`,
    alert: async (b) => void alerts.push(b),
  };
});

describe("daily reconciliation (#7)", () => {
  it("enqueues new, changed and orphan notes, and nothing that is already right", async () => {
    const r = await runReconcile("daily", step, deps);
    expect(sent).toEqual([
      { type: "index", path: "c.md", reason: "reconcile" },
      { type: "index", path: "b.md", reason: "reconcile" },
      { type: "index", path: "gone.md", reason: "reconcile" },
    ]);
    expect(r.fixed).toEqual({ new: 1, changed: 1, orphans: 1, vectorOrphans: null });
  });

  it("runs as resumable steps, one per batch of 20", async () => {
    source = Array.from({ length: 45 }, (_, i) => ({ path: `n${i}.md`, sha: "x" }));
    manifest = [];
    await runReconcile("daily", step, deps);
    expect(stepNames).toEqual(["snapshot source", "snapshot index", "enqueue 1/3", "enqueue 2/3", "enqueue 3/3", "report"]);
    expect(sent).toHaveLength(45);
  });

  it("doesn't count notes changed after the snapshot as missed, and alerts above 5 real fixes", async () => {
    source = Array.from({ length: 8 }, (_, i) => ({ path: `n${i}.md`, sha: "x" }));
    manifest = [];
    changedAfter = ["n0.md", "n1.md"];
    const r = await runReconcile("daily", step, deps);
    expect(r.inFlight).toBe(2);
    expect(r.alerted).toBe(true); // 6 real fixes
    expect(alerts).toHaveLength(1);
  });

  it("doesn't alert for a few fixes", async () => {
    const r = await runReconcile("daily", step, deps);
    expect(r.alerted).toBe(false);
    expect(alerts).toEqual([]);
  });

  it("does nothing on an empty repository", async () => {
    deps.source.head = async () => null;
    manifest = [];
    const r = await runReconcile("daily", step, deps);
    expect(r).toMatchObject({ commit: null, notes: 0, enqueued: 0 });
  });
});

describe("rebuild (#8)", () => {
  it("re-indexes every note (bypassing the skip) and drops vectors no note produces", async () => {
    vectorHashes = ["h(a.md)", "h(b.md)", "h(ghost.md)"];
    const r = await runReconcile("rebuild", step, deps);
    expect(sent).toEqual([
      { type: "index", path: "a.md", reason: "rebuild" },
      { type: "index", path: "b.md", reason: "rebuild" },
      { type: "index", path: "c.md", reason: "rebuild" },
      { type: "index", path: "gone.md", reason: "rebuild" },
      { type: "drop", pathHash: "h(ghost.md)" },
    ]);
    expect(r.fixed.vectorOrphans).toBe(1);
    expect(r.alerted).toBe(false); // a rebuild re-indexes everything on purpose
  });

  it("still rebuilds when vectors can't be listed, and reports that", async () => {
    vectorHashes = null;
    const r = await runReconcile("rebuild", step, deps);
    expect(sent.filter((m) => m.type === "drop")).toEqual([]);
    expect(r.fixed.vectorOrphans).toBeNull();
  });
});
