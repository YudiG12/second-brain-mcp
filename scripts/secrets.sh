#!/usr/bin/env bash
# Sets the Worker's secrets without printing them. Values are saved to .dev.vars (gitignored) first.
#   scripts/secrets.sh rotate [--yes]  new MCP_TOKEN. Every MCP client is cut off until it reconnects.
#   scripts/secrets.sh admin           new ADMIN_SECRET: saved to .dev.vars, the Worker and the macOS Keychain
#                                      (service "second-brain-admin", read by the Mac sync hook)
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

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

case "${1:-}" in
  rotate)
    if [ "${2:-}" != "--yes" ]; then
      read -r -p "This cuts off every MCP client until it reconnects. Continue? [y/N] " ok; [ "$ok" = y ] || exit 1
    fi
    setvar MCP_TOKEN "$(openssl rand -hex 24)"
    printf '%s\n' "$WORKER_URL" > .worker-url
    put MCP_TOKEN "$(getvar MCP_TOKEN)"
    echo "New MCP URL: $WORKER_URL/<MCP_TOKEN from .dev.vars>/mcp. Reconnect the clients."
    ;;
  admin)
    setvar ADMIN_SECRET "$(openssl rand -hex 32)"
    put ADMIN_SECRET "$(getvar ADMIN_SECRET)"
    # `security` only takes the value as an argument (briefly visible to local processes); fine on a single-user Mac
    security add-generic-password -U -s second-brain-admin -a "$USER" -w "$(getvar ADMIN_SECRET)"
    security delete-generic-password -s second-brain-artifacts-token >/dev/null 2>&1 || true
    echo "ok: ADMIN_SECRET in the Keychain"
    ;;
  *) echo "usage: scripts/secrets.sh rotate [--yes] | admin"; exit 1;;
esac
