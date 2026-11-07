# Performance

Measured in production with [`scripts/measure.py`](../../scripts/measure.py), from the Mac (network included), 10 runs each, p50 (median). With ten samples the percentiles are indicative.

| | v1 | v2 |
|---|---|---|
| Write a note | 4.1 s | 2.1 s |
| New note findable by keyword | immediate (reads every note) | ~12 s |
| New note findable by meaning | 122 s | 53 s |
| `search_notes` | 2.8 s, reads every note | 1.5 s, reads none |

Two things changed at once for writes (a push through the Durable Object instead of the GitHub API, and indexing enqueued instead of inline), so the speedup isn't attributed between them. Method, p90, max and caveats: [spec v2 §10](../spec/v2.md). Raw samples: the JSON files in this folder.
