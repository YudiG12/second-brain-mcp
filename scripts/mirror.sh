#!/usr/bin/env bash
# Keeps a read-only copy of your notes in a folder, for viewing (for example Obsidian's graph view).
# Usage: npm run mirror [-- folder]   (default ~/notes). Safe to run again; run it on a schedule (launchd, cron).
# Never edit or commit in that folder: each run resets it to the repo and drops local changes.
# Every write goes through the MCP tools (ADR 014).
# Needs the hook secret: scripts/secrets.sh hook (macOS Keychain, service "second-brain-hook"), or HOOK_SECRET.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=${1:-$HOME/notes}; DIR=${DIR/#\~/$HOME}
URL=$(node scripts/config.mjs PUBLIC_URL)
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }

SECRET=${HOOK_SECRET:-$(security find-generic-password -s second-brain-hook -w 2>/dev/null || true)}
[ -n "$SECRET" ] || { echo "No hook secret: run scripts/secrets.sh hook, or set HOOK_SECRET."; exit 1; }

# a short-lived token for this one repo; the secret goes through stdin, never the command line
RES=$(printf 'header = "Authorization: Bearer %s"\n' "$SECRET" | curl -fsS -m 15 --config - -X POST "$URL/hook/artifacts-token")
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $(printf '%s' "$RES" | json token)"

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin main
  git -C "$DIR" reset -q --hard origin/main
else
  git clone -q --branch main "$(printf '%s' "$RES" | json remote)" "$DIR"
fi
echo "ok: $DIR at $(git -C "$DIR" rev-parse --short HEAD)"
