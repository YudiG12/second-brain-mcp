// Hybrid search (ADR 012, spec v2 §5.5): keyword (D1 FTS5) and semantic (Vectorize) results
// fused by rank. Pure functions here; the tool wires the two queries.

export type Hit = { path: string; seq: number; text: string };
export type Fused = { path: string; text: string; matched: "keyword" | "semantic" | "both"; score: number };

/** Turns free text into a safe FTS5 query, or null if nothing is left to search for. */
export function buildFtsQuery(_query: string): string | null {
  throw new Error("not implemented");
}

/** Reciprocal rank fusion: Σ 1/(60 + rank) per chunk; a note scores its best chunk. */
export function fuse(_keyword: Hit[], _semantic: Hit[], _limit: number): Fused[] {
  throw new Error("not implemented");
}
