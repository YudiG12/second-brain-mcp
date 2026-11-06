# Claude Code client: keeping the local notes in sync

Claude Code on the Mac reads and writes the notes as local files, in a clone of the notes repo. Three Claude Code hooks keep that clone in sync with the Artifacts repository ([ADR 007](../../docs/adr/007-cloudflare-artifacts-for-the-notes.md)), so ideas saved from the phone show up locally and local edits reach the index.

| Hook | When | Action |
|---|---|---|
| `SessionStart` | A session opens | `git pull --rebase --autostash` |
| `UserPromptSubmit` | Every message | Same pull, at most once every 10 minutes |
| `Stop` | After each answer (async) | Commit local changes; only if there is something to send: pull with rebase, push |

Git authenticates with a 1-hour write token from the Worker (`POST /admin/artifacts-token`), cached in the macOS Keychain. Until the Queue indexer lands (PR 4), a push from the Mac is not re-indexed automatically: run `POST /<MCP_TOKEN>/reindex`.

## Install

The script is macOS-only: it uses the Keychain (`security`) and BSD `stat -f`.

1. Store the Worker's admin secret in the Keychain: `scripts/secrets.sh admin` creates one and saves it to the Worker and the Keychain (service `second-brain-admin`).
2. Clone the notes repo. By default the script expects it at `~/dev/agentes/cerebro/notas`; set `NOTES_DIR` to use another path, for example in the `env` block of `~/.claude/settings.json`.
3. Link the script into Claude Code's hooks folder, so this repo stays the single source:
   ```sh
   mkdir -p ~/.claude/hooks
   ln -sf "$PWD/clients/claude-code/notes-sync.sh" ~/.claude/hooks/notes-sync.sh
   ```
4. Merge the `hooks` block from `settings.hooks.json` into `~/.claude/settings.json`.

Other clients (Claude on the phone or web, ChatGPT) need no install: they connect to the MCP URL directly.
