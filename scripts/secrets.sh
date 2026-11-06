#!/usr/bin/env bash
# Sets the Worker's secrets without printing them.
#   scripts/secrets.sh github    reads a GitHub token from the clipboard, checks it, saves it, clears the clipboard
#   scripts/secrets.sh rotate    generates a new MCP_TOKEN and WEBHOOK_SECRET, saves them to the Worker and to
#                                .dev.vars (gitignored), and points the GitHub webhook at the new URL and secret
set -euo pipefail
cd "$(dirname "$0")/.."

NOTES_REPO="YudiG12/segundo-cerebro"
WORKER_URL="https://second-brain-mcp.yudiganeko.workers.dev"
put() { printf '%s' "$2" | npx --no-install wrangler secret put "$1" >/dev/null && echo "ok: $1"; }

case "${1:-}" in
  github)
    T=$(pbpaste | tr -d '[:space:]')
    case "$T" in github_pat_*|ghp_*) ;; *) echo "The clipboard does not hold a GitHub token (github_pat_...)."; exit 1;; esac
    code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" "https://api.github.com/repos/$NOTES_REPO/contents/")
    [ "$code" = 200 ] || { echo "GitHub rejected the token (HTTP $code): it needs Contents access to $NOTES_REPO."; exit 1; }
    put GITHUB_TOKEN "$T"
    pbcopy </dev/null; echo "Clipboard cleared."
    ;;
  rotate)
    MCP_TOKEN=$(openssl rand -hex 24)
    WEBHOOK_SECRET=$(openssl rand -hex 32)
    put MCP_TOKEN "$MCP_TOKEN"
    put WEBHOOK_SECRET "$WEBHOOK_SECRET"
    printf 'MCP_TOKEN=%s\nWEBHOOK_SECRET=%s\n' "$MCP_TOKEN" "$WEBHOOK_SECRET" > .dev.vars
    printf '%s\n' "$WORKER_URL" > .worker-url
    hook=$(gh api "repos/$NOTES_REPO/hooks" --jq '.[] | select(.config.url | test("github-webhook")) | .id' | head -1)
    body=$(python3 -c 'import json,sys;print(json.dumps({"config":{"url":sys.argv[1],"content_type":"json","secret":sys.argv[2]},"events":["push"],"active":True}))' "$WORKER_URL/$MCP_TOKEN/github-webhook" "$WEBHOOK_SECRET")
    if [ -n "$hook" ]; then
      printf '%s' "$body" | gh api -X PATCH "repos/$NOTES_REPO/hooks/$hook" --input - >/dev/null && echo "ok: webhook $hook updated"
    else
      printf '%s' "$body" | gh api -X POST "repos/$NOTES_REPO/hooks" --input - >/dev/null && echo "ok: webhook created"
    fi
    echo "New MCP URL saved in .dev.vars (MCP_TOKEN). Reconnect the clients."
    ;;
  *) echo "usage: scripts/secrets.sh github|rotate"; exit 1;;
esac
