import { describe, expect, it } from "vitest";
import { auditEntries, clientOf, span } from "../src/lib/audit";

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

describe("clientOf", () => {
  it("prefers the SDK's verified client id", () => {
    expect(clientOf({ authInfo: { clientId: "sdk" } }, { clientId: "props" })).toBe("sdk");
  });
  it("falls back to the client id the Worker put in the request props", () => {
    expect(clientOf({}, { clientId: "props" })).toBe("props");
    expect(clientOf(undefined, undefined)).toBeUndefined();
  });
});

describe("span", () => {
  const capture = () => {
    const lines: unknown[] = [];
    return { lines, log: (s: string) => lines.push(JSON.parse(s)) };
  };

  it("logs the tool, a numeric duration and ok:true when the handler succeeds", async () => {
    const c = capture();
    const out = await span("read_note", async () => "result", c.log);
    expect(out).toBe("result");
    expect(c.lines).toHaveLength(1);
    const l = c.lines[0] as Record<string, unknown>;
    expect(l).toMatchObject({ span: "tool", tool: "read_note", ok: true });
    expect(typeof l.ms).toBe("number");
    expect(l).not.toHaveProperty("error");
  });

  it("logs ok:false with the error and rethrows when the handler throws", async () => {
    const c = capture();
    await expect(span("edit_note", async () => { throw new Error("boom"); }, c.log)).rejects.toThrow("boom");
    expect(c.lines[0]).toMatchObject({ span: "tool", tool: "edit_note", ok: false, error: "Error: boom" });
  });

  it("counts an MCP error result as not ok", async () => {
    const c = capture();
    await span("delete_note", async () => ({ isError: true, content: [] }), c.log);
    expect(c.lines[0]).toMatchObject({ ok: false });
  });
});
