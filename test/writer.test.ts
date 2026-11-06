import { beforeEach, describe, expect, it } from "vitest";
import { Writer } from "../src/writer/writer";
import { FakeRemote, FakeWorkingCopy } from "./fakes/git";

let remote: FakeRemote;
let copy: FakeWorkingCopy;
let writer: Writer;

beforeEach(() => {
  remote = new FakeRemote({ "a.md": "alpha\n\nbeta\n", "b.md": "bravo\n" });
  copy = new FakeWorkingCopy(remote);
  writer = new Writer(copy);
});

describe("Writer: concurrency (#5, ADR 008)", () => {
  it("keeps both of two concurrent edits to the same note", async () => {
    const [r1, r2] = await Promise.all([
      writer.run({ kind: "edit", path: "a.md", oldText: "alpha", newText: "ALPHA" }),
      writer.run({ kind: "edit", path: "a.md", oldText: "beta", newText: "BETA" }),
    ]);
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    expect(remote.files()["a.md"]).toBe("ALPHA\n\nBETA\n");
  });

  it("lands concurrent writes to different notes, one commit each", async () => {
    const results = await Promise.all([
      writer.run({ kind: "write", path: "x.md", content: "x" }),
      writer.run({ kind: "write", path: "y.md", content: "y" }),
      writer.run({ kind: "delete", path: "b.md" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(remote.files()).toEqual({ "a.md": "alpha\n\nbeta\n", "x.md": "x", "y.md": "y" });
    expect(remote.history()).toHaveLength(3);
  });

  it("re-runs the operation on the new tip when the Mac pushed in between", async () => {
    copy.beforePush = () => remote.pushFromElsewhere({ "b.md": "bravo from the mac\n" });
    const r = await writer.run({ kind: "edit", path: "a.md", oldText: "alpha", newText: "ALPHA" });
    expect(r.status).toBe("ok");
    expect(remote.files()).toMatchObject({ "a.md": "ALPHA\n\nbeta\n", "b.md": "bravo from the mac\n" });
  });

  it("re-checks old_text on the new tip instead of replaying a stale edit", async () => {
    copy.beforePush = () => remote.pushFromElsewhere({ "a.md": "rewritten on the mac\n" });
    const r = await writer.run({ kind: "edit", path: "a.md", oldText: "alpha", newText: "ALPHA" });
    expect(r).toMatchObject({ status: "failed" });
    expect(remote.files()["a.md"]).toBe("rewritten on the mac\n");
  });

  it("gives up as busy after 3 rejected pushes, writing nothing", async () => {
    let n = 0;
    const moving = () => {
      remote.pushFromElsewhere({ [`mac${n++}.md`]: "m" });
      copy.beforePush = n < 10 ? moving : null;
    };
    copy.beforePush = moving;
    const r = await writer.run({ kind: "write", path: "x.md", content: "x" });
    expect(r.status).toBe("busy");
    expect(remote.files()["x.md"]).toBeUndefined();
    expect(copy.pushes).toBe(3);
  });
});

describe("Writer: operations", () => {
  it("returns the written content, so callers index what was committed", async () => {
    const r = await writer.run({ kind: "edit", path: "a.md", oldText: "alpha", newText: "ALPHA" });
    expect(r).toMatchObject({ status: "ok", changes: [{ path: "a.md", content: "ALPHA\n\nbeta\n" }] });
  });

  it("moves a note in a single commit (#10)", async () => {
    const r = await writer.run({ kind: "move", from: "b.md", to: "c.md" });
    expect(r).toMatchObject({ status: "ok", paths: ["b.md", "c.md"], changes: [{ path: "b.md", content: null }, { path: "c.md", content: "bravo\n" }] });
    expect(remote.files()).toEqual({ "a.md": "alpha\n\nbeta\n", "c.md": "bravo\n" });
    expect(remote.history()).toHaveLength(1);
  });

  it("creates a note only if it doesn't exist yet (#31)", async () => {
    expect(await writer.run({ kind: "create", path: "new.md", content: "n" })).toMatchObject({ status: "ok" });
    expect(await writer.run({ kind: "create", path: "a.md", content: "x" })).toMatchObject({ status: "failed", code: "exists" });
    expect(remote.files()["a.md"]).toBe("alpha\n\nbeta\n");
  });

  it("refuses to move onto an existing note", async () => {
    expect(await writer.run({ kind: "move", from: "a.md", to: "b.md" })).toMatchObject({ status: "failed" });
    expect(remote.history()).toHaveLength(0);
  });

  it("refuses an edit whose old_text appears more than once", async () => {
    await writer.run({ kind: "write", path: "d.md", content: "same same" });
    expect(await writer.run({ kind: "edit", path: "d.md", oldText: "same", newText: "x" })).toMatchObject({ status: "failed" });
  });

  it("refuses to edit or delete a note that doesn't exist", async () => {
    expect(await writer.run({ kind: "edit", path: "nope.md", oldText: "a", newText: "b" })).toMatchObject({ status: "failed" });
    expect(await writer.run({ kind: "delete", path: "nope.md" })).toMatchObject({ status: "failed" });
  });

  it("reuses the working copy: a second write doesn't sync again", async () => {
    await writer.run({ kind: "write", path: "x.md", content: "x" });
    await writer.run({ kind: "write", path: "y.md", content: "y" });
    expect(copy.syncs).toBe(1);
  });
});

describe("Writer: failures (confirm before reporting)", () => {
  it("reports ok, with the changed paths, when the push response was lost but the commit landed", async () => {
    copy.failNextPush = "error-landed";
    const r = await writer.run({ kind: "write", path: "x.md", content: "x" });
    expect(r).toMatchObject({ status: "ok", paths: ["x.md"] });
    expect(remote.files()["x.md"]).toBe("x");
  });

  it("still reports ok when the Mac pushed on top of the landed commit", async () => {
    copy.failNextPush = "error-landed";
    copy.beforeConfirm = () => remote.pushFromElsewhere({ "m.md": "mac" });
    const r = await writer.run({ kind: "write", path: "x.md", content: "x" });
    expect(r.status).toBe("ok");
  });

  it("reports failed, not unknown, when it breaks before pushing", async () => {
    copy.failCommit = true;
    const r = await writer.run({ kind: "write", path: "x.md", content: "x" });
    expect(r.status).toBe("failed");
    copy.failCommit = false;
    expect((await writer.run({ kind: "write", path: "y.md", content: "y" })).status).toBe("ok");
  });

  it("reports failed when the first clone fails", async () => {
    copy.failSync = true;
    expect((await writer.run({ kind: "write", path: "x.md", content: "x" })).status).toBe("failed");
  });

  it("doesn't fetch again after an operation that can't apply", async () => {
    await writer.run({ kind: "write", path: "x.md", content: "x" });
    const before = copy.syncs;
    await writer.run({ kind: "delete", path: "nope.md" });
    expect(copy.syncs).toBe(before);
    expect((await writer.run({ kind: "write", path: "y.md", content: "y" })).status).toBe("ok");
  });

  it("reports failed when the push errored and the commit is not on the remote", async () => {
    copy.failNextPush = "error";
    const r = await writer.run({ kind: "write", path: "x.md", content: "x" });
    expect(r.status).toBe("failed");
    expect(remote.files()["x.md"]).toBeUndefined();
  });

  it("reports unknown and drops the working copy when it can't even check", async () => {
    await writer.run({ kind: "write", path: "x.md", content: "x" }); // warm copy
    copy.failNextPush = "error";
    copy.beforePush = () => (copy.failSync = true);
    const r = await writer.run({ kind: "write", path: "y.md", content: "y" });
    expect(r.status).toBe("unknown");
    expect(copy.ready()).toBe(false);
  });

  it("keeps serving writes after a failed one", async () => {
    copy.failNextPush = "error";
    await writer.run({ kind: "write", path: "x.md", content: "x" });
    expect((await writer.run({ kind: "write", path: "y.md", content: "y" })).status).toBe("ok");
  });
});
