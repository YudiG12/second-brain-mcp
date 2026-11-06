import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, MAX_CHUNKS, checkPath, chunk, ideaPath, idsFrom, norm, pathHash, withSuffix } from "../src/lib/notes";

describe("norm", () => {
  it("drops accents and case", () => expect(norm("Decisão ÀÉÎ")).toBe("decisao aei"));
});

describe("checkPath", () => {
  it.each([
    ["projetos/cafezinho.md", "projetos/cafezinho.md"],
    ["  a.md  ", "a.md"],
    ["ideias/café.md", "ideias/café.md"],
  ])("accepts %j", (input, expected) => expect(checkPath(input)).toBe(expected));

  // spec v2 §3: relative, .md, at most 512 bytes, no "..", no empty or "." segments, no leading "/",
  // no backslash or control characters
  it.each(["../x.md", "a/../b.md", "a//b.md", "notes.txt", "a/", "", "/projetos/x.md", "./a.md", "a/./b.md", "a\\b.md", "a\u0000.md", "x".repeat(510) + ".md"])("rejects %j", (input) => {
    expect(() => checkPath(input)).toThrow(/Invalid path/);
  });
});

describe("chunk", () => {
  const para = (n: number, c = "a") => c.repeat(n);

  it("keeps a short note in one chunk", () => expect(chunk("one\n\ntwo")).toEqual(["one\n\ntwo"]));

  it("packs paragraphs up to about CHUNK_CHARS", () => {
    const parts = chunk([para(700), para(700, "b"), para(100, "c")].join("\n\n"));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(para(700));
    expect(parts[1].startsWith("b")).toBe(true);
  });

  it("keeps a single long paragraph as its own chunk", () => {
    const parts = chunk(para(CHUNK_CHARS * 3));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(CHUNK_CHARS * 3);
  });

  it(`stops at MAX_CHUNKS (${MAX_CHUNKS})`, () => {
    const body = Array.from({ length: MAX_CHUNKS + 10 }, () => para(CHUNK_CHARS)).join("\n\n");
    expect(chunk(body)).toHaveLength(MAX_CHUNKS);
  });

  it("returns nothing for an empty note", () => expect(chunk("  \n\n ")).toEqual([]));
});

describe("ids", () => {
  it("hashes a path to 24 hex characters, stable across calls", async () => {
    const h = await pathHash("projetos/x.md");
    expect(h).toMatch(/^[0-9a-f]{24}$/);
    expect(await pathHash("projetos/x.md")).toBe(h);
    expect(await pathHash("projetos/y.md")).not.toBe(h);
  });

  // #11: shrinking a note must delete every chunk id past the new length
  it("lists leftover ids from a given chunk up to MAX_CHUNKS - 1", async () => {
    const h = await pathHash("a.md");
    const ids = await idsFrom("a.md", 3);
    expect(ids).toHaveLength(MAX_CHUNKS - 3);
    expect(ids[0]).toBe(`${h}-3`);
    expect(ids.at(-1)).toBe(`${h}-${MAX_CHUNKS - 1}`);
  });

  it("covers every id when deleting a note", async () => {
    expect(await idsFrom("a.md", 0)).toHaveLength(MAX_CHUNKS);
  });
});

describe("ideaPath", () => {
  // 02:00 UTC on Nov 7 is still Nov 6 in Brasília
  const now = new Date("2026-11-07T02:00:00Z");

  it("uses the date in Brasília time and a slug of the title", async () => {
    expect(await ideaPath("Ideia: Café & Código!", now)).toBe("ideias/2026-11-06-ideia-cafe-codigo.md");
  });

  it("never ends the slug with a dash after capping it", async () => {
    const path = await ideaPath("x".repeat(59) + " y", now);
    expect(path).toBe(`ideias/2026-11-06-${"x".repeat(59)}.md`);
  });

  it("caps the slug at 60 characters", async () => {
    const slug = (await ideaPath("x".repeat(100), now)).replace("ideias/2026-11-06-", "").replace(".md", "");
    expect(slug).toHaveLength(60);
  });

  // #31: a title with no ASCII letters or digits used to give ideias/<date>-.md
  it("falls back to 8 hex characters of the title's hash when the slug would be empty", async () => {
    expect(await ideaPath("🚀🔥", now)).toMatch(/^ideias\/2026-11-06-[0-9a-f]{8}\.md$/);
    expect(await ideaPath("🚀🔥", now)).toBe(await ideaPath("🚀🔥", now));
  });
});

describe("withSuffix (#31)", () => {
  it("adds -2, -3... before the extension", () => {
    expect(withSuffix("ideias/2026-11-06-x.md", 1)).toBe("ideias/2026-11-06-x.md");
    expect(withSuffix("ideias/2026-11-06-x.md", 2)).toBe("ideias/2026-11-06-x-2.md");
    expect(withSuffix("ideias/2026-11-06-x.md", 3)).toBe("ideias/2026-11-06-x-3.md");
  });
});
