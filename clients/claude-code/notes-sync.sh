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

# One sync at a time per clone (#16): a mkdir lock holding the owner's pid. A lock is taken over
# only if its pid is gone or it is older than LOCK_STALE; a lock without a pid yet (just created)
# counts as live. Takeover renames the old lock first, so only one process can win it.
lock() {
  local waited=0
  until mkdir "$LOCK" 2>/dev/null; do
    local pid; pid=$(cat "$LOCK/pid" 2>/dev/null)
    if { [ -n "$pid" ] && ! ps -p "$pid" >/dev/null 2>&1; } || [ "$(age "$LOCK")" -gt "$LOCK_STALE" ]; then
      mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null && rm -rf "$LOCK.stale.$$"
      continue
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

# Commits whatever is in the working tree, so nothing local lives outside a commit during a pull
# (no autostash: an autostash conflict would leave markers behind).
commit_local() {
  [ -n "$(git status --porcelain)" ] || return 0
  local n; n=$(git status --porcelain | wc -l | tr -d ' ')
  git add -A >>"$LOG" 2>&1 && git commit -qm "notes: $n file(s) via Claude Code, $(date '+%F %H:%M')" >>"$LOG" 2>&1
}

# Pull with rebase. On a conflict (#15) nothing local is lost:
#   - notes changed only here keep their path and their local version;
#   - notes changed here and on the remote keep the remote version at their path, and the local
#     version is saved next to it as <name>.conflict-<time>.md;
#   - notes changed only on the remote come in as usual.
# Then it pushes and returns 1, so Claude Code shows that a conflict happened.
sync_remote() {
  git pull --rebase -q >>"$LOG" 2>&1 && return 0
  [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || { fail "pull failed in $DIR"; return 1; }
  local mine base ts saved n=0
  mine=$(cat .git/rebase-merge/orig-head .git/rebase-apply/orig-head 2>/dev/null | head -1)
  git rebase --abort >>"$LOG" 2>&1
  base=$(git merge-base "$mine" "$UPSTREAM")
  ts=$(date '+%Y%m%d-%H%M%S')
  saved=$(mktemp -d)
  # remote-changed paths, NUL-separated (safe with spaces and accents)
  git diff -z --name-only "$base" "$UPSTREAM" > "$saved/.remote"
  git reset -q --hard "$UPSTREAM" >>"$LOG" 2>&1
  while IFS= read -r -d '' f; do
    local both=0
    while IFS= read -r -d '' r; do [ "$r" = "$f" ] && both=1 && break; done < "$saved/.remote"
    if git cat-file -e "$mine:$f" 2>/dev/null; then
      local dest="$f"
      if [ "$both" = 1 ]; then dest="${f%.md}.conflict-$ts.md"; n=$((n + 1)); fi
      mkdir -p "$(dirname "$dest")" && git show "$mine:$f" > "$dest"
    elif [ "$both" = 0 ]; then
      rm -f "$f" # deleted here and untouched on the remote: keep the deletion
    fi # deleted here but changed on the remote: the remote version wins, nothing to save
  done < <(git diff -z --name-only "$base" "$mine")
  rm -rf "$saved"
  commit_local
  git push -q >>"$LOG" 2>&1 || fail "push after resolving the conflict failed; the next sync retries"
  fail "the remote changed the same notes; kept the remote version and saved $n local version(s) as *.conflict-$ts.md"
}

pull() {
  if [ "$1" = "throttle" ] && [ -f "$STAMP" ] && [ "$(age "$STAMP")" -lt "$PULL_EVERY" ]; then return 0; fi
  lock || return 1
  commit_local
  auth || return 1
  sync_remote || return 1
  touch "$STAMP"
}

push() {
  lock || return 1
  commit_local
  # nothing committed locally that the remote lacks: no network call at all
  [ -n "$(git log @{u}..HEAD --oneline 2>/dev/null)" ] || return 0
  auth || return 1
  sync_remote || return 1
  git push -q >>"$LOG" 2>&1 || { fail "push failed in $DIR (see $LOG)"; return 1; }
  touch "$STAMP"
}

case "$1" in
  pull) pull ;;
  pull-throttle) pull throttle ;;
  push) push ;;
esac || exit 1
exit 0
