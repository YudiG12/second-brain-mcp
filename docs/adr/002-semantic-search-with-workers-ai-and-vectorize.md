# ADR 002: Semantic search with Workers AI (bge-m3) and Vectorize, alongside keyword search

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-05 |
| **Deciders** | Yudi Ganeko |

## Context

Before v1, the notes could only be searched with `grep`. That finds names and acronyms, but not answers to open questions such as "what did I decide about the interview project?", where the note may use different words. The notes are written in Portuguese, and the system runs on Cloudflare.

## Decision

Add semantic search and keep keyword search, as two separate tools:

- **`semantic_search`:** notes are split into chunks of about 1,200 characters, embedded with **bge-m3** on **Workers AI** (1024-dimension vectors), and stored in a **Vectorize** index with cosine similarity. A query is embedded the same way and returns the closest chunks.
- **`search_notes`:** exact keyword search over the notes in GitHub, ignoring accents and case.

The two cover each other's blind spots. Semantic search finds paraphrases and synonyms but blurs exact tokens such as names, acronyms and codes. Keyword search is precise for exact terms but misses anything worded differently.

**Why bge-m3:** it is multilingual, which matters because the notes are in Portuguese; it accepts long inputs; and it runs on Workers AI, so there is no external API key and the notes don't leave the Cloudflare account. The 1024 dimensions are not a separate choice: they are the model's output size.

**Why Vectorize:** it is managed and lives in the same stack, accessed through a binding. It scales without code changes (approximate nearest-neighbor search) and supports metadata filtering, which is the basis for per-document permissions if the system ever has more than one user.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Keyword search only** | Doesn't answer open questions or find paraphrases. |
| **Semantic search only** | Weak on exact names, acronyms and codes. |
| **English-only embedding models** (bge-base-en, 768 dimensions; bge-small-en, 384) | Much worse at understanding Portuguese text. |
| **External embeddings** (e.g. OpenAI text-embedding-3-small) | Another API key, notes leaving the account, separate billing. |
| **Pinecone** | Another vendor and key outside the stack. |
| **pgvector** | Needs a Postgres database to run and operate. |
| **In-memory scan over a persisted file** (vectors stored as JSON in R2 or KV, compared in the Worker on each query) | Would work at this size (about 60 vectors, ~250 KB). Not chosen because it doesn't scale and has no metadata filtering; see "Consequences". |

## Consequences

**Gained**
- Open questions get answers, with the note path for each passage.
- Room to grow: more notes or more sources need no change in the search code.

**Costs**
- **More than this volume needs.** At about 60 vectors, an in-memory scan would be enough. Vectorize was chosen for growth and to learn the stack, at the cost of one more component to run.
- **Changing the model is expensive.** The index dimension is fixed at creation, so a new model means a new index and re-embedding every note. This is only possible because the full text lives in GitHub ([ADR 001](001-github-as-source-of-truth.md)).
- **Eventual consistency.** Vectorize applies writes asynchronously (median under 30 seconds, p99 under 2 minutes, per Cloudflare), so a change takes a while to show up in semantic search.
- **Lock-in.** The Workers AI and Vectorize bindings are Cloudflare-specific; moving to pgvector or another provider means rewriting the indexing layer.
- **Two search paths.** Keyword search fetches every note from GitHub on each call, which doesn't scale ([#13](https://github.com/YudiG12/second-brain-mcp/issues/13)).

## Revisit when

- **The volume is high and constant.** Pay-per-call serverless inference is cheap for occasional use; with heavy, steady traffic, a self-hosted embedding model could cost less.
- **The system never grows and learning the stack stops mattering:** an in-memory scan over a file would be simpler.
- **Search quality isn't good enough:** try a stronger embedding model, or hybrid search with reranking ([#13](https://github.com/YudiG12/second-brain-mcp/issues/13)).

## Related

- [ADR 001: GitHub as the source of truth](001-github-as-source-of-truth.md)
- [Spec v1](../spec/v1.md), sections 3, 4 and 5.4
