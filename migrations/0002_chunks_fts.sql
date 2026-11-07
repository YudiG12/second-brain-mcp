-- Keyword index (ADR 012): one row per chunk, the same chunks as Vectorize. Written only by the
-- Queue consumer. Ignores case and accents; prefix index for 3-character prefix queries.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  path UNINDEXED,
  seq UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '3'
);
