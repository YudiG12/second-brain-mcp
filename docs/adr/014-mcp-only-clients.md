# ADR 014: Every client reads and writes only through MCP

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Deciders** | Yudi Ganeko |
| **Supersedes** | [ADR 003](003-sync-with-claude-code-hooks-and-a-push-webhook.md) (the Mac sync hook) |

## Context

Until now, Claude Code on the Mac had two paths to the notes. It used the MCP tools like any other client, and it also kept a local Git clone, synced by a hook ([ADR 003](003-sync-with-claude-code-hooks-and-a-push-webhook.md), [ADR 007](007-cloudflare-artifacts-for-the-notes.md)). The hook pulled on `SessionStart` and `UserPromptSubmit`, pushed on `Stop`, merged, and wrote a `.conflict` copy when both sides changed a note.

- **Two writers.** Every MCP write goes through one Durable Object per repository ([ADR 008](008-one-durable-object-per-repository.md)), and an overwrite needs the version the agent read ([ADR 013](013-version-check-on-overwrite.md)). A push from the clone happened outside that lock and without that check. A conflict became a `.conflict` file someone had to find and resolve.
- **A stale read cache.** Used only for reading, the clone was a cache that needed invalidation. The pull ran at most once every 10 minutes to stay within the Artifacts operations budget, so a note saved from the phone could be missing on the Mac for that long.
- **Not needed.** Offline editing and local `grep` were the reasons to keep a clone. Neither was used: the agents search through MCP.
- **Moving parts.** A hook script, a settings merger, a Keychain secret, a merge strategy, conflict copies, and 48 shell tests to keep them right.

## Decision

- **Every client, Claude Code on the Mac included, reads and writes only through the MCP tools.** The Durable Object is the only writer of the notes.
- Remove the sync hook: `clients/claude-code/`, `scripts/mac-hook.sh`, `scripts/merge-hooks.mjs` and their tests.
- **Optional read-only mirror** for viewing, for example Obsidian's graph view: `scripts/mirror.sh` asks the existing `POST /hook/artifacts-token` route for a short-lived token (Bearer `HOOK_SECRET`, kept in the macOS Keychain), then runs `git fetch` and `git reset --hard origin/main` in a folder. It never edits, commits or pushes; a local change is dropped on the next run. Run it on a schedule (launchd or cron).

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep the clone as a read-only cache, and pull more often | Still stale between pulls, and each pull costs Artifacts operations. Cache invalidation for no gain: MCP reads are already fresh. |
| Keep the read-write clone | A second writer outside the lock and the version check. Conflicts end as `.conflict` copies instead of a clear error the agent can act on. |
| A `SessionStart` hook that injects notes into the context | Not needed: the agent searches and reads what it needs through MCP. It would add a hook back for no clear gain. |

## Consequences

- One write path. The version check of [ADR 013](013-version-check-on-overwrite.md) covers every write; no more conflict copies.
- Reads are always current: no pull interval, no stale cache.
- No offline access and no local `grep`. Without network, the notes are out of reach (the mirror can still be viewed).
- Fewer moving parts: no hook, no settings merge, no shell tests for sync. `HOOK_SECRET` and the token route stay, only for the mirror.
- The writer still re-runs an operation when a push lands first ([ADR 008](008-one-durable-object-per-repository.md)). It costs nothing and covers a manual push.

## Related

- [ADR 003](003-sync-with-claude-code-hooks-and-a-push-webhook.md) (superseded), [ADR 007](007-cloudflare-artifacts-for-the-notes.md), [ADR 008](008-one-durable-object-per-repository.md), [ADR 013](013-version-check-on-overwrite.md)
