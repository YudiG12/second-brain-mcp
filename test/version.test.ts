import { beforeEach, describe, expect, it } from "vitest";
import { Writer } from "../src/writer/writer";
import { noteVersion } from "../src/writer/version";
import { FakeRemote, FakeWorkingCopy } from "./fakes/git";

let remote: FakeRemote;
let copy: FakeWorkingCopy;
let writer: Writer;

beforeEach(() => {
  remote = new FakeRemote({ "a.md": "alpha\n" });
  copy = new FakeWorkingCopy(remote);
  writer = new Writer(copy);
});

describe("write_note: optimistic concurrency on overwrites", () => {
  it("is a stable 12-char hash that changes with the content", async () => {
    expect(await noteVersion("alpha\n")).toMatch(/^[0-9a-f]{12}$/);
    expect(await noteVersion("alpha\n")).toBe(await noteVersion("alpha\n"));
    expect(await noteVersion("alpha\n")).not.toBe(await noteVersion("alpha!\n"));
  });

  it("overwrites when the version the agent read is still current", async () => {
    const r = await writer.run({ kind: "write", path: "a.md", content: "new", expectedVersion: await noteVersion("alpha\n") });
    expect(r.status).toBe("ok");
    expect(remote.files()["a.md"]).toBe("new");
  });

  it("refuses to overwrite an existing note without a version", async () => {
    const r = await writer.run({ kind: "write", path: "a.md", content: "new" });
    expect(r).toMatchObject({ status: "failed", code: "conflict" });
    expect(remote.files()["a.md"]).toBe("alpha\n");
  });

  it("creates a new note without a version", async () => {
    expect((await writer.run({ kind: "write", path: "n.md", content: "n" })).status).toBe("ok");
  });

  it("two agents read the same version: the second overwrite is a conflict, not a lost update", async () => {
    const v = await noteVersion("alpha\n");
    const first = await writer.run({ kind: "write", path: "a.md", content: "from claude", expectedVersion: v });
    const second = await writer.run({ kind: "write", path: "a.md", content: "from chatgpt", expectedVersion: v });
    expect(first.status).toBe("ok");
    expect(second).toMatchObject({ status: "failed", code: "conflict" });
    expect((second as { reason: string }).reason).toContain(await noteVersion("from claude"));
    expect(remote.files()["a.md"]).toBe("from claude");
  });

  it("re-checks the version on the new tip when the Mac pushed the same note in between", async () => {
    copy.beforePush = () => remote.pushFromElsewhere({ "a.md": "edited on the mac\n" });
    const r = await writer.run({ kind: "write", path: "a.md", content: "stale", expectedVersion: await noteVersion("alpha\n") });
    expect(r).toMatchObject({ status: "failed", code: "conflict" });
    expect(remote.files()["a.md"]).toBe("edited on the mac\n");
  });

  it("still lands when the Mac pushed a different note in between", async () => {
    copy.beforePush = () => remote.pushFromElsewhere({ "b.md": "mac\n" });
    const r = await writer.run({ kind: "write", path: "a.md", content: "new", expectedVersion: await noteVersion("alpha\n") });
    expect(r.status).toBe("ok");
    expect(remote.files()).toMatchObject({ "a.md": "new", "b.md": "mac\n" });
  });

  it("reports a conflict when the note was deleted since it was read", async () => {
    await writer.run({ kind: "delete", path: "a.md" });
    const r = await writer.run({ kind: "write", path: "a.md", content: "x", expectedVersion: await noteVersion("alpha\n") });
    expect(r).toMatchObject({ status: "failed", code: "conflict" });
  });
});
