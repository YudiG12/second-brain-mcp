// Yudi's second brain as a remote MCP server.
// GitHub (YudiG12/segundo-cerebro) stores the notes: it is the source of truth, with full history.
// Vectorize is only an index on top, updated by the push webhook and rebuildable at any time.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { checkPath, chunk, idsFrom, ideaPath, norm, pathHash } from "./lib/notes";

interface Env {
  AI: Ai;
  VECTORS: VectorizeIndex;
  MCP_TOKEN: string;
  GITHUB_TOKEN: string;
  WEBHOOK_SECRET: string;
}
const E = env as unknown as Env;

const REPO = "YudiG12/segundo-cerebro";
const BRANCH = "main";
const EMBED_MODEL = "@cf/baai/bge-m3"; // multilingual, 1024 dimensions

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });


// ---------- GitHub ----------

async function gh(path: string, init: RequestInit = {}, accept = "application/vnd.github+json") {
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${E.GITHUB_TOKEN}`,
      Accept: accept,
      "User-Agent": "second-brain-mcp",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function listKeys(prefix = ""): Promise<string[]> {
  const res = await gh(`/git/trees/${BRANCH}?recursive=1`);
  if (!res.ok) throw new Error(`GitHub ${res.status} while listing notes`);
  const { tree } = (await res.json()) as { tree: { path: string; type: string }[] };
  return tree.filter((t) => t.type === "blob" && t.path.endsWith(".md") && t.path.startsWith(prefix)).map((t) => t.path);
}

async function readFile(path: string, ref = BRANCH): Promise<string | null> {
  const res = await gh(`/contents/${encPath(path)}?ref=${ref}`, {}, "application/vnd.github.raw+json");
  return res.ok ? res.text() : null;
}

// base64 of UTF-8 (btoa alone breaks on accented characters)
function b64(s: string) {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// current file sha (GitHub requires it to overwrite or delete); null if the file doesn't exist
async function fileSha(path: string): Promise<string | null> {
  const res = await gh(`/contents/${encPath(path)}?ref=${BRANCH}`);
  return res.ok ? ((await res.json()) as { sha: string }).sha : null;
}

async function writeFile(path: string, body: string, message: string) {
  const sha = await fileSha(path);
  const res = await gh(`/contents/${encPath(path)}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: b64(body), branch: BRANCH, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} while saving: ${await res.text()}`);
}

async function deleteFile(path: string, message: string) {
  const sha = await fileSha(path);
  if (!sha) throw new Error(`Note not found: ${path}`);
  const res = await gh(`/contents/${encPath(path)}`, { method: "DELETE", body: JSON.stringify({ message, sha, branch: BRANCH }) });
  if (!res.ok) throw new Error(`GitHub ${res.status} while deleting: ${await res.text()}`);
}


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

// ---------- GitHub webhook ----------

async function validSignature(body: string, header: string | null, secret: string) {
  if (!header?.startsWith("sha256=") || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = new Uint8Array(header.slice(7).match(/../g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(body));
}

type PushEvent = { ref: string; after: string; commits: { added: string[]; modified: string[]; removed: string[] }[] };

// merges the commits in a push: the last state of each file wins
async function applyPush(ev: PushEvent) {
  const state = new Map<string, "upsert" | "remove">();
  for (const c of ev.commits) {
    for (const p of [...c.added, ...c.modified]) state.set(p, "upsert");
    for (const p of c.removed) state.set(p, "remove");
  }
  for (const [p, op] of state) {
    if (!p.endsWith(".md")) continue;
    if (op === "remove") await unindexNote(p);
    else {
      const body = await readFile(p, ev.after);
      if (body !== null) await indexNote(p, body);
    }
  }
}

// ---------- MCP tools ----------

function createServer() {
  const server = new McpServer({ name: "second-brain", version: "0.3.0" });

  server.registerTool(
    "list_notes",
    { description: "Lists the notes in Yudi's second brain (Markdown file paths, e.g. ideias/..., projetos/..., decisoes/...).", inputSchema: { prefix: z.string().optional() } },
    async ({ prefix }) => text((await listKeys(prefix ?? "")).join("\n") || "No notes."),
  );

  server.registerTool(
    "read_note",
    { description: "Reads a whole note by path (e.g. visao-geral.md, projetos/cafezinho.md).", inputSchema: { path: z.string() } },
    async ({ path }) => text((await readFile(path)) ?? `Note not found: ${path}`),
  );

  server.registerTool(
    "search_notes",
    { description: "Exact keyword search across notes (ignores accents and case). Good for names, acronyms and terms.", inputSchema: { query: z.string() } },
    async ({ query }) => {
      const terms = norm(query).split(/\s+/).filter(Boolean);
      const keys = await listKeys();
      const bodies = await Promise.all(keys.map((k) => readFile(k)));
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
    { description: "Saves a new idea to ideias/YYYY-MM-DD-slug.md (a GitHub commit) and indexes it. The local clone pulls it on the next session.", inputSchema: { title: z.string(), content: z.string() } },
    async ({ title, content }) => {
      const path = ideaPath(title);
      const body = `# ${title}\n\n${content}\n`;
      await writeFile(path, body, `idea: ${title} (via MCP)`);
      await indexNote(path, body); // the webhook re-indexes too; this makes it searchable right away
      return text(`Saved to ${path}`);
    },
  );

  server.registerTool(
    "write_note",
    { description: "Creates or overwrites a whole note in any folder (e.g. projetos/cafezinho.md). To change only part of it, prefer edit_note.", inputSchema: { path: z.string(), content: z.string() } },
    async ({ path, content }) => {
      const p = checkPath(path);
      const existed = (await fileSha(p)) !== null;
      await writeFile(p, content, `${existed ? "edit" : "create"}: ${p} (via MCP)`);
      await indexNote(p, content);
      return text(`${existed ? "Updated" : "Created"}: ${p}`);
    },
  );

  server.registerTool(
    "edit_note",
    { description: "Replaces an exact passage of a note with another (old_text must appear exactly once). An empty new_text deletes the passage. Use read_note first to copy the exact passage.", inputSchema: { path: z.string(), old_text: z.string(), new_text: z.string() } },
    async ({ path, old_text, new_text }) => {
      const p = checkPath(path);
      const body = await readFile(p);
      if (body === null) return text(`Note not found: ${p}`);
      const n = body.split(old_text).length - 1;
      if (n !== 1) return text(n === 0 ? "Passage not found. Read the note and copy the exact passage." : `The passage appears ${n} times; include more context so it is unique.`);
      const next = body.replace(old_text, () => new_text);
      await writeFile(p, next, `edit: ${p} (via MCP)`);
      await indexNote(p, next);
      return text(`Edited: ${p}`);
    },
  );

  server.registerTool(
    "delete_note",
    { description: "Deletes a note (it stays recoverable in the Git history).", inputSchema: { path: z.string() } },
    async ({ path }) => {
      const p = checkPath(path);
      await deleteFile(p, `delete: ${p} (via MCP)`);
      await unindexNote(p);
      return text(`Deleted: ${p}`);
    },
  );

  server.registerTool(
    "move_note",
    { description: "Moves or renames a note (e.g. ideias/x.md to projetos/x.md).", inputSchema: { from: z.string(), to: z.string() } },
    async ({ from, to }) => {
      const a = checkPath(from), b = checkPath(to);
      const body = await readFile(a);
      if (body === null) return text(`Note not found: ${a}`);
      if ((await fileSha(b)) !== null) return text(`A note already exists at ${b}`);
      await writeFile(b, body, `move: ${a} -> ${b} (via MCP)`);
      await deleteFile(a, `move: ${a} -> ${b} (via MCP)`);
      await indexNote(b, body);
      await unindexNote(a);
      return text(`Moved: ${a} -> ${b}`);
    },
  );

  return server;
}

const mcp = createMcpHandler(createServer);

export default {
  async fetch(request: Request, envArg: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // secret URL: /<token>/mcp. Without the token it's a 404, as if nothing existed.
    const prefix = `/${envArg.MCP_TOKEN}`;
    if (!envArg.MCP_TOKEN || !url.pathname.startsWith(prefix + "/")) return new Response("Not found", { status: 404 });
    url.pathname = url.pathname.slice(prefix.length);

    // push to the repo: re-index what changed and remove deleted notes from the index
    if (url.pathname === "/github-webhook" && request.method === "POST") {
      const body = await request.text();
      if (!(await validSignature(body, request.headers.get("X-Hub-Signature-256"), envArg.WEBHOOK_SECRET))) return new Response("bad signature", { status: 401 });
      const event = request.headers.get("X-GitHub-Event");
      if (event === "ping") return new Response("pong");
      if (event !== "push") return new Response("ignored", { status: 202 });
      const ev = JSON.parse(body) as PushEvent;
      if (ev.ref !== `refs/heads/${BRANCH}`) return new Response("other branch", { status: 202 });
      ctx.waitUntil(applyPush(ev));
      return new Response("ok", { status: 202 });
    }

    // rebuilds the whole index from GitHub (POST /<token>/reindex)
    if (url.pathname === "/reindex" && request.method === "POST") {
      const keys = await listKeys();
      let chunks = 0;
      for (const p of keys) {
        const body = await readFile(p);
        if (body !== null) chunks += await indexNote(p, body);
      }
      return Response.json({ notes: keys.length, chunks });
    }
    return mcp(new Request(url.toString(), request), envArg, ctx);
  },
} satisfies ExportedHandler<Env>;
