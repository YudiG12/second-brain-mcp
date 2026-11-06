// Pure helpers for notes: paths, chunking, ids. No bindings, so they are unit-tested directly.

export const CHUNK_CHARS = 1200;
export const MAX_CHUNKS = 50; // max chunks per note, also used to delete leftovers

// strips accents and case, so "decisão" matches "decisao"
export const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// Path rules for every read and write (spec v2 §3): relative to the repo root, Markdown only,
// at most 512 bytes, never outside the repo.
export function checkPath(path: string) {
  const p = path.trim();
  const bad =
    !p.endsWith(".md") ||
    p.startsWith("/") ||
    new TextEncoder().encode(p).length > 512 ||
    /[\\\u0000-\u001f\u007f]/.test(p) ||
    p.split("/").some((seg) => seg === ".." || seg === "." || seg === "");
  if (bad) throw new Error(`Invalid path: ${path} (use something like projetos/name.md)`);
  return p;
}

// splits by paragraph, packing up to ~1200 characters per chunk
export function chunk(body: string): string[] {
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

// short, stable id (Vectorize accepts up to 64 bytes): path hash + chunk number
export async function pathHash(path: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// chunk ids from `from` onward: leftovers from a longer version of the note
export async function idsFrom(path: string, from: number) {
  const h = await pathHash(path);
  return Array.from({ length: MAX_CHUNKS - from }, (_, i) => `${h}-${from + i}`);
}

// ideias/YYYY-MM-DD-<slug>.md, date in Brasília time. A title with no ASCII letters or digits
// gets the first 8 hex characters of its SHA-256 instead of an empty slug (#31).
export async function ideaPath(title: string, now: Date = new Date()) {
  const day = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  let slug = norm(title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60).replace(/-$/, "");
  if (!slug) {
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(title));
    slug = [...new Uint8Array(h)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `ideias/${day}-${slug}.md`;
}

// note.md -> note-2.md, note-3.md... (n = 1 keeps the path)
export function withSuffix(path: string, n: number) {
  return n === 1 ? path : path.replace(/\.md$/, `-${n}.md`);
}
