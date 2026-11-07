// Hybrid search (ADR 012, spec v2 §5.5): keyword (D1 FTS5) and semantic (Vectorize) results
// fused by rank. Pure functions here; the tool wires the two queries.
import { norm } from "../lib/notes";

export type Hit = { path: string; seq: number; text: string };
export type Fused = { path: string; text: string; matched: "keyword" | "semantic" | "both"; score: number };

const RRF_K = 60;
const MIN_TERM = 3;

// Words too common to help a keyword search (the notes are mostly Portuguese, some English).
const STOPWORDS = new Set(
  (
    "que para com uma uns umas por pelo pela pelos pelas dos das nos nas num numa como mais mas foi sao ser tem ter era sua seu suas seus isso isto esse essa este esta ele ela eles elas voce voces nao sim sobre entre quando onde qual quais porque muito muita tambem ainda aqui ali meu minha meus minhas" +
    " the and for are was were with that this these those what which who whom whose why how about from into onto than then them they their there here have has had did does doing done not but you your yours our ours its it's can could would should will shall may might must also just only very"
  ).split(" "),
);

/** Turns free text into a safe FTS5 query, or null if nothing is left to search for. */
export function buildFtsQuery(query: string): string | null {
  const terms = norm(query)
    .split(/[^a-z0-9]+/) // anything else (quotes, operators, colons, parentheses) separates words
    .filter((t) => t.length >= MIN_TERM && !STOPWORDS.has(t));
  const unique = [...new Set(terms)];
  return unique.length ? unique.map((t) => `"${t}"*`).join(" OR ") : null;
}

/** Reciprocal rank fusion: Σ 1/(60 + rank) per chunk; a note scores its best chunk. */
export function fuse(keyword: Hit[], semantic: Hit[], limit: number): Fused[] {
  const chunks = new Map<string, { hit: Hit; score: number; inKeyword: boolean; inSemantic: boolean }>();
  const add = (list: Hit[], which: "inKeyword" | "inSemantic") =>
    list.forEach((hit, i) => {
      const key = `${hit.path}#${hit.seq}`;
      const c = chunks.get(key) ?? { hit, score: 0, inKeyword: false, inSemantic: false };
      c.score += 1 / (RRF_K + i + 1);
      c[which] = true;
      chunks.set(key, c);
    });
  add(keyword, "inKeyword");
  add(semantic, "inSemantic");

  const notes = new Map<string, { best: typeof chunks extends Map<string, infer V> ? V : never; keyword: boolean; semantic: boolean }>();
  for (const c of chunks.values()) {
    const n = notes.get(c.hit.path);
    if (!n) notes.set(c.hit.path, { best: c, keyword: c.inKeyword, semantic: c.inSemantic });
    else {
      if (c.score > n.best.score) n.best = c;
      n.keyword ||= c.inKeyword;
      n.semantic ||= c.inSemantic;
    }
  }
  return [...notes.entries()]
    .map(([path, n]) => ({ path, text: n.best.hit.text, score: n.best.score, matched: (n.keyword && n.semantic ? "both" : n.keyword ? "keyword" : "semantic") as Fused["matched"] }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}
