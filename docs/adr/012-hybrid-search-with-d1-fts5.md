# ADR 012: Hybrid search with a D1 FTS5 keyword index

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |

## Context

v1 has two search tools. `semantic_search` uses Vectorize ([ADR 002](002-semantic-search-with-workers-ai-and-vectorize.md)). `search_notes` reads every note from GitHub on each call and matches substrings line by line: one request per note per search, so latency and cost grow with the notes (on the Free plan it even hit the 50-subrequest limit at about 49 notes) ([#13](https://github.com/YudiG12/second-brain-mcp/issues/13)).

The two kinds of search find different things:
- **Keyword** finds exact terms that embeddings blur: a person's name ("Lorenzo"), a product, an error code.
- **Semantic** finds the idea when the word isn't there: "money" finds a note about choosing a bank.

The AI client doesn't know in advance which one will work for a query.

## Decision

- **A keyword index in D1**, as an FTS5 table with one row per chunk (`chunks_fts`), using the same chunks as Vectorize. The tokenizer ignores case and accents. The Queue consumer writes it together with the vectors, so it follows the same single-writer and post-write-check rules ([ADR 009](009-queue-for-indexing-workflow-for-reconciliation.md), [ADR 010](010-index-manifest-in-d1.md)).
- **Terms are combined with OR.** AI clients send sentences ("what did I decide about Railblocks"); with AND, every word would have to be in one chunk and the keyword list would usually be empty. With OR, BM25 already ranks chunks that match more and rarer terms higher. To keep OR from matching everything, stopwords (Portuguese and English) and terms shorter than 3 characters are dropped.
- **Each term is a quoted prefix** (`"rail"*`): inner `"` are doubled and empty terms dropped, so user input can't break the FTS5 syntax, and a word prefix still matches. The table declares `prefix='3'` to keep prefix queries fast.
- **`search_notes` becomes hybrid:** it runs the FTS5 query (BM25) and the Vectorize query in parallel, top 50 chunks each. Semantic results below a similarity floor (starting at 0.45, tuned during the build) are dropped, so a query with no real match can return nothing. The two lists are fused with **reciprocal rank fusion**: each chunk scores `Σ 1 / (60 + rank)` over the lists it appears in. Fusion uses positions, not scores, because BM25 and cosine similarity are on different scales. A note's score is its **best chunk's** score (not the sum, which would favor long notes), and each result says how it was found: `keyword`, `semantic` or `both`.
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
- **A second derived index** to keep in sync, written by the same consumer. The daily reconciliation compares its paths with the source too.
- **Backups:** `wrangler d1 export` has historically refused databases with virtual tables (verify on D1), which would block exporting the manifest and alerts too. D1 Time Travel covers the whole database, and `chunks_fts` can always be rebuilt.
- **Word matching instead of substrings:** `rail` finds `Railblocks` by prefix, but a match in the middle of a word (`blocks` in `Railblocks`) is no longer found. The trigram tokenizer would allow it at the cost of a larger index.
- **The output of `search_notes` changes** from v1's `path:line: text` lines to ranked chunks.
- **Rank fusion ignores how strong a match is,** only its position: a chunk at rank 20 in both lists (2/80) beats rank 1 in one list (1/61), and an exact name hit can tie with a loose semantic neighbor. The `both/keyword/semantic` label and the similarity floor limit the damage.
- **Stopwords and the 3-character minimum** mean very short terms ("IA", "C6") aren't searched by keyword; semantic search still covers them.

## Revisit when

- Search quality complaints point at ranking: tune k (60) or weight one list.
- Substring matches are missed in practice: switch to the trigram tokenizer (needs terms of 3+ characters, and accent folding with it needs SQLite 3.45 or later; verify D1's version).
- Notes grow past what D1 FTS5 serves fast.

## Related

- [ADR 002: Semantic search with Workers AI and Vectorize](002-semantic-search-with-workers-ai-and-vectorize.md)
- [ADR 010: The index manifest in D1](010-index-manifest-in-d1.md)
- [Spec v2](../spec/v2.md), §4.4 and §5.5
- Issue [#13](https://github.com/YudiG12/second-brain-mcp/issues/13)
