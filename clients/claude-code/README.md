# Claude Code client: keeping the local notes in sync

Claude Code on the Mac reads and writes the notes as local files, in a clone of the notes repo. Three Claude Code hooks keep that clone in sync with the Artifacts repository ([ADR 007](../../docs/adr/007-cloudflare-artifacts-for-the-notes.md)), so ideas saved from the phone show up locally and local edits reach the index.

| Hook | When | Action |
|---|---|---|
| `SessionStart` | A session opens | Bring in the remote (fast-forward or merge) |
| `UserPromptSubmit` | Every message | Same, at most once every 10 minutes |
| `Stop` | After each answer (async) | Commit local changes; only if there is something to send: bring in the remote, then push |

Git authenticates with a 1-hour write token from the Worker (`POST /hook/artifacts-token`), cached in the macOS Keychain. That route takes the hook secret, which can do nothing else.

Only one sync runs at a time per clone (a lock in `.git/notes-sync.lock`; a second session waits up to 10 s, then skips visibly). Local commits are never rewritten: the remote comes in by fast-forward or merge. If both sides changed the same note, the remote version stays at its path and the local one is saved and pushed as `<name>.conflict-<time>.md` next to it; an interrupted sync is finished by the next run. Failures are logged to `~/.claude/notes-sync.log` and exit 1, so Claude Code shows them. Tests: `bash test/hook/run.sh`.

Every push, from the Mac or from the MCP, emits an Artifacts `pushed` event into the `index-jobs` queue, which re-indexes the changed notes ([ADR 009](../../docs/adr/009-queue-for-indexing-workflow-for-reconciliation.md)).

## Install

The script is macOS-only: it uses the Keychain (`security`) and BSD `stat -f`.

1. Store the hook secret in the Keychain: `scripts/secrets.sh hook` creates one and saves it to the Worker and the Keychain (service `second-brain-hook`).
2. Clone the notes repo anywhere.
3. Tell the hook where things are, in `~/.config/second-brain/hook.env` (plain `KEY=value` lines; the file is read as text, never run) or in the environment, which wins:
   ```sh
   mkdir -p ~/.config/second-brain
   cat > ~/.config/second-brain/hook.env <<'EOF'
   NOTES_DIR=~/notes
   SECOND_BRAIN_URL=https://<worker>.<your-subdomain>.workers.dev
   EOF
   ```
   Without `NOTES_DIR` the hook stops with an error and touches nothing; `SECOND_BRAIN_URL` is needed as soon as it has to fetch a token.
4. Link the script into Claude Code's hooks folder, so this repo stays the single source:
   ```sh
   mkdir -p ~/.claude/hooks
   ln -sf "$PWD/clients/claude-code/notes-sync.sh" ~/.claude/hooks/notes-sync.sh
   ```
5. Merge the `hooks` block from `settings.hooks.json` into `~/.claude/settings.json`.

Other clients (Claude on the phone or web, ChatGPT) need no install: they connect to the MCP URL directly.
