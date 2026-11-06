// Yudi's second brain as a remote MCP server.
// Cloudflare Artifacts (repo "notes") stores the notes: the source of truth, with full Git history (ADR 007).
// Reads go through the binding; writes go through one Durable Object per repository (ADR 008).
// Vectorize is only an index on top, rebuildable at any time.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { checkPath, chunk, idsFrom, ideaPath, norm, pathHash } from "./lib/notes";
import { listNotes, readNote } from "./notes-store";
import type { Operation } from "./writer/types";

export { RepoWriter } from "./writer/durable";

interface Env {
  AI: Ai;
  VECTORS: VectorizeIndex;
  ARTIFACTS: Artifacts;
  WRITER: DurableObjectNamespace<import("./writer/durable").RepoWriter>;
  NOTES_REPO: string;
  MCP_TOKEN: string;
  ADMIN_SECRET: string;
}
const E = env as unknown as Env;
const EMBED_MODEL = "@cf/baai/bge-m3"; // multilingual, 1024 dimensions

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });


// ---------- Index ----------

async function embed(texts: string[]): Promise<number[][]> {
  const res = (await E.AI.run(EMBED_MODEL as any, { text: texts })) as any;
  return res.data;
}




// indexes a note: upsert by the same id (re-running doesn't duplicate) and deletes leftover chunks
async function indexNote(path: string, body: string) {
  const parts = chunk(body);
  const h = await pathHash(path);
  if (parts.length) {
    const vectors = await embed(parts);
    await E.VECTORS.upsert(parts.map((t, i) => ({ id: `${h}-${i}`, values: vectors[i], metadata: { path, seq: i, text: t.slice(0, 1500) } })));
  }
  await E.VECTORS.deleteByIds(await idsFrom(path, parts.length));
  return parts.length;
}

async function unindexNote(path: string) {
  await E.VECTORS.deleteByIds(await idsFrom(path, 0));
}

// ---------- Writes ----------

function writer() {
  return E.WRITER.get(E.WRITER.idFromName(E.NOTES_REPO));
}

// Sends one operation to the repository's writer and describes the result for the client.
async function write(op: Operation): Promise<{ ok: boolean; message: string }> {
  const r = await writer().run(op);
  switch (r.status) {
    case "ok":
      return { ok: true, message: `(${r.commit.slice(0, 7)})` };
    case "failed":
      return { ok: false, message: r.reason };
    case "busy":
      return { ok: false, message: "The notes are changing too fast right now; nothing was saved. Try again." };
    case "unknown":
      return { ok: false, message: `Not sure the change was saved (${r.reason}). Check with read_note before retrying.` };
  }
}

// ---------- MCP tools ----------

function createServer() {
  const server = new McpServer({ name: "second-brain", version: "0.3.0" });

  server.registerTool(
    "list_notes",
    { description: "Lists the notes in Yudi's second brain (Markdown file paths, e.g. ideias/..., projetos/..., decisoes/...).", inputSchema: { prefix: z.string().optional() } },
    async ({ prefix }) => text((await listNotes(E.ARTIFACTS, prefix ?? "")).join("\n") || "No notes."),
  );

  server.registerTool(
    "read_note",
    { description: "Reads a whole note by path (e.g. visao-geral.md, projetos/cafezinho.md).", inputSchema: { path: z.string() } },
    async ({ path }) => text((await readNote(E.ARTIFACTS, path)) ?? `Note not found: ${path}`),
  );

  server.registerTool(
    "search_notes",
    { description: "Exact keyword search across notes (ignores accents and case). Good for names, acronyms and terms.", inputSchema: { query: z.string() } },
    async ({ query }) => {
      const terms = norm(query).split(/\s+/).filter(Boolean);
      const keys = await listNotes(E.ARTIFACTS);
      const bodies = await Promise.all(keys.map((k) => readNote(E.ARTIFACTS, k)));
      const hits: string[] = [];
      keys.forEach((key, n) =>
        (bodies[n] ?? "").split("\n").forEach((line, i) => {
          const l = norm(line);
          if (terms.every((t) => l.includes(t))) hits.push(`${key}:${i + 1}: ${line.trim()}`);
        }),
      );
      return text(hits.slice(0, 40).join("\n") || "Nothing found.");
    },
  );

  server.registerTool(
    "semantic_search",
    { description: "Semantic search across notes (embeddings + Vectorize). Good for questions like 'what did I decide about X'.", inputSchema: { query: z.string(), topK: z.number().int().min(1).max(10).optional() } },
    async ({ query, topK }) => {
      const [q] = await embed([query]);
      const res = await E.VECTORS.query(q, { topK: topK ?? 5, returnMetadata: "all" });
      const out = res.matches.map((m) => `[${m.score.toFixed(2)}] ${m.metadata?.path} (#${m.metadata?.seq})\n${m.metadata?.text}`);
      return text(out.join("\n\n---\n\n") || "Nothing found.");
    },
  );

  server.registerTool(
    "save_idea",
    { description: "Saves a new idea to ideias/YYYY-MM-DD-slug.md (one commit) and indexes it. The local clone pulls it on the next session.", inputSchema: { title: z.string(), content: z.string() } },
    async ({ title, content }) => {
      const path = ideaPath(title);
      const body = `# ${title}\n\n${content}\n`;
      const r = await write({ kind: "write", path, content: body });
      if (!r.ok) return text(r.message);
      await indexNote(path, body);
      return text(`Saved to ${path} ${r.message}`);
    },
  );

  server.registerTool(
    "write_note",
    { description: "Creates or overwrites a whole note in any folder (e.g. projetos/cafezinho.md). To change only part of it, prefer edit_note.", inputSchema: { path: z.string(), content: z.string() } },
    async ({ path, content }) => {
      const p = checkPath(path);
      const r = await write({ kind: "write", path: p, content });
      if (!r.ok) return text(r.message);
      await indexNote(p, content);
      return text(`Saved: ${p} ${r.message}`);
    },
  );

  server.registerTool(
    "edit_note",
    { description: "Replaces an exact passage of a note with another (old_text must appear exactly once). An empty new_text deletes the passage. Use read_note first to copy the exact passage.", inputSchema: { path: z.string(), old_text: z.string(), new_text: z.string() } },
    async ({ path, old_text, new_text }) => {
      const p = checkPath(path);
      const r = await write({ kind: "edit", path: p, oldText: old_text, newText: new_text });
      if (!r.ok) return text(r.message);
      const body = await readNote(E.ARTIFACTS, p);
      if (body !== null) await indexNote(p, body);
      return text(`Edited: ${p} ${r.message}`);
    },
  );

  server.registerTool(
    "delete_note",
    { description: "Deletes a note (it stays recoverable in the Git history).", inputSchema: { path: z.string() } },
    async ({ path }) => {
      const p = checkPath(path);
      const r = await write({ kind: "delete", path: p });
      if (!r.ok) return text(r.message);
      await unindexNote(p);
      return text(`Deleted: ${p} ${r.message}`);
    },
  );

  server.registerTool(
    "move_note",
    { description: "Moves or renames a note in one commit (e.g. ideias/x.md to projetos/x.md).", inputSchema: { from: z.string(), to: z.string() } },
    async ({ from, to }) => {
      const a = checkPath(from), b = checkPath(to);
      const r = await write({ kind: "move", from: a, to: b });
      if (!r.ok) return text(r.message);
      const body = await readNote(E.ARTIFACTS, b);
      if (body !== null) await indexNote(b, body);
      await unindexNote(a);
      return text(`Moved: ${a} -> ${b} ${r.message}`);
    },
  );

  return server;
}

const mcp = createMcpHandler(createServer);

// Admin routes use `Authorization: Bearer <ADMIN_SECRET>`, never a URL (spec v2 §2).
function isAdmin(request: Request, secret: string) {
  return !!secret && request.headers.get("Authorization") === `Bearer ${secret}`;
}

export default {
  async fetch(request: Request, envArg: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // a 1-hour write token for the notes repo, for the Mac's sync hook (ADR 007)
    if (url.pathname === "/admin/artifacts-token" && request.method === "POST") {
      if (!isAdmin(request, envArg.ADMIN_SECRET)) return new Response("Not found", { status: 404 });
      using repo = await envArg.ARTIFACTS.get(envArg.NOTES_REPO);
      const [info, tok] = await Promise.all([repo.info(), repo.createToken("write", 3600)]);
      return Response.json({ remote: info.remote, token: tok.plaintext.split("?")[0], expiresAt: tok.expiresAt });
    }

    // secret URL: /<token>/mcp. Without the token it's a 404, as if nothing existed.
    const prefix = `/${envArg.MCP_TOKEN}`;
    if (!envArg.MCP_TOKEN || !url.pathname.startsWith(prefix + "/")) return new Response("Not found", { status: 404 });
    url.pathname = url.pathname.slice(prefix.length);

    // rebuilds the whole index from the notes (POST /<token>/reindex)
    if (url.pathname === "/reindex" && request.method === "POST") {
      const keys = await listNotes(envArg.ARTIFACTS);
      let chunks = 0;
      for (const p of keys) {
        const body = await readNote(envArg.ARTIFACTS, p);
        if (body !== null) chunks += await indexNote(p, body);
      }
      return Response.json({ notes: keys.length, chunks });
    }
    return mcp(new Request(url.toString(), request), envArg, ctx);
  },
} satisfies ExportedHandler<Env>;
