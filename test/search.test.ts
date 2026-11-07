import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const db = (env as any).DB as D1Database;

async function searchNotes(query: string) {
  const res = await exports.default.fetch("https://example.com/test-token/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query } } }),
  });
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? body;
  return JSON.parse(data).result.content[0].text as string;
}

describe("search_notes (hybrid, ADR 012)", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, (env as any).TEST_MIGRATIONS as D1Migration[]);
    await db.batch([
      db.prepare("INSERT INTO chunks_fts (path, seq, text) VALUES ('projetos/railblocks.md', 0, 'Call com o Lorenzo sobre a Railblocks')"),
      db.prepare("INSERT INTO chunks_fts (path, seq, text) VALUES ('ideias/cafe.md', 0, 'Quadro do café nos vlogs')"),
    ]);
  });

  // No Vectorize or Workers AI in tests: semantic search fails, and keyword results still come back.
  it("finds notes by keyword without reading any note, and says the semantic half is unavailable", async () => {
    const out = await searchNotes("o que o Lorenzo disse");
    expect(out).toContain("projetos/railblocks.md");
    expect(out).toContain("keyword");
    expect(out).not.toContain("ideias/cafe.md");
    expect(out).toMatch(/semantic search unavailable/i);
  });

  it("ignores accents and matches prefixes", async () => {
    expect(await searchNotes("CAFE")).toContain("ideias/cafe.md");
    expect(await searchNotes("rail")).toContain("projetos/railblocks.md");
  });
});
