import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { accessToken, callTool } from "./helpers/oauth";
import { beforeAll, describe, expect, it } from "vitest";

const db = (env as any).DB as D1Database;

let token = "";
const searchNotes = (query: string) => callTool(token, "search_notes", { query });

describe("search_notes (hybrid, ADR 012)", () => {
  beforeAll(async () => {
    token = await accessToken();
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
