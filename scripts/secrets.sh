#!/usr/bin/env bash
# Sets the Worker's secrets without printing them or putting them on a command line.
#   scripts/secrets.sh github          reads a GitHub token from the clipboard, checks it, saves it, clears the clipboard
#   scripts/secrets.sh rotate [--yes]  new MCP_TOKEN and WEBHOOK_SECRET: saved to .dev.vars first, then to the Worker,
#                                      then the webhook. Every client is cut off until it reconnects.
#   scripts/secrets.sh webhook         points the GitHub webhook at the URL and secret in .dev.vars (safe to retry)
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

NOTES_REPO="YudiG12/segundo-cerebro"
WORKER_URL="https://second-brain-mcp.yudiganeko.workers.dev"

# value goes through stdin, never argv
put() { printf '%s' "$2" | npx --no-install wrangler secret put "$1" >/dev/null && echo "ok: $1"; }

# sets KEY=value in .dev.vars, keeping other keys
setvar() {
  touch .dev.vars
  KEY="$1" VAL="$2" python3 - <<'PY'
import os
k, v = os.environ["KEY"], os.environ["VAL"]
lines = [l for l in open(".dev.vars").read().splitlines() if l and not l.startswith(k + "=")]
open(".dev.vars", "w").write("\n".join(lines + [f"{k}={v}"]) + "\n")
PY
}
getvar() { grep "^$1=" .dev.vars | cut -d= -f2-; }

webhook() {
  local token secret hook body
  token=$(getvar MCP_TOKEN); secret=$(getvar WEBHOOK_SECRET)
  [ -n "$token" ] && [ -n "$secret" ] || { echo "MCP_TOKEN or WEBHOOK_SECRET missing in .dev.vars"; exit 1; }
  body=$(URL="$WORKER_URL/$token/github-webhook" SECRET="$secret" python3 -c 'import json,os;print(json.dumps({"config":{"url":os.environ["URL"],"content_type":"json","secret":os.environ["SECRET"]},"events":["push"],"active":True}))')
  if ! hook=$(gh api "repos/$NOTES_REPO/hooks" --jq '.[] | select(.config.url | test("github-webhook")) | .id' | head -1) \
    || ! if [ -n "$hook" ]; then printf '%s' "$body" | gh api -X PATCH "repos/$NOTES_REPO/hooks/$hook" --input - >/dev/null
         else printf '%s' "$body" | gh api -X POST "repos/$NOTES_REPO/hooks" --input - >/dev/null; fi; then
    echo "ERROR: webhook NOT updated. Pushes won't re-index. Fix gh access, then run: scripts/secrets.sh webhook"; exit 1
  fi
  echo "ok: webhook ${hook:-created}"
}

case "${1:-}" in
  github)
    T=$(pbpaste | tr -d '[:space:]')
    case "$T" in github_pat_*|ghp_*) ;; *) echo "The clipboard does not hold a GitHub token (github_pat_...)."; exit 1;; esac
    code=$(printf 'header = "Authorization: Bearer %s"\n' "$T" | curl -s -o /dev/null -w "%{http_code}" --config - "https://api.github.com/repos/$NOTES_REPO/contents/")
    [ "$code" = 200 ] || { echo "GitHub rejected the token (HTTP $code): it needs Contents access to $NOTES_REPO."; exit 1; }
    put GITHUB_TOKEN "$T"
    pbcopy </dev/null; echo "Clipboard cleared."
    ;;
  rotate)
    if [ "${2:-}" != "--yes" ]; then
      read -r -p "This cuts off every MCP client until it reconnects. Continue? [y/N] " ok; [ "$ok" = y ] || exit 1
    fi
    setvar MCP_TOKEN "$(openssl rand -hex 24)"
    setvar WEBHOOK_SECRET "$(openssl rand -hex 32)"
    printf '%s\n' "$WORKER_URL" > .worker-url
    put MCP_TOKEN "$(getvar MCP_TOKEN)"
    put WEBHOOK_SECRET "$(getvar WEBHOOK_SECRET)"
    webhook
    echo "New MCP URL: $WORKER_URL/<MCP_TOKEN from .dev.vars>/mcp. Reconnect the clients."
    ;;
  webhook) webhook ;;
  *) echo "usage: scripts/secrets.sh github | rotate [--yes] | webhook"; exit 1;;
esac
