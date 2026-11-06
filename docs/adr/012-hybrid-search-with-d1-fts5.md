# ADR 012: Hybrid search with a D1 FTS5 keyword index

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |

## Context

v1 has two search tools. `semantic_search` uses Vectorize ([ADR 002](002-semantic-search-with-workers-ai-and-vectorize.md)). `search_notes` reads every note from storage on each call and matches substrings line by line: one read per note, which hit the Free plan's subrequest limit at about 49 notes and gets slower as the notes grow ([#13](https://github.com/YudiG12/second-brain-mcp/issues/13)).

The two kinds of search find different things:
- **Keyword** finds exact terms that embeddings blur: a person's name ("Lorenzo"), a product, an error code.
- **Semantic** finds the idea when the word isn't there: "money" finds a note about choosing a bank.

The AI client doesn't know in advance which one will work for a query.

## Decision

- **A keyword index in D1**, as an FTS5 table with one row per chunk (`chunks_fts`), using the same chunks as Vectorize. The tokenizer ignores case and accents. The Queue consumer writes it together with the vectors, so it follows the same single-writer and post-write-check rules ([ADR 009](009-queue-for-indexing-workflow-for-reconciliation.md), [ADR 010](010-index-manifest-in-d1.md)).
- **`search_notes` becomes hybrid:** it runs the FTS5 query (ranked by BM25) and the Vectorize query in parallel, top 20 each, and fuses them with **reciprocal rank fusion**: each chunk scores `Σ 1 / (60 + rank)` over the lists it appears in, and results are grouped by note. Fusion uses positions, not scores, because BM25 and cosine similarity are on different scales; a note found by both rises to the top.
- **Query terms are quoted prefixes** (`"rail"*`), so user input can't break the FTS5 syntax and a word prefix still matches.
- **`semantic_search` stays** as the pure semantic tool, for clients that already use it.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Keep reading every note per query** | Cost and latency grow with the number of notes; one read per note per search. |
| **Two separate tools, let the AI choose** | The AI can't tell which will work; it would often call both and merge them itself, inconsistently. |
| **Semantic only** | Misses exact names and terms, the most common keyword need. |
| **Weighted sum of normalized scores** | Needs tuning and normalization of two unrelated scales; rank fusion works without tuning. |
| **A dedicated search service** (e.g. a hosted search engine) | One more vendor and sync path for a few hundred notes; D1 is already in the stack ([ADR 010](010-index-manifest-in-d1.md)). |
| **Vectorize metadata filtering for keywords** | Filters on exact metadata values, not full text. |

## Consequences

**Gained**
- Search no longer reads the notes; cost stays flat as they grow.
- One ranked list that catches both exact terms and related ideas.

**Costs**
- **A second derived index** to keep in sync, covered by the same consumer and reconciliation.
- **Word matching instead of substrings:** `rail` finds `Railblocks` by prefix, but a match in the middle of a word (`blocks` in `Railblocks`) is no longer found. The trigram tokenizer would allow it at the cost of a larger index.
- **The output of `search_notes` changes** from v1's `path:line: text` lines to ranked chunks.
- **Rank fusion ignores how strong a match is,** only its position; a weak result can rank high when the other list is empty.

## Revisit when

- Search quality complaints point at ranking: tune k (60) or weight one list.
- Substring matches are missed in practice: switch to the trigram tokenizer.
- Notes grow past what D1 FTS5 serves fast.

## Related

- [ADR 002: Semantic search with Workers AI and Vectorize](002-semantic-search-with-workers-ai-and-vectorize.md)
- [ADR 010: The index manifest in D1](010-index-manifest-in-d1.md)
- [Spec v2](../spec/v2.md), §4.4 and §5.5
- Issue [#13](https://github.com/YudiG12/second-brain-mcp/issues/13)
