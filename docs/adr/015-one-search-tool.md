# ADR 015: One search tool

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-10 |
| **Deciders** | Yudi Ganeko |
| **Amends** | [ADR 012](012-hybrid-search-with-d1-fts5.md) (which kept `semantic_search`) |

## Context

Since v2 there are two search tools. `search_notes` runs keyword (D1 FTS5, BM25) and semantic (Vectorize) search in parallel and fuses them by reciprocal rank. `semantic_search` runs only the semantic half, the v1 tool kept for old clients.

So `semantic_search` is half of `search_notes`, and a worse half: it has no similarity floor, so it always returns `topK` chunks, related or not. An agent that sees both has to pick one, and a wrong pick on a name or an acronym (which the semantic half handles poorly) misses the note. No client depends on it; every client is ours ([ADR 014](014-mcp-only-clients.md)).

## Decision

Remove `semantic_search`. Reading has two paths:

1. **The agent knows the note:** `read_note` (with `list_notes` first if it needs the path).
2. **It doesn't:** `search_notes`, which returns each note's best chunk. If the chunk answers, done; if not, `read_note` on the returned path.

## Consequences

- One search tool: no choice for the agent to get wrong, and one floor and one output format.
- A purely semantic query is no longer possible. `search_notes` still says per result whether it matched by `keyword`, `semantic` or `both`.
- `scripts/measure.py` detects "searchable by meaning" with `search_notes` returning the note as `semantic` or `both`.
- Still missing: an exhaustive search. `search_notes` ranks and cuts (at most 20 notes), so it can't list *every* note that mentions a term. That would be a separate, unranked tool.
