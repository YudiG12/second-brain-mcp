#!/bin/bash
# Keeps the local clone of the notes in sync with the Artifacts repository (ADR 007).
# pull: brings in what was saved from the phone or ChatGPT (through the MCP). push: sends what changed here.
# Git auth: a 1-hour write token from the Worker's /admin/artifacts-token, cached in the macOS Keychain.
# The admin secret that route needs is also in the Keychain (service "second-brain-admin").
DIR="${NOTES_DIR:-$HOME/dev/agentes/cerebro/notas}"
WORKER="${SECOND_BRAIN_URL:-https://second-brain-mcp.yudiganeko.workers.dev}"
STAMP="$DIR/.git/.last-pull"
LOG="$HOME/.claude/notes-sync.log"
PULL_EVERY=600 # seconds between prompt-time pulls (ADR 007: stay within the included Artifacts operations)
cd "$DIR" 2>/dev/null || exit 0
[ -d .git ] || exit 0
export GIT_TERMINAL_PROMPT=0

# Failures go to the log and to stderr, and the script exits 1, so Claude Code shows them (spec v2 §5.4).
fail() { echo "$(date '+%F %T') notes-sync: $*" | tee -a "$LOG" >&2; return 1; }

# Sets git's auth header through env vars (not argv). Returns 1 if no token can be had.
auth() {
  local cached exp token now json admin
  now=$(date +%s)
  cached=$(security find-generic-password -s second-brain-artifacts-token -w 2>/dev/null)
  exp=${cached%%|*}; token=${cached#*|}
  if [ -z "$cached" ] || [ $((exp - now)) -lt 300 ]; then
    admin=$(security find-generic-password -s second-brain-admin -w 2>/dev/null) || { fail "admin secret missing from the Keychain (run scripts/secrets.sh admin)"; return 1; }
    json=$(printf 'header = "Authorization: Bearer %s"\n' "$admin" | curl -fsS -m 15 --doh-url https://1.1.1.1/dns-query --config - -X POST "$WORKER/admin/artifacts-token") || { fail "could not get an Artifacts token from $WORKER"; return 1; }
    read -r exp token < <(printf '%s' "$json" | python3 -c 'import json,sys,datetime as d;j=json.load(sys.stdin);print(int(d.datetime.fromisoformat(j["expiresAt"].replace("Z","+00:00")).timestamp()), j["token"])' 2>/dev/null)
    case "$exp" in ''|*[!0-9]*) fail "unexpected token response from $WORKER"; return 1;; esac
    [ -n "$token" ] || { fail "empty token from $WORKER"; return 1; }
    security add-generic-password -U -s second-brain-artifacts-token -a "$USER" -w "$exp|$token" 2>/dev/null
  fi
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $token"
}

pull() {
  # on prompts, at most one pull every PULL_EVERY seconds; at session start, always
  if [ "$1" = "throttle" ] && [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -f %m "$STAMP") )) -lt $PULL_EVERY ]; then return; fi
  auth || return 1
  git pull --rebase --autostash -q && touch "$STAMP" || fail "pull failed in $DIR"
}

push() {
  if [ -n "$(git status --porcelain)" ]; then
    n=$(git status --porcelain | wc -l | tr -d ' ')
    git add -A && git commit -qm "notes: $n file(s) via Claude Code, $(date '+%F %H:%M')" || true
  fi
  # nothing committed locally that the remote lacks: no network call at all
  [ -n "$(git log @{u}..HEAD --oneline 2>/dev/null)" ] || return 0
  auth || return 1
  git pull --rebase --autostash -q || { fail "pull before push failed in $DIR (rebase conflict? see #15)"; return 1; }
  git push -q && touch "$STAMP" || fail "push failed in $DIR"
}

case "$1" in
  pull) pull ;;
  pull-throttle) pull throttle ;;
  push) push ;;
esac || exit 1
exit 0
