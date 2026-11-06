#!/bin/bash
# Keeps the local clone of the notes in sync with the Artifacts repository (ADR 007, spec v2 §5.4).
#   pull           at session start
#   pull-throttle  on prompts, at most every 10 minutes
#   push           after each answer, only when there is something to send
#
# Rule: no local edit is ever lost. Before anything destructive, the local version is pinned in
# refs/notes-sync/pending; every run first finishes a restore left pending by an interrupted run.
# Conflicts keep the remote version at the path and the local one as <name>.conflict-<time>.<ext>.
# Failures are logged to ~/.claude/notes-sync.log and exit 1, so Claude Code shows them; nothing
# goes to stdout (on some hooks it would be added to Claude's context).
#
# Git auth: a 1-hour write token from the Worker's /hook/artifacts-token, cached in the macOS
# Keychain. That route needs the hook secret (Keychain service "second-brain-hook"), which can only
# issue Artifacts tokens (#39).
DIR="${NOTES_DIR:-$HOME/dev/agentes/cerebro/notas}"
WORKER="${SECOND_BRAIN_URL:-https://second-brain-mcp.yudiganeko.workers.dev}"
LOG="$HOME/.claude/notes-sync.log"
PULL_EVERY=600
LOCK_WAIT="${NOTES_SYNC_LOCK_WAIT:-10}" # seconds to wait for another session's sync
LOCK_STALE=120                           # a lock this old with no pid is abandoned
PENDING=refs/notes-sync/pending
cd "$DIR" 2>/dev/null || exit 0
[ -d .git ] || exit 0
export GIT_TERMINAL_PROMPT=0
STAMP=.git/.last-pull
LOCK=.git/notes-sync.lock
mkdir -p "$(dirname "$LOG")"

fail() { echo "$(date '+%F %T') notes-sync: $*" | tee -a "$LOG" >&2; return 1; }
age() { echo $(( $(date +%s) - $(date -r "$1" +%s 2>/dev/null || echo 0) )); } # seconds since mtime (BSD and GNU)
mid_rebase() { [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; }

# The branch and its upstream, readable even in the middle of a rebase.
BRANCH=$(cat .git/rebase-merge/head-name .git/rebase-apply/head-name 2>/dev/null | head -1)
BRANCH=${BRANCH:-$(git symbolic-ref -q HEAD)}
BRANCH=${BRANCH#refs/heads/}
UPSTREAM=$(git rev-parse -q --verify --symbolic-full-name "$BRANCH@{u}" 2>/dev/null)

# One sync at a time per clone (#16): a mkdir lock holding the owner's pid. Taken over only if
# its pid is gone, or if it has no pid and is older than LOCK_STALE. Takeover renames the old lock
# first, so only one process wins; the exit trap removes the lock only if we still own it.
lock() {
  local waited=0
  until mkdir "$LOCK" 2>/dev/null; do
    local pid; pid=$(cat "$LOCK/pid" 2>/dev/null)
    if { [ -n "$pid" ] && ! ps -p "$pid" >/dev/null 2>&1; } || { [ -z "$pid" ] && [ "$(age "$LOCK")" -gt "$LOCK_STALE" ]; }; then
      mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null && rm -rf "$LOCK.stale.$$"
      continue
    fi
    [ "$waited" -ge "$LOCK_WAIT" ] && { fail "skipped: another session has been syncing $DIR for over ${LOCK_WAIT}s"; return 1; }
    sleep 1; waited=$((waited + 1))
  done
  echo $$ > "$LOCK/pid"
  trap '[ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"' EXIT
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

# Commits whatever is in the working tree, so nothing local lives outside a commit during a pull.
commit_local() {
  [ -n "$(git status --porcelain)" ] || return 0
  local n; n=$(git status --porcelain | wc -l | tr -d ' ')
  git add -A >>"$LOG" 2>&1 && git commit -qm "notes: $n file(s) via Claude Code, $(date '+%F %H:%M')" >>"$LOG" 2>&1
}

# Pins the local state in $PENDING before anything destructive: the local commit, plus any file
# edited in the working tree since the current HEAD (written during a stopped rebase, or by
# another writer). Files with conflict markers are never taken from the working tree.
pin_local() {
  local mine="$1" tmp unmerged edited
  tmp=$(mktemp); unmerged=$(mktemp); edited=$(mktemp)
  # computed against the real index, before switching to the temporary one
  git diff -z --name-only --diff-filter=U > "$unmerged" 2>/dev/null
  { git diff -z --name-only HEAD 2>/dev/null; git ls-files -z --others --exclude-standard; } > "$edited"
  (
    export GIT_INDEX_FILE="$tmp"
    git read-tree "$mine" || exit 1
    while IFS= read -r -d '' f; do
      skip=0
      while IFS= read -r -d '' u; do [ "$u" = "$f" ] && { skip=1; break; }; done < "$unmerged"
      [ "$skip" = 1 ] && continue
        if [ -f "$f" ]; then
          git update-index --add --cacheinfo "100644,$(git hash-object -w -- "$f"),$f" || exit 1
        else
          git update-index --force-remove -- "$f" || exit 1
        fi
    done < "$edited"
    tree=$(git write-tree) || exit 1
    commit=$(git commit-tree "$tree" -p "$mine" -m "notes-sync: pinned local state") || exit 1
    git update-ref "$PENDING" "$commit"
  ); local rc=$?
  rm -f "$tmp" "$unmerged" "$edited"
  return $rc
}

conflict_name() { # a/b.md -> a/b.conflict-<ts>.md ; a/img.png -> a/img.conflict-<ts>.png
  local f="$1" ts="$2" dir="" name="$1"
  case "$f" in */*) dir="${f%/*}/"; name="${f##*/}";; esac
  case "$name" in ?*.*) echo "$dir${name%.*}.conflict-$ts.${name##*.}";; *) echo "$dir$name.conflict-$ts";; esac
}

# Puts every local change pinned in $PENDING back on top of the remote: changed only here keeps
# its path; changed on both sides keeps the remote version and adds a conflict copy; deleted here
# and untouched remotely stays deleted. Clears $PENDING only once all of it is committed.
restore_pending() {
  local mine base ts n=0 remote_changed
  mine=$(git rev-parse -q --verify "$PENDING") || return 0
  [ -n "$UPSTREAM" ] || { fail "no upstream for $BRANCH; your local version is safe in $PENDING"; return 1; }
  base=$(git merge-base "$mine" "$UPSTREAM") || { fail "can't find a common base; your local version is safe in $PENDING"; return 1; }
  ts=$(date '+%Y%m%d-%H%M%S')
  remote_changed=$(mktemp)
  git diff -z --name-only "$base" "$UPSTREAM" > "$remote_changed"
  git reset -q --hard "$UPSTREAM" >>"$LOG" 2>&1 || { rm -f "$remote_changed"; fail "reset failed; your local version is safe in $PENDING"; return 1; }
  [ -n "${NOTES_SYNC_TEST_DIE_AFTER_RESET:-}" ] && kill -9 $$
  local failed=0
  while IFS= read -r -d '' f; do
    local both=0 r
    while IFS= read -r -d '' r; do [ "$r" = "$f" ] && { both=1; break; }; done < "$remote_changed"
    if git cat-file -e "$mine:$f" 2>/dev/null; then
      local dest="$f"; [ "$both" = 1 ] && dest=$(conflict_name "$f" "$ts")
      if mkdir -p -- "$(dirname -- "$dest")" 2>>"$LOG" && git show "$mine:$f" > "./$dest" 2>>"$LOG"; then
        [ "$both" = 1 ] && n=$((n + 1))
      else
        failed=1; fail "could not restore $f (a file and a folder clash?)"
      fi
    elif [ "$both" = 0 ]; then
      rm -f -- "./$f" # deleted here and untouched on the remote
    fi # deleted here but changed on the remote: the remote version wins
  done < <(git diff -z --name-only "$base" "$mine")
  rm -f "$remote_changed"
  if [ "$failed" = 1 ]; then fail "some local changes could not be restored; they are safe in $PENDING (git show $PENDING:<path>)"; return 1; fi
  commit_local || { fail "commit after restore failed; your local version is safe in $PENDING"; return 1; }
  git update-ref -d "$PENDING"
  git push -q >>"$LOG" 2>&1 || fail "push after the restore failed; the next sync retries"
  [ "$n" -gt 0 ] && { fail "the remote changed the same notes; kept the remote version and saved $n local version(s) as *.conflict-$ts.*"; return 1; }
  return 0
}

# Finishes what an interrupted run left behind: a stopped rebase, or a pending restore.
recover() {
  if mid_rebase; then
    local replaying; replaying=$(cat .git/rebase-merge/orig-head .git/rebase-apply/orig-head 2>/dev/null | head -1)
    [ -n "$replaying" ] || { fail "$DIR is in the middle of a rebase with no record of the local commit; fix it by hand"; return 1; }
    pin_local "$replaying" || { fail "could not pin the local state; nothing was changed"; return 1; }
    git rebase --abort >>"$LOG" 2>&1
    fail "found $DIR in the middle of a rebase (an earlier sync was interrupted); recovering"
  fi
  if git rev-parse -q --verify "$PENDING" >/dev/null; then restore_pending || return 1; fi
  return 0
}

# Pull with rebase; on a conflict, pin, abort, and restore (see restore_pending).
sync_remote() {
  git pull --rebase -q >>"$LOG" 2>&1 && return 0
  mid_rebase || { fail "pull failed in $DIR (see $LOG)"; return 1; }
  local mine; mine=$(cat .git/rebase-merge/orig-head .git/rebase-apply/orig-head 2>/dev/null | head -1)
  [ -n "${NOTES_SYNC_TEST_BEFORE_ABORT:-}" ] && eval "$NOTES_SYNC_TEST_BEFORE_ABORT"
  pin_local "$mine" || { fail "could not pin the local state; leaving the rebase for the next run"; return 1; }
  git rebase --abort >>"$LOG" 2>&1
  git fetch -q >>"$LOG" 2>&1
  restore_pending
}

start() {
  lock || return 1
  [ -n "$UPSTREAM" ] || { fail "$BRANCH has no upstream in $DIR; nothing was synced"; return 1; }
  auth || return 1
  recover || return 1
}

pull() {
  if [ "$1" = "throttle" ] && [ -f "$STAMP" ] && [ "$(age "$STAMP")" -lt "$PULL_EVERY" ]; then return 0; fi
  start || return 1
  commit_local
  sync_remote || return 1
  touch "$STAMP"
}

push() {
  start || return 1
  commit_local
  # nothing committed locally that the remote lacks: no network call at all
  [ -n "$(git log "$UPSTREAM..HEAD" --oneline 2>/dev/null)" ] || return 0
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
