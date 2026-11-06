# ADR 001: GitHub as the source of truth for the notes

| | |
|---|---|
| **Status** | Superseded by [ADR 007](007-cloudflare-artifacts-for-the-notes.md) in v2 |
| **Date** | 2026-11-05 |
| **Deciders** | Yudi Ganeko |

## Context

The first version stored the notes in Cloudflare R2. A script on the Mac, `sync.sh`, uploaded the notes that had changed and asked the Worker to re-index them. Three problems showed up on the first day:

1. **Deleted notes stayed in the search index.** `sync.sh` uploaded changed files but never told the Worker which ones had been deleted, so their vectors stayed in Vectorize.
2. **Sync depended on remembering to run it.** It was a manual script, and ideas saved from the phone stayed in R2 and never came back to the Mac.
3. **No history.** Overwriting or deleting a note in R2 could not be undone.

## Decision

Store the notes in a private GitHub repository and treat it as the source of truth. The Worker reads and commits through the GitHub API. A push webhook tells the Worker which notes were added, modified or removed, and the Mac keeps a clone synced by Claude Code hooks.

Vectorize stays a derived index that can be rebuilt from the repository at any time.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Keep R2 and fix the sync:** send the list of deleted files, run the script automatically, add version tracking | It would mean rebuilding in a script what Git already does natively: history, diffs and the list of removed files. More code to maintain, more places to get wrong. |
| **R2 event notifications to a Queue** (object created/deleted events) | Would have fixed problem 1, since deletions fire an event. It would not have given history or a way for the Mac and the phone to sync in both directions. |
| **Store the notes only in Vectorize metadata** | Metadata has a size limit and no history, and the index could no longer be rebuilt from anywhere. |

## Consequences

**Gained**
- Full history: every change is a commit and can be undone.
- Deletions reach the index: the push event lists removed files.
- Two-way sync without a manual step: the Mac pulls and pushes through hooks; the MCP tools commit directly.

**Costs**
- **An external dependency.** The Worker needs a GitHub token (fine-grained, one repo, Contents read/write, expires in a year), managed with `set-token.sh`.
- **Rate limits:** the GitHub API allows 5,000 requests per hour. R2, accessed through a binding, has no comparable per-hour API quota.
- **Availability:** if GitHub is down, writes fail.
- **Latency:** every read is an HTTP call outside Cloudflare instead of a binding.
- **A public endpoint:** the webhook must verify GitHub's HMAC signature.

## Revisit when

- **The notes move to Cloudflare Artifacts (planned for v2).** Artifacts is Git inside Cloudflare: it keeps history, diffs and deletions while removing the token, the rate limit and the external call. That would replace this decision.
- Security requirements tighten to the point where notes must not leave the Cloudflare account.

## Related

- [PRD v1](../prd/v1.md)
- [Spec v1](../spec/v1.md), sections 1, 5.2 and 7
