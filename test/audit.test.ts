import { describe, expect, it } from "vitest";
import { auditEntries } from "../src/lib/audit";

describe("auditEntries", () => {
  it("names the tool and the notes it touches, never the content", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit_note", arguments: { path: "ideias/x.md", old_text: "secret", new_text: "other" } } };
    expect(auditEntries(body)).toEqual([{ rpc: "tools/call", tool: "edit_note", paths: ["ideias/x.md"] }]);
  });

  it("logs both ends of a move", () => {
    const body = { method: "tools/call", params: { name: "move_note", arguments: { from: "ideias/a.md", to: "projetos/a.md" } } };
    expect(auditEntries(body)).toEqual([{ rpc: "tools/call", tool: "move_note", paths: ["ideias/a.md", "projetos/a.md"] }]);
  });

  it("keeps other JSON-RPC methods to the method name", () => {
    expect(auditEntries({ method: "tools/list" })).toEqual([{ rpc: "tools/list" }]);
  });

  it("handles a JSON-RPC batch and bodies that are not JSON-RPC", () => {
    expect(auditEntries([{ method: "tools/list" }, { method: "tools/call", params: { name: "read_note", arguments: { path: "a.md" } } }]))
      .toEqual([{ rpc: "tools/list" }, { rpc: "tools/call", tool: "read_note", paths: ["a.md"] }]);
    expect(auditEntries(null)).toEqual([]);
    expect(auditEntries("nope")).toEqual([]);
  });
});
