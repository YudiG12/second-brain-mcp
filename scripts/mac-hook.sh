#!/usr/bin/env bash
# Installs the Claude Code sync hook on this Mac: a local Git clone of your notes, kept in sync.
# Usage: npm run mac-hook   (after npm run deploy-your-own). Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname)" = Darwin ] || { echo "The sync hook is macOS-only (it uses the Keychain)."; exit 1; }

wr() { npx --no-install wrangler "$@"; }
cfg() { node scripts/config.mjs "$@"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=new Function("j","return "+process.argv[1])(JSON.parse(s));console.log(v??"")})' "$1"; }
ok() { printf '  ✓ %s\n' "$*"; }
ask() { local a; read -r -p "  $1${2:+ [$2]}: " a </dev/tty; printf '%s' "${a:-${2:-}}"; }

URL=$(cfg PUBLIC_URL)
DIR=$(ask "Where to keep the notes clone" "~/notes"); DIR=${DIR/#\~/$HOME}

security find-generic-password -s second-brain-hook -w >/dev/null 2>&1 || bash scripts/secrets.sh hook >/dev/null
ok "hook secret in the Keychain"

if [ ! -d "$DIR/.git" ]; then
  REMOTE=$(wr artifacts repos get "$(cfg NOTES_REPO)" --namespace "$(cfg namespace)" --json | json '(j.result||j).remote')
  TOKEN=$(wr artifacts repos issue-token "$(cfg NOTES_REPO)" --namespace "$(cfg namespace)" --scope write --ttl 600 --json | json j.plaintext)
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $TOKEN" git clone -q "$REMOTE" "$DIR"
fi
ok "notes clone at $DIR"

mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/second-brain" ~/.claude/hooks
printf 'NOTES_DIR=%s\nSECOND_BRAIN_URL=%s\n' "$DIR" "$URL" > "${XDG_CONFIG_HOME:-$HOME/.config}/second-brain/hook.env"
ln -sf "$PWD/clients/claude-code/notes-sync.sh" ~/.claude/hooks/notes-sync.sh
ok "hook linked, configured for $URL"

# adds the three hooks to ~/.claude/settings.json unless they're there (keeps everything else)
node -e '
const fs = require("fs"), p = process.env.HOME + "/.claude/settings.json";
const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
const add = JSON.parse(fs.readFileSync("clients/claude-code/settings.hooks.json", "utf8")).hooks;
s.hooks ??= {};
for (const [ev, list] of Object.entries(add)) {
  s.hooks[ev] ??= [];
  if (!JSON.stringify(s.hooks[ev]).includes("notes-sync.sh")) s.hooks[ev].push(...list);
}
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");'
ok "hooks in ~/.claude/settings.json"
bash ~/.claude/hooks/notes-sync.sh pull && ok "first sync done"
