// Yudi's second brain as a remote MCP server.
// Cloudflare Artifacts (repo "notes") stores the notes: the source of truth, with full Git history (ADR 007).
// Reads go through the binding; writes go through one Durable Object per repository (ADR 008).
// Vectorize is only an index on top, rebuildable at any time.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { ArtifactsNotes, D1Manifest, VectorizeAdapter, WorkersAiEmbedder } from "./indexer/adapters";
import { handle } from "./indexer/indexer";
import type { Deps, IndexMessage, QueueMessage } from "./indexer/types";
import { checkPath, ideaPath, norm } from "./lib/notes";
import { listNotes, readNote } from "./notes-store";
import type { Operation, WriteResult } from "./writer/types";

export { RepoWriter } from "./writer/durable";

interface Env {
  AI: Ai;
  VECTORS: VectorizeIndex;
  ARTIFACTS: Artifacts;
  WRITER: DurableObjectNamespace<import("./writer/durable").RepoWriter>;
  DB: D1Database;
  INDEX_JOBS: Queue<QueueMessage>;
  NOTES_REPO: string;
  MCP_TOKEN: string;
  ADMIN_SECRET: string;
}
const E = env as unknown as Env;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });


// ---------- Index (ADR 009, ADR 010) ----------

const embedder = () => new WorkersAiEmbedder(E.AI);

async function enqueue(messages: IndexMessage[]) {
  // sendBatch takes at most 100 messages
  for (let i = 0; i < messages.length; i += 100) await E.INDEX_JOBS.sendBatch(messages.slice(i, i + 100).map((body) => ({ body })));
}

function indexerDeps(envArg: Env): Deps {
  return {
    notes: new ArtifactsNotes(envArg.ARTIFACTS, envArg.NOTES_REPO),
    index: new VectorizeAdapter(envArg.VECTORS),
    embedder: new WorkersAiEmbedder(envArg.AI),
    manifest: new D1Manifest(envArg.DB),
    enqueue,
    repoName: envArg.NOTES_REPO,
  };
}

// ---------- Writes ----------

function writer() {
  return E.WRITER.get(E.WRITER.idFromName(E.NOTES_REPO));
}

// Sends one operation to the repository's writer, then enqueues the changed notes for indexing.
// The Queue consumer is the only index writer (ADR 009); a failed enqueue doesn't fail the write.
async function write(op: Operation, done: string): Promise<string> {
  let r: WriteResult;
  try {
    r = await writer().run(op);
  } catch (e) {
    // the object may have reset mid-write (e.g. during a deploy): the push may or may not have landed
    return `Not sure the change was saved (${String(e)}). Check with read_note before retrying.`;
  }
  switch (r.status) {
    case "failed":
      return r.reason;
    case "busy":
      return "The notes are changing too fast right now; nothing was saved. Try again.";
    case "unknown":
      return `Not sure the change was saved (${r.reason}). Check with read_note before retrying.`;
  }
  const saved = `${done} (${r.commit.slice(0, 7)})`;
  try {
    await enqueue(r.paths.map((path) => ({ type: "index", path, reason: "write" })));
    return saved;
  } catch (e) {
    return `${saved}. Search will catch up later (enqueue failed: ${String(e)}).`;
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
      const [q] = await embedder().embed([query]);
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
      return text(await write({ kind: "write", path, content: `# ${title}\n\n${content}\n` }, `Saved: ${path}`));
    },
  );

  server.registerTool(
    "write_note",
    { description: "Creates or overwrites a whole note in any folder (e.g. projetos/cafezinho.md). To change only part of it, prefer edit_note.", inputSchema: { path: z.string(), content: z.string() } },
    async ({ path, content }) => {
      const p = checkPath(path);
      return text(await write({ kind: "write", path: p, content }, `Saved: ${p}`));
    },
  );

  server.registerTool(
    "edit_note",
    { description: "Replaces an exact passage of a note with another (old_text must appear exactly once). An empty new_text deletes the passage. Use read_note first to copy the exact passage.", inputSchema: { path: z.string(), old_text: z.string(), new_text: z.string() } },
    async ({ path, old_text, new_text }) => {
      const p = checkPath(path);
      return text(await write({ kind: "edit", path: p, oldText: old_text, newText: new_text }, `Edited: ${p}`));
    },
  );

  server.registerTool(
    "delete_note",
    { description: "Deletes a note (it stays recoverable in the Git history).", inputSchema: { path: z.string() } },
    async ({ path }) => {
      const p = checkPath(path);
      return text(await write({ kind: "delete", path: p }, `Deleted: ${p}`));
    },
  );

  server.registerTool(
    "move_note",
    { description: "Moves or renames a note in one commit (e.g. ideias/x.md to projetos/x.md).", inputSchema: { from: z.string(), to: z.string() } },
    async ({ from, to }) => {
      const a = checkPath(from), b = checkPath(to);
      return text(await write({ kind: "move", from: a, to: b }, `Moved: ${a} -> ${b}`));
    },
  );

  return server;
}

const mcp = createMcpHandler(createServer);

// Admin routes use `Authorization: Bearer <ADMIN_SECRET>`, never a URL (spec v2 §2).
async function isAdmin(request: Request, secret: string) {
  if (!secret) return false;
  // compare digests in constant time, so response timing reveals nothing about the secret
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [given, expected] = await Promise.all([digest(request.headers.get("Authorization") ?? ""), digest(`Bearer ${secret}`)]);
  return crypto.subtle.timingSafeEqual(given, expected);
}

export default {
  async fetch(request: Request, envArg: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // a 1-hour write token for the notes repo, for the Mac's sync hook (ADR 007)
    if (url.pathname === "/admin/artifacts-token" && request.method === "POST") {
      if (!(await isAdmin(request, envArg.ADMIN_SECRET))) return new Response("Not found", { status: 404 });
      using repo = await envArg.ARTIFACTS.get(envArg.NOTES_REPO);
      const [info, tok] = await Promise.all([repo.info(), repo.createToken("write", 3600)]);
      return Response.json({ remote: info.remote, token: tok.plaintext.split("?")[0], expiresAt: tok.expiresAt }, { headers: { "Cache-Control": "no-store" } });
    }

    // secret URL: /<token>/mcp. Without the token it's a 404, as if nothing existed.
    const prefix = `/${envArg.MCP_TOKEN}`;
    if (!envArg.MCP_TOKEN || !url.pathname.startsWith(prefix + "/")) return new Response("Not found", { status: 404 });
    url.pathname = url.pathname.slice(prefix.length);

    // re-indexes every note through the queue (POST /<token>/reindex). Until the reconciliation
    // Workflow lands (#7, #8), it doesn't remove vectors of notes that no longer exist.
    if (url.pathname === "/reindex" && request.method === "POST") {
      const keys = await listNotes(envArg.ARTIFACTS);
      await enqueue(keys.map((path) => ({ type: "index", path, reason: "rebuild" })));
      return Response.json({ enqueued: keys.length }, { status: 202 });
    }
    return mcp(new Request(url.toString(), request), envArg, ctx);
  },

  // index-jobs: one message at a time, in order (ADR 009). index-jobs-dlq: what exhausted its retries.
  async queue(batch: MessageBatch<QueueMessage>, envArg: Env) {
    if (batch.queue.endsWith("-dlq")) {
      for (const msg of batch.messages) {
        console.error(JSON.stringify({ alert: "index job failed after retries", body: msg.body }));
        await envArg.DB.prepare("INSERT INTO alerts (source, body, created_at) VALUES ('dlq', ?, ?)").bind(JSON.stringify(msg.body), new Date().toISOString()).run();
        msg.ack();
      }
      return;
    }
    const deps = indexerDeps(envArg);
    for (const msg of batch.messages) {
      try {
        const outcome = await handle(msg.body, deps);
        console.log(JSON.stringify({ indexed: outcome }));
        msg.ack();
      } catch (e) {
        console.error(JSON.stringify({ indexFailed: String(e), attempt: msg.attempts, body: msg.body }));
        msg.retry({ delaySeconds: 10 * 2 ** (msg.attempts - 1) }); // 10, 20, 40, 80, 160 s
      }
    }
  },
} satisfies ExportedHandler<Env, QueueMessage>;
