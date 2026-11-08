#!/usr/bin/env bash
# Sets the Worker's secrets without printing them. Values are saved to .dev.vars (gitignored) first.
#   scripts/secrets.sh github-oauth    asks for the GitHub OAuth app's client secret in Wrangler's hidden prompt
#                                      and saves it to the Worker as GITHUB_CLIENT_SECRET
#   scripts/secrets.sh admin           new ADMIN_SECRET (admin routes): saved to .dev.vars and the Worker
#   scripts/secrets.sh hook            new HOOK_SECRET (only issues Artifacts tokens): saved to .dev.vars,
#                                      the Worker and the macOS Keychain (service "second-brain-hook")
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."


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
  github-oauth)
    # typed into Wrangler's own hidden prompt (or piped on stdin): never argv, a file or the clipboard
    npx --no-install wrangler secret put GITHUB_CLIENT_SECRET
    ;;
  admin)
    setvar ADMIN_SECRET "$(openssl rand -hex 32)"
    put ADMIN_SECRET "$(getvar ADMIN_SECRET)"
    ;;
  hook)
    setvar HOOK_SECRET "$(openssl rand -hex 32)"
    put HOOK_SECRET "$(getvar HOOK_SECRET)"
    # `security` only takes the value as an argument (briefly visible to local processes); fine on a single-user Mac
    security add-generic-password -U -s second-brain-hook -a "$USER" -w "$(getvar HOOK_SECRET)"
    security delete-generic-password -s second-brain-artifacts-token >/dev/null 2>&1 || true
    security delete-generic-password -s second-brain-admin >/dev/null 2>&1 || true # the Mac no longer keeps the admin secret
    echo "ok: HOOK_SECRET in the Keychain"
    ;;
  *) echo "usage: scripts/secrets.sh admin | hook | github-oauth"; exit 1;;
esac
