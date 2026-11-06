import { describe, expect, it } from "vitest";
import { ArtifactsWorkingCopy } from "../src/writer/artifacts";

// A history with a merge: m merges a (Mac) and w (the writer's commit) on its second parent.
const commits: Record<string, string[]> = { base: [], a: ["base"], w: ["base"], m: ["a", "w"], later: ["m"] };
const artifacts = {
  get: async () => ({
    readCommit: async (h: string) => (commits[h] ? { hash: h, parents: commits[h] } : null),
    log: async () => [{ hash: "later" }],
    [(Symbol as any).dispose]() {},
  }),
} as unknown as Artifacts;

describe("ArtifactsWorkingCopy.contains (confirming a push whose response was lost)", () => {
  const copy = new ArtifactsWorkingCopy(artifacts, "notes");
  (copy as any).head = "later";

  it("finds a commit on a merge's second parent", async () => {
    expect(await copy.contains("w")).toBe(true);
  });

  it("finds the first-parent line and the tip", async () => {
    expect(await copy.contains("a")).toBe(true);
    expect(await copy.contains("later")).toBe(true);
  });

  it("says no for a commit that never landed", async () => {
    expect(await copy.contains("lost")).toBe(false);
  });
});
