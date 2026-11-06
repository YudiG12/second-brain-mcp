// Segundo cérebro do Yudi como servidor MCP remoto.
// GitHub (YudiG12/segundo-cerebro) guarda as notas: é a fonte da verdade, com histórico.
// Vectorize é só um índice por cima, atualizado pelo webhook de push e reconstruível a qualquer hora.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

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
const EMBED_MODEL = "@cf/baai/bge-m3"; // multilíngue, 1024 dimensões
const CHUNK_CHARS = 1200;
const MAX_CHUNKS = 50; // teto de pedaços por nota, usado pra apagar sobras

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// tira acento e caixa, pra "decisão" achar "decisao"
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// ---------- GitHub ----------

async function gh(path: string, init: RequestInit = {}, accept = "application/vnd.github+json") {
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${E.GITHUB_TOKEN}`,
      Accept: accept,
      "User-Agent": "cerebro-mcp",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function listKeys(prefix = ""): Promise<string[]> {
  const res = await gh(`/git/trees/${BRANCH}?recursive=1`);
  if (!res.ok) throw new Error(`GitHub ${res.status} ao listar`);
  const { tree } = (await res.json()) as { tree: { path: string; type: string }[] };
  return tree.filter((t) => t.type === "blob" && t.path.endsWith(".md") && t.path.startsWith(prefix)).map((t) => t.path);
}

async function readFile(path: string, ref = BRANCH): Promise<string | null> {
  const res = await gh(`/contents/${encPath(path)}?ref=${ref}`, {}, "application/vnd.github.raw+json");
  return res.ok ? res.text() : null;
}

// base64 de UTF-8 (btoa sozinho quebra com acento)
function b64(s: string) {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// sha atual do arquivo (o GitHub exige pra sobrescrever ou apagar); null se não existe
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
  if (!res.ok) throw new Error(`GitHub ${res.status} ao salvar: ${await res.text()}`);
}

async function deleteFile(path: string, message: string) {
  const sha = await fileSha(path);
  if (!sha) throw new Error(`Nota não encontrada: ${path}`);
  const res = await gh(`/contents/${encPath(path)}`, { method: "DELETE", body: JSON.stringify({ message, sha, branch: BRANCH }) });
  if (!res.ok) throw new Error(`GitHub ${res.status} ao apagar: ${await res.text()}`);
}

// caminho relativo à raiz do repo, só Markdown, sem sair da pasta
function checkPath(path: string) {
  const p = path.trim().replace(/^\/+/, "");
  if (!p.endsWith(".md") || p.split("/").some((seg) => seg === ".." || seg === "")) throw new Error(`Caminho inválido: ${path} (use algo como projetos/nome.md)`);
  return p;
}

// ---------- Índice ----------

async function embed(texts: string[]): Promise<number[][]> {
  const res = (await E.AI.run(EMBED_MODEL as any, { text: texts })) as any;
  return res.data;
}

// quebra por parágrafo, juntando até ~1200 caracteres por pedaço
function chunk(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of body.split(/\n\s*\n/)) {
    if (cur && cur.length + para.length > CHUNK_CHARS) {
      out.push(cur.trim());
      cur = "";
    }
    cur += para + "\n\n";
  }
  if (cur.trim()) out.push(cur.trim());
  return out.slice(0, MAX_CHUNKS);
}

// id estável e curto (o Vectorize aceita até 64 bytes): hash do caminho + número do pedaço
async function pathHash(path: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ids de pedaços a partir de `from`: o que sobrou de uma versão mais longa da nota
async function idsFrom(path: string, from: number) {
  const h = await pathHash(path);
  return Array.from({ length: MAX_CHUNKS - from }, (_, i) => `${h}-${from + i}`);
}

// indexa uma nota: upsert pelo mesmo id (rodar de novo não duplica) e apaga pedaços que sobraram
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

// ---------- Webhook do GitHub ----------

async function validSignature(body: string, header: string | null, secret: string) {
  if (!header?.startsWith("sha256=") || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = new Uint8Array(header.slice(7).match(/../g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(body));
}

type PushEvent = { ref: string; after: string; commits: { added: string[]; modified: string[]; removed: string[] }[] };

// junta os commits do push: o último estado de cada arquivo vence
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

// ---------- Ferramentas MCP ----------

function createServer() {
  const server = new McpServer({ name: "segundo-cerebro", version: "0.3.0" });

  server.registerTool(
    "list_notes",
    { description: "Lista as notas do segundo cérebro do Yudi (caminhos dos arquivos Markdown, ex.: ideias/..., projetos/..., decisoes/...).", inputSchema: { prefix: z.string().optional() } },
    async ({ prefix }) => text((await listKeys(prefix ?? "")).join("\n") || "Nenhuma nota."),
  );

  server.registerTool(
    "read_note",
    { description: "Lê uma nota inteira pelo caminho (ex.: visao-geral.md, projetos/cafezinho.md).", inputSchema: { path: z.string() } },
    async ({ path }) => text((await readFile(path)) ?? `Nota não encontrada: ${path}`),
  );

  server.registerTool(
    "search_notes",
    { description: "Busca por palavras exatas nas notas (ignora acento e maiúscula). Bom pra nomes, siglas e termos.", inputSchema: { query: z.string() } },
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
      return text(hits.slice(0, 40).join("\n") || "Nada encontrado.");
    },
  );

  server.registerTool(
    "semantic_search",
    { description: "Busca por sentido nas notas (embeddings + Vectorize). Bom pra perguntas como 'o que eu decidi sobre X'.", inputSchema: { query: z.string(), topK: z.number().int().min(1).max(10).optional() } },
    async ({ query, topK }) => {
      const [q] = await embed([query]);
      const res = await E.VECTORS.query(q, { topK: topK ?? 5, returnMetadata: "all" });
      const out = res.matches.map((m) => `[${m.score.toFixed(2)}] ${m.metadata?.path} (#${m.metadata?.seq})\n${m.metadata?.text}`);
      return text(out.join("\n\n---\n\n") || "Nada encontrado.");
    },
  );

  server.registerTool(
    "save_idea",
    { description: "Salva uma ideia nova em ideias/AAAA-MM-DD-slug.md (commit no GitHub) e indexa. O Mac puxa sozinho na próxima conversa.", inputSchema: { title: z.string(), content: z.string() } },
    async ({ title, content }) => {
      const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // AAAA-MM-DD no horário de Brasília
      const slug = norm(title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      const path = `ideias/${day}-${slug}.md`;
      const body = `# ${title}\n\n${content}\n`;
      await writeFile(path, body, `ideia: ${title} (via MCP)`);
      await indexNote(path, body); // o webhook reindexa também; aqui é pra já aparecer na busca
      return text(`Salvo em ${path}`);
    },
  );

  server.registerTool(
    "write_note",
    { description: "Cria ou sobrescreve uma nota inteira em qualquer pasta (ex.: projetos/cafezinho.md). Pra mudar só um trecho, prefira edit_note.", inputSchema: { path: z.string(), content: z.string() } },
    async ({ path, content }) => {
      const p = checkPath(path);
      const existed = (await fileSha(p)) !== null;
      await writeFile(p, content, `${existed ? "edita" : "cria"}: ${p} (via MCP)`);
      await indexNote(p, content);
      return text(`${existed ? "Atualizada" : "Criada"}: ${p}`);
    },
  );

  server.registerTool(
    "edit_note",
    { description: "Troca um trecho exato de uma nota por outro (old_text precisa aparecer uma vez só). new_text vazio apaga o trecho. Use read_note antes pra copiar o trecho exato.", inputSchema: { path: z.string(), old_text: z.string(), new_text: z.string() } },
    async ({ path, old_text, new_text }) => {
      const p = checkPath(path);
      const body = await readFile(p);
      if (body === null) return text(`Nota não encontrada: ${p}`);
      const n = body.split(old_text).length - 1;
      if (n !== 1) return text(n === 0 ? "Trecho não encontrado. Leia a nota e copie o trecho exato." : `O trecho aparece ${n} vezes; inclua mais contexto pra ficar único.`);
      const next = body.replace(old_text, () => new_text);
      await writeFile(p, next, `edita: ${p} (via MCP)`);
      await indexNote(p, next);
      return text(`Editada: ${p}`);
    },
  );

  server.registerTool(
    "delete_note",
    { description: "Apaga uma nota (fica recuperável no histórico do Git).", inputSchema: { path: z.string() } },
    async ({ path }) => {
      const p = checkPath(path);
      await deleteFile(p, `apaga: ${p} (via MCP)`);
      await unindexNote(p);
      return text(`Apagada: ${p}`);
    },
  );

  server.registerTool(
    "move_note",
    { description: "Move ou renomeia uma nota (ex.: ideias/x.md para projetos/x.md).", inputSchema: { from: z.string(), to: z.string() } },
    async ({ from, to }) => {
      const a = checkPath(from), b = checkPath(to);
      const body = await readFile(a);
      if (body === null) return text(`Nota não encontrada: ${a}`);
      if ((await fileSha(b)) !== null) return text(`Já existe uma nota em ${b}`);
      await writeFile(b, body, `move: ${a} -> ${b} (via MCP)`);
      await deleteFile(a, `move: ${a} -> ${b} (via MCP)`);
      await indexNote(b, body);
      await unindexNote(a);
      return text(`Movida: ${a} -> ${b}`);
    },
  );

  return server;
}

const mcp = createMcpHandler(createServer);

export default {
  async fetch(request: Request, envArg: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // URL secreta: /<token>/mcp. Sem o token, 404, como se nada existisse.
    const prefix = `/${envArg.MCP_TOKEN}`;
    if (!envArg.MCP_TOKEN || !url.pathname.startsWith(prefix + "/")) return new Response("Not found", { status: 404 });
    url.pathname = url.pathname.slice(prefix.length);

    // push no repositório: reindexa o que mudou e apaga do índice o que foi removido
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

    // reconstrói o índice inteiro a partir do GitHub (POST /<token>/reindex)
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
