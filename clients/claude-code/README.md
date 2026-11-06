# Claude Code client: keeping the local notes in sync

Claude Code on the Mac reads and writes the notes as local files, in a clone of the notes repo. Three Claude Code hooks keep that clone in sync with GitHub, so ideas saved from the phone show up locally and local edits reach the index.

| Hook | When | Action |
|---|---|---|
| `SessionStart` | A session opens | `git pull --rebase --autostash` |
| `UserPromptSubmit` | Every message | Same pull, at most once a minute |
| `Stop` | After each answer (async) | Commit local changes, pull with rebase, push |

Every push triggers the GitHub webhook, which re-indexes the changed notes.

## Install

The script is written for macOS (it uses `stat -f`).


1. Clone the notes repo. By default the script expects it at `~/dev/agentes/cerebro/notas`; set `NOTES_DIR` in the environment Claude Code runs hooks with to use another path.
2. Link the script into Claude Code's hooks folder, so this repo stays the single source:
   ```sh
   mkdir -p ~/.claude/hooks
   ln -sf "$PWD/clients/claude-code/notes-sync.sh" ~/.claude/hooks/notes-sync.sh
   ```
3. Merge the `hooks` block from `settings.hooks.json` into `~/.claude/settings.json`.

Other clients (Claude on the phone or web, ChatGPT) need no install: they connect to the MCP URL directly.
