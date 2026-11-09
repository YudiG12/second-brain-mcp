// Yudi's second brain as a remote MCP server.
// Cloudflare Artifacts (repo "notes") stores the notes: the source of truth, with full Git history (ADR 007).
// Reads go through the binding; writes go through one Durable Object per repository (ADR 008).
// Vectorize is only an index on top, rebuildable at any time.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { ArtifactsNotes, D1Keywords, D1Manifest, VectorizeAdapter, WorkersAiEmbedder } from "./indexer/adapters";
import { handle } from "./indexer/indexer";
import type { Deps, IndexMessage, QueueMessage } from "./indexer/types";
import { checkPath, ideaPath, withSuffix } from "./lib/notes";
import { buildFtsQuery, fuse, semanticHits, type Hit } from "./search/hybrid";

// Semantic results below this cosine similarity are dropped. It only removes noise: measured on the
// real notes, bge-m3 scores unrelated questions up to 0.48 and a real question's best note can be
// 0.44, so no floor separates them (ADR 012, #33). The first guess, 0.45, cut real results.
const SEMANTIC_FLOOR = 0.3;
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { authorize, callback } from "./auth/github";
import { listNotes, readNote } from "./notes-store";
import type { Operation, WriteResult } from "./writer/types";
import { noteVersion } from "./writer/version";

export { RepoWriter } from "./writer/durable";
export { Reconcile } from "./reconcile/workflow";

interface Env {
  AI: Ai;
  VECTORS: VectorizeIndex;
  ARTIFACTS: Artifacts;
  WRITER: DurableObjectNamespace<import("./writer/durable").RepoWriter>;
  DB: D1Database;
  INDEX_JOBS: Queue<QueueMessage>;
  RECONCILE: Workflow;
  NOTES_REPO: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OWNER_GITHUB_ID: string;
  ADMIN_SECRET: string;
  HOOK_SECRET: string;
}
const E = env as unknown as Env;
const PUBLIC_URL = (env as unknown as { PUBLIC_URL: string }).PUBLIC_URL;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });


// ---------- Index (ADR 009, ADR 010) ----------

const embedder = () => new WorkersAiEmbedder(E.AI);

async function enqueue(messages: IndexMessage[], delaySeconds?: number) {
  // sendBatch takes at most 100 messages
  for (let i = 0; i < messages.length; i += 100) await E.INDEX_JOBS.sendBatch(messages.slice(i, i + 100).map((body) => ({ body })), delaySeconds ? { delaySeconds } : undefined);
}

const opPaths = (op: Operation) => (op.kind === "move" ? [op.from, op.to] : [op.path]);

/** Queue retry backoff: 10, 20, 40, 80, 160 seconds (spec v2 §5.2). */
export const retryDelay = (attempts: number) => 10 * 2 ** (attempts - 1);

function indexerDeps(envArg: Env): Deps {
  return {
    notes: new ArtifactsNotes(envArg.ARTIFACTS, envArg.NOTES_REPO),
    index: new VectorizeAdapter(envArg.VECTORS),
    embedder: new WorkersAiEmbedder(envArg.AI),
    manifest: new D1Manifest(envArg.DB),
    keywords: new D1Keywords(envArg.DB),
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
/** Runs one operation on the repository's writer. A failed call to the object is an unknown outcome. */
async function runOp(op: Operation): Promise<WriteResult> {
  try {
    return await writer().run(op);
  } catch (e) {
    // the object may have reset mid-write (e.g. during a deploy): the push may or may not have landed
    return { status: "unknown", reason: String(e) };
  }
}

/** Describes a write result for the client, and enqueues the changed notes for indexing. */
async function describe(r: WriteResult, op: Operation, done: string): Promise<string> {
  switch (r.status) {
    case "failed":
      return r.reason;
    case "busy":
      return "The notes are changing too fast right now; nothing was saved. Try again.";
    case "unknown":
      // enqueue anyway: indexing reads the head, so this is harmless if nothing landed
      await enqueue(opPaths(op).map((path) => ({ type: "index", path, reason: "write" }))).catch(() => {});
      return `Not sure the change to ${opPaths(op).join(" and ")} was saved (${r.reason}). Check it with read_note before retrying.`;
  }
  const saved = `${done} (${r.commit.slice(0, 7)}). Search reflects it in a few seconds to a couple of minutes.`;
  try {
    await enqueue(r.paths.map((path) => ({ type: "index", path, reason: "write" })));
    return saved;
  } catch (e) {
    return `${saved}. Search will catch up later (enqueue failed: ${String(e)}).`;
  }
}

async function write(op: Operation, done: string): Promise<string> {
  return describe(await runOp(op), op, done);
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
    { description: "Reads a whole note by path (e.g. visao-geral.md, projetos/cafezinho.md). Also returns its version, which write_note needs to overwrite it.", inputSchema: { path: z.string() } },
    async ({ path }) => {
      const p = checkPath(path); // same rules as writes (#30)
      const body = await readNote(E.ARTIFACTS, p);
      if (body === null) return text(`Note not found: ${p}`);
      // the version goes in its own block, so an agent rewriting the note doesn't copy it into the content
      return { content: [{ type: "text" as const, text: body }, { type: "text" as const, text: `version: ${await noteVersion(body)}` }] };
    },
  );

  server.registerTool(
    "search_notes",
    {
      description: "Hybrid search across notes: exact words (names, acronyms, terms) and meaning, in one ranked list. Each result says how it matched: keyword, semantic or both. Ignores accents and case; words match by prefix.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
    },
    async ({ query, limit }) => {
      const fts = buildFtsQuery(query);
      // each half degrades on its own: one failing still returns the other, and says so
      const [keyword, semantic] = await Promise.all([
        (fts
          ? E.DB.prepare("SELECT path, seq, text FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 50").bind(fts).all<Hit>().then((r) => r.results)
          : Promise.resolve([] as Hit[])
        ).catch((e) => (console.error(JSON.stringify({ keywordSearchFailed: String(e) })), null)),
        (async () => {
          const [q] = await embedder().embed([query]);
          const res = await E.VECTORS.query(q, { topK: 50, returnMetadata: "all" });
          return semanticHits(res.matches, SEMANTIC_FLOOR);
        })().catch((e) => (console.error(JSON.stringify({ semanticSearchFailed: String(e) })), null)),
      ]);
      if (keyword === null && semantic === null) return text("Search is unavailable right now. Try again in a moment.");
      const results = fuse(keyword ?? [], semantic ?? [], limit ?? 10);
      const lines = results.map((r) => `${r.path} (${r.matched})\n${r.text.slice(0, 400)}`);
      const note =
        semantic === null ? "\n\n(semantic search unavailable right now: keyword results only)" : keyword === null ? "\n\n(keyword search unavailable right now: semantic results only)" : "";
      return text((lines.join("\n\n---\n\n") || "Nothing found.") + note);
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
      // never overwrite another idea with the same title on the same day (#31): try -2, -3...
      const base = await ideaPath(title);
      const body = `# ${title}\n\n${content}\n`;
      for (let n = 1; n <= 20; n++) {
        const path = withSuffix(base, n);
        const r = await runOp({ kind: "create", path, content: body });
        if (r.status === "failed" && r.code === "exists") continue;
        return text(await describe(r, { kind: "create", path, content: body }, `Saved: ${path}`));
      }
      return text(`Too many ideas named "${title}" today; nothing was saved. Use a different title.`);
    },
  );

  server.registerTool(
    "write_note",
    {
      description: "Creates a note, or overwrites a whole one (e.g. projetos/cafezinho.md). To overwrite, pass expected_version: the version read_note returned. If the note changed since, nothing is saved and you get a conflict: read it again and redo the change. To change only part of a note, prefer edit_note.",
      inputSchema: { path: z.string(), content: z.string(), expected_version: z.string().optional() },
    },
    async ({ path, content, expected_version }) => {
      const p = checkPath(path);
      return text(await write({ kind: "write", path: p, content, ...(expected_version ? { expectedVersion: expected_version } : {}) }, `Saved: ${p}`));
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
async function hasBearer(request: Request, secret: string) {
  if (!secret) return false;
  // compare digests in constant time, so response timing reveals nothing about the secret
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [given, expected] = await Promise.all([digest(request.headers.get("Authorization") ?? ""), digest(`Bearer ${secret}`)]);
  return crypto.subtle.timingSafeEqual(given, expected);
}

/** Everything that isn't OAuth plumbing or the OAuth-protected /mcp (see the export at the bottom). */
const app = {
  async fetch(request: Request, envArg: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // MCP client sign-in (ADR 011): consent page, then GitHub, then the owner check
    if (url.pathname === "/authorize") return authorize(request, envArg);
    if (url.pathname === "/callback" && request.method === "GET") return callback(request, envArg);

    // a 1-hour write token for the notes repo, for the Mac's sync hook (ADR 007). Its own secret,
    // which can do nothing else: a leak from the Mac can't reach the admin routes (#39).
    if (url.pathname === "/hook/artifacts-token" && request.method === "POST") {
      if (!(await hasBearer(request, envArg.HOOK_SECRET))) return new Response("Not found", { status: 404 });
      using repo = await envArg.ARTIFACTS.get(envArg.NOTES_REPO);
      const [info, tok] = await Promise.all([repo.info(), repo.createToken("write", 3600)]);
      return Response.json({ remote: info.remote, token: tok.plaintext.split("?")[0], expiresAt: tok.expiresAt }, { headers: { "Cache-Control": "no-store" } });
    }

    // OAuth grants: list (GET /admin/grants) and revoke one (DELETE /admin/grants/<id>) (ADR 011)
    if (url.pathname === "/admin/grants" || url.pathname.startsWith("/admin/grants/")) {
      if (!(await hasBearer(request, envArg.ADMIN_SECRET))) return new Response("Not found", { status: 404 });
      let id = "";
      try {
        id = decodeURIComponent(url.pathname.slice("/admin/grants/".length));
      } catch {
        return new Response("Bad grant id", { status: 400 });
      }
      if (request.method === "GET" && !id) {
        const items: any[] = [];
        let cursor: string | undefined;
        do {
          const page: any = await envArg.OAUTH_PROVIDER.listUserGrants(envArg.OWNER_GITHUB_ID, cursor ? { cursor } : undefined);
          items.push(...page.items);
          cursor = page.cursor;
        } while (cursor);
        return Response.json(items.map((g: any) => ({ id: g.id, clientId: g.clientId, scope: g.scope, createdAt: g.createdAt })), { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "DELETE" && id) {
        await envArg.OAUTH_PROVIDER.revokeGrant(id, envArg.OWNER_GITHUB_ID);
        return Response.json({ revoked: id });
      }
      return new Response("Method not allowed", { status: 405 });
    }

    // starts a reconciliation (default) or a full rebuild (?mode=rebuild); returns the instance id
    if (url.pathname === "/admin/reconcile" && request.method === "POST") {
      if (!(await hasBearer(request, envArg.ADMIN_SECRET))) return new Response("Not found", { status: 404 });
      const mode = url.searchParams.get("mode") === "rebuild" ? "rebuild" : "daily";
      const instance = await envArg.RECONCILE.create({ id: `manual-${mode}-${crypto.randomUUID()}`, params: { mode } });
      return Response.json({ id: instance.id, mode }, { status: 202 });
    }

    return new Response("Not found", { status: 404 });
  },

  // index-jobs: one message at a time, in order (ADR 009). index-jobs-dlq: what exhausted its retries.
  async queue(batch: MessageBatch<QueueMessage>, envArg: Env) {
    if (batch.queue === "index-jobs-dlq") {
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
        msg.retry({ delaySeconds: retryDelay(msg.attempts) });
      }
    }
  },
};

// The Worker is its own OAuth 2.1 authorization server (ADR 011). /mcp needs an access token;
// /authorize, /token, /register and the discovery documents are handled here; everything else
// goes to `app`. OAuth is the only way in (the token-in-URL route was removed in #52).
const oauth = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    async fetch(request, envArg, ctx) {
      // audit: which client made the call (never the token itself)
      const auth = (ctx as any).auth as { clientId?: string; userId?: string } | undefined;
      console.log(JSON.stringify({ mcp: request.method, clientId: auth?.clientId, userId: auth?.userId }));
      return mcp(request, envArg, ctx);
    },
  },
  defaultHandler: { fetch: (request, envArg, ctx) => app.fetch(request, envArg as Env, ctx) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 3600, // 1 hour
  refreshTokenIdleTTL: 30 * 24 * 3600, // a grant expires after 30 days without use
  resourceMetadata: { resource: `${PUBLIC_URL}/mcp`, authorization_servers: [PUBLIC_URL] },
});

export default {
  fetch: (request: Request, envArg: Env, ctx: ExecutionContext) => oauth.fetch(request, envArg, ctx),
  queue: app.queue,
  // daily: remove expired grants and tokens, and clients that registered again and left orphans
  async scheduled(_event: ScheduledController, envArg: Env) {
    // resumable: each run continues the sweep where the last one stopped
    const cursor = (await envArg.OAUTH_KV.get("purge:cursor")) ?? undefined;
    const result = await oauth.purgeExpiredData(envArg, cursor ? { cursor } : undefined);
    if (result.cursor) await envArg.OAUTH_KV.put("purge:cursor", result.cursor);
    else await envArg.OAUTH_KV.delete("purge:cursor");
    console.log(JSON.stringify({ oauthPurge: { ...result, cursor: undefined } }));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
