#!/bin/bash
# Keeps the local clone of the notes in sync with the Artifacts repository (ADR 007, spec v2 §5.4).
#   pull           at session start
#   pull-throttle  on prompts, at most every 10 minutes
#   push           after each answer, only when there is something to send
# Git auth: a 1-hour write token from the Worker's /hook/artifacts-token, cached in the macOS
# Keychain. That route needs the hook secret (Keychain service "second-brain-hook"), which can only
# issue Artifacts tokens (#39). Failures are logged and exit 1, so Claude Code shows them.
DIR="${NOTES_DIR:-$HOME/dev/agentes/cerebro/notas}"
WORKER="${SECOND_BRAIN_URL:-https://second-brain-mcp.yudiganeko.workers.dev}"
LOG="$HOME/.claude/notes-sync.log"
PULL_EVERY=600
LOCK_WAIT="${NOTES_SYNC_LOCK_WAIT:-10}" # seconds to wait for another session's sync
LOCK_STALE=120                           # a lock older than this is abandoned
cd "$DIR" 2>/dev/null || exit 0
[ -d .git ] || exit 0
export GIT_TERMINAL_PROMPT=0
STAMP=.git/.last-pull
LOCK=.git/notes-sync.lock
UPSTREAM=$(git rev-parse --symbolic-full-name @{u} 2>/dev/null) # e.g. refs/remotes/origin/main; @{u} fails mid-rebase

fail() { echo "$(date '+%F %T') notes-sync: $*" | tee -a "$LOG" >&2; return 1; }
age() { echo $(( $(date +%s) - $(date -r "$1" +%s 2>/dev/null || echo 0) )); } # seconds since mtime (BSD and GNU)

# One sync at a time per clone (#16): a mkdir lock with the owner's pid.
lock() {
  local waited=0
  until mkdir "$LOCK" 2>/dev/null; do
    local pid; pid=$(cat "$LOCK/pid" 2>/dev/null)
    if { [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; } || [ "$(age "$LOCK")" -gt "$LOCK_STALE" ]; then
      rm -rf "$LOCK"; continue # abandoned by a process that died
    fi
    [ "$waited" -ge "$LOCK_WAIT" ] && { fail "skipped: another session has been syncing $DIR for over ${LOCK_WAIT}s"; return 1; }
    sleep 1; waited=$((waited + 1))
  done
  echo $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
}

# Sets git's auth header through env vars (not argv). Skipped in tests (local remote).
auth() {
  [ -n "${NOTES_SYNC_NO_AUTH:-}" ] && return 0
  local cached exp token json secret
  cached=$(security find-generic-password -s second-brain-artifacts-token -w 2>/dev/null)
  exp=${cached%%|*}; token=${cached#*|}
  if [ -z "$cached" ] || [ $((exp - $(date +%s))) -lt 300 ]; then
    secret=$(security find-generic-password -s second-brain-hook -w 2>/dev/null) || { fail "hook secret missing from the Keychain (run scripts/secrets.sh hook)"; return 1; }
    json=$(printf 'header = "Authorization: Bearer %s"\n' "$secret" | curl -fsS -m 15 --doh-url https://1.1.1.1/dns-query --config - -X POST "$WORKER/hook/artifacts-token") || { fail "could not get an Artifacts token from $WORKER"; return 1; }
    read -r exp token < <(printf '%s' "$json" | python3 -c 'import json,sys,datetime as d;j=json.load(sys.stdin);print(int(d.datetime.fromisoformat(j["expiresAt"].replace("Z","+00:00")).timestamp()), j["token"])' 2>/dev/null)
    case "$exp" in ''|*[!0-9]*) fail "unexpected token response from $WORKER"; return 1;; esac
    [ -n "$token" ] || { fail "empty token from $WORKER"; return 1; }
    security add-generic-password -U -s second-brain-artifacts-token -a "$USER" -w "$exp|$token" 2>/dev/null
  fi
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $token"
}

# A rebase stopped on a conflict (#15). The remote wins; every local change survives as a
# "<name>.conflict-<time>.md" note next to the original, pushed so it shows up everywhere.
resolve_conflict() {
  local ts copies=0 f
  ts=$(date '+%Y%m%d-%H%M%S')
  local saved; saved=$(mktemp -d)
  # local changes = what our unpushed commits changed, as of our last commit before the rebase
  local mine; mine=$(cat .git/rebase-merge/orig-head .git/rebase-apply/orig-head 2>/dev/null | head -1)
  for f in $(git diff --name-only "$UPSTREAM" "$mine" 2>/dev/null); do
    if git cat-file -e "$mine:$f" 2>/dev/null; then
      mkdir -p "$saved/$(dirname "$f")"; git show "$mine:$f" > "$saved/$f"; copies=$((copies + 1))
    fi
  done
  git rebase --abort 2>/dev/null
  git reset -q --hard "$UPSTREAM"
  for f in $(cd "$saved" && find . -type f | sed 's#^\./##'); do
    local copy="${f%.md}.conflict-$ts.md"
    mkdir -p "$(dirname "$copy")"; cp "$saved/$f" "$copy"
  done
  rm -rf "$saved"
  if [ "$copies" -gt 0 ]; then
    git add -A && git commit -qm "notes: $copies conflict copy(ies) from the Mac, $(date '+%F %H:%M')" && git push -q
  fi
  fail "the remote changed the same notes; kept the remote version and saved $copies local version(s) as *.conflict-$ts.md"
}

pull() {
  if [ "$1" = "throttle" ] && [ -f "$STAMP" ] && [ "$(age "$STAMP")" -lt "$PULL_EVERY" ]; then return 0; fi
  lock || return 1
  auth || return 1
  if ! git pull --rebase --autostash -q 2>>"$LOG"; then
    if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then resolve_conflict; return 1; fi
    fail "pull failed in $DIR"; return 1
  fi
  touch "$STAMP"
}

push() {
  lock || return 1
  if [ -n "$(git status --porcelain)" ]; then
    n=$(git status --porcelain | wc -l | tr -d ' ')
    git add -A && git commit -qm "notes: $n file(s) via Claude Code, $(date '+%F %H:%M')" || true
  fi
  # nothing committed locally that the remote lacks: no network call at all
  [ -n "$(git log @{u}..HEAD --oneline 2>/dev/null)" ] || return 0
  auth || return 1
  if ! git pull --rebase --autostash -q 2>>"$LOG"; then
    if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then resolve_conflict; return 1; fi
    fail "pull before push failed in $DIR"; return 1
  fi
  git push -q 2>>"$LOG" || { fail "push failed in $DIR"; return 1; }
  touch "$STAMP"
}

case "$1" in
  pull) pull ;;
  pull-throttle) pull throttle ;;
  push) push ;;
esac || exit 1
exit 0
