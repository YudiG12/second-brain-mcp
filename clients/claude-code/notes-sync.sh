#!/bin/bash
# Keeps the local clone of the notes in sync with the Artifacts repository (ADR 007, spec v2 §5.4).
#   pull           at session start
#   pull-throttle  on prompts, at most every 10 minutes
#   push           after each answer, only when there is something to send
#
# Rule: no local edit is ever lost. Local edits are committed first and local commits are never
# rewritten: the remote comes in by fast-forward or merge. A conflicted note keeps the remote
# version at its path and the local one as <name>.conflict-<time>.<ext>; an interrupted merge is
# resumed by the next run.
# Failures are logged to ~/.claude/notes-sync.log and exit 1, so Claude Code shows them; nothing
# goes to stdout (on some hooks it would be added to Claude's context).
#
# Git auth: a 1-hour write token from the Worker's /hook/artifacts-token, cached in the macOS
# Keychain. That route needs the hook secret (Keychain service "second-brain-hook"), which can only
# issue Artifacts tokens (#39).
#
# Configuration: NOTES_DIR (the clone) and SECOND_BRAIN_URL (your Worker), from the environment or
# from ~/.config/second-brain/hook.env as KEY=value lines. The file is read as text, never run.
LOG="$HOME/.claude/notes-sync.log"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/second-brain/hook.env"
conf() { # last value of KEY in the config file: optional "export", CRLF, quotes, trailing spaces and
  # " # comment" removed; a leading ~, $HOME or ${HOME} expanded. Nothing else is expanded or run.
  [ -f "$CONF" ] || return 0
  local v; v=$(tr -d '\r' < "$CONF" | sed -En "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" | tail -1)
  case "$v" in
    \"*\"*) v=${v#\"}; v=${v%%\"*};;
    \'*\'*) v=${v#\'}; v=${v%%\'*};;
    *) v=${v%%[[:space:]]#*}; v=${v%"${v##*[![:space:]]}"};;
  esac
  case "$v" in
    "~"|"~/"*) v="$HOME${v#\~}";;
    '$HOME'|'$HOME/'*) v="$HOME${v#\$HOME}";;
    '${HOME}'|'${HOME}/'*) v="$HOME${v#\$\{HOME\}}";;
  esac
  printf '%s' "$v"
}
DIR="${NOTES_DIR:-$(conf NOTES_DIR)}"
WORKER="${SECOND_BRAIN_URL:-$(conf SECOND_BRAIN_URL)}"
PULL_EVERY=600
LOCK_WAIT="${NOTES_SYNC_LOCK_WAIT:-10}" # seconds to wait for another session's sync
LOCK_STALE=120                           # a lock this old with no pid is abandoned
say() { mkdir -p "$(dirname "$LOG")"; echo "$(date '+%F %T') notes-sync: $*" | tee -a "$LOG" >&2; }
[ -n "$DIR" ] || { say "not configured: set NOTES_DIR to your notes clone, in the environment or in $CONF"; exit 1; }
cd "$DIR" 2>/dev/null || { say "NOTES_DIR=$DIR doesn't exist"; exit 1; }
[ -d .git ] || { say "NOTES_DIR=$DIR is not a Git clone"; exit 1; }
export GIT_TERMINAL_PROMPT=0
STAMP=.git/.last-pull
LOCK=.git/notes-sync.lock
MERGE_SNAPSHOT=.git/notes-sync-merge # "<hash> <path>\0" of each conflicted file right after git merge
MERGE_TS=.git/notes-sync-merge-ts    # the conflict copies' timestamp for the merge in progress
mkdir -p "$(dirname "$LOG")"

# The hook's own commits and merges ignore user settings that would break them: signing without a
# key, global commit hooks, merge.ff=only.
g() { git -c commit.gpgsign=false -c core.hooksPath=/dev/null -c merge.ff=true "$@"; }

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
  [ -n "$WORKER" ] || { fail "not configured: set SECOND_BRAIN_URL to your Worker's URL, in the environment or in $CONF"; return 1; }
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

# Commits whatever is in the working tree, so nothing local lives outside a commit during a merge.
commit_local() {
  [ -n "$(git status --porcelain)" ] || return 0
  # On a case-insensitive disk (macOS), two notes whose names differ only in case share one file,
  # so committing would write one's text over the other. Stop instead (the server refuses to
  # create such names; this only guards older ones).
  if [ -e .GIT/HEAD ] && [ -n "$(git ls-files | tr '[:upper:]' '[:lower:]' | sort | uniq -d)" ]; then
    fail "notes whose names differ only in case can't both live on this disk: $(git ls-files | tr '[:upper:]' '[:lower:]' | sort | uniq -d | head -3 | tr '\n' ' ')- rename one through the MCP; nothing was committed"
    return 1
  fi
  local n; n=$(git status --porcelain | wc -l | tr -d ' ')
  g add -A >>"$LOG" 2>&1 && g commit -qm "notes: $n file(s) via Claude Code, $(date '+%F %H:%M')" >>"$LOG" 2>&1 ||
    { fail "could not commit local changes in $DIR (see $LOG); nothing was synced"; return 1; }
}

conflict_name() { # a/b.md -> a/b.conflict-<ts>.md ; a/img.png -> a/img.conflict-<ts>.png
  local f="$1" ts="$2" dir="" name="$1"
  case "$f" in */*) dir="${f%/*}/"; name="${f##*/}";; esac
  case "$name" in ?*.*) echo "$dir${name%.*}.conflict-$ts.${name##*.}";; *) echo "$dir$name.conflict-$ts";; esac
}

# Resolves an in-progress merge (#15): for each conflicted note, the remote version stays at its
# path and the local version (from the local commit, index stage 2) is saved next to it as a
# conflict copy. Nothing else is touched: local commits are never rewritten or reset, so nothing
# local can be lost, and an interrupted run just resumes here.
resolve_merge() {
  local resuming="${1:-0}" ts n=0 stages theirs gone
  # one timestamp per merge, kept across an interruption, so a resumed run reuses the same copy names
  [ -f "$MERGE_TS" ] || date '+%Y%m%d-%H%M%S' > "$MERGE_TS"
  ts=$(cat "$MERGE_TS")
  stages=$(mktemp); theirs=$(mktemp); gone=$(mktemp)
  git ls-files -u -z > "$stages" # "<mode> <hash> <stage>\t<path>\0" for every conflicted path
  while IFS= read -r -d '' f; do
    local ours="" their=""
    while IFS= read -r -d '' e; do
      [ "${e#*$'\t'}" = "$f" ] || continue
      local meta="${e%%$'\t'*}"; local st="${meta##* }"; local h="${meta#* }"; h="${h%% *}"
      [ "$st" = 2 ] && ours="$h"; [ "$st" = 3 ] && their="$h"
    done < "$stages"
    # Resuming an interrupted merge: keep a hand edit made since, as its own copy (anything that
    # is neither git's output from the snapshot nor either side's version).
    if [ "$resuming" = 1 ] && [ -f "$f" ]; then
      local wt as_merged=""; wt=$(git hash-object -- "$f")
      [ -f "$MERGE_SNAPSHOT" ] && as_merged=$(tr '\0' '\n' < "$MERGE_SNAPSHOT" | awk -v p="$f" '{h=$1; sub(/^[^ ]+ /,""); if ($0==p) print h}')
      if [ "$wt" != "$as_merged" ] && [ "$wt" != "$ours" ] && [ "$wt" != "$their" ]; then
        cp -- "./$f" "./$(conflict_name "$f" "$ts-edited")" && n=$((n + 1)) || { fail "could not save the edited $f; the merge is left as is"; return 1; }
      fi
    fi
    if [ -n "$ours" ]; then
      local copy; copy=$(conflict_name "$f" "$ts")
      mkdir -p -- "$(dirname -- "$copy")" && rm -f -- "./$copy" && git cat-file blob "$ours" > "./$copy" || { fail "could not save the local version of $f; the merge is left as is for the next run"; return 1; }
      n=$((n + 1))
    fi
    if [ -n "$their" ]; then printf '%s\0' "$f" >> "$theirs"; else printf '%s\0' "$f" >> "$gone"; fi
    [ -n "${NOTES_SYNC_TEST_DIE_MID_RESOLVE:-}" ] && kill -9 $$
  done < <(tr '\0' '\n' < "$stages" | cut -f2 | sort -u | tr '\n' '\0')
  # the remote version at each path (or its deletion), in one call each
  { [ ! -s "$theirs" ] || git checkout --theirs --pathspec-from-file="$theirs" --pathspec-file-nul >>"$LOG" 2>&1; } &&
    { [ ! -s "$gone" ] || git rm -q --pathspec-from-file="$gone" --pathspec-file-nul >>"$LOG" 2>&1; } ||
    { rm -f "$stages" "$theirs" "$gone"; fail "could not resolve the conflicts; the merge is left as is for the next run"; return 1; }
  rm -f "$stages" "$theirs" "$gone"
  [ -n "${NOTES_SYNC_TEST_DURING_RESOLVE:-}" ] && eval "$NOTES_SYNC_TEST_DURING_RESOLVE"
  g add -A >>"$LOG" 2>&1 # the copies, and anything written meanwhile, go into the merge commit
  [ -n "$(git ls-files -u)" ] && { fail "conflicts remain in $DIR; the merge is left as is for the next run"; return 1; }
  g commit -q --no-edit >>"$LOG" 2>&1 || { fail "could not commit the merge in $DIR"; return 1; }
  rm -f "$MERGE_SNAPSHOT" "$MERGE_TS"
  # git moves a remote file out of a local folder's way as "<name>~<ref>": both survive, but say so
  local moved; moved=$(git diff --name-only --diff-filter=A HEAD^1 HEAD 2>/dev/null | grep -c '~refs_remotes_' || true)
  [ "$moved" -gt 0 ] && n=$((n + moved))
  [ "$n" -gt 0 ] && CONFLICTS="$n local version(s) saved as *.conflict-$ts.*"
  return 0
}

# Brings in the remote: fast-forward when possible, otherwise a merge (never a rebase or reset).
sync_remote() {
  git fetch -q >>"$LOG" 2>&1 || { fail "fetch failed in $DIR (see $LOG)"; return 1; }
  git merge-base --is-ancestor "$UPSTREAM" HEAD && return 0 # nothing new on the remote
  if git merge-base --is-ancestor HEAD "$UPSTREAM"; then
    g merge -q --ff-only "$UPSTREAM" >>"$LOG" 2>&1 || { fail "fast-forward failed in $DIR (see $LOG)"; return 1; }
    split_case_clashes; return
  fi
  g merge -q --no-edit "$UPSTREAM" >>"$LOG" 2>&1 && { split_case_clashes; return; }
  [ -f .git/MERGE_HEAD ] || { fail "merge failed in $DIR (see $LOG)"; return 1; }
  # remember each conflicted file as git wrote it, so a resumed run can tell a hand edit apart
  : > "$MERGE_SNAPSHOT"
  while IFS= read -r -d '' f; do [ -f "$f" ] && printf '%s %s\0' "$(git hash-object -- "$f")" "$f" >> "$MERGE_SNAPSHOT"; done \
    < <(git ls-files -u -z | tr '\0' '\n' | cut -f2 | sort -u | tr '\n' '\0')
  resolve_merge && split_case_clashes
}

# On macOS two paths that differ only in case (Nota.md, nota.md) are one file on disk, so the
# next commit would overwrite one with the other. Keep the remote one at its path and move the
# local one's text to a conflict copy.
split_case_clashes() {
  local dup ts n=0
  ts=$(date '+%Y%m%d-%H%M%S')
  while IFS= read -r dup; do
    while IFS= read -r -d '' f; do
      [ "$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')" = "$dup" ] || continue
      git cat-file -e "$UPSTREAM:$f" 2>/dev/null && continue # the remote's spelling stays
      local copy; copy=$(conflict_name "$f" "$ts")
      git show "HEAD:$f" > "./$copy.tmp" && g rm -q --cached -- "./$f" >>"$LOG" 2>&1 && mv "./$copy.tmp" "./$copy" && g add -- "./$copy" && n=$((n + 1))
      git checkout -q "$UPSTREAM" -- "$(git ls-tree -r --name-only -z "$UPSTREAM" | tr '\0' '\n' | grep -Fix -- "$f" | head -1)" 2>>"$LOG"
    done < <(git ls-files -z)
  done < <(git ls-files | tr '[:upper:]' '[:lower:]' | sort | uniq -d)
  [ "$n" -gt 0 ] || return 0
  g commit -qm "notes: $n case clash(es) kept as conflict copies" >>"$LOG" 2>&1
  CONFLICTS="${CONFLICTS:+$CONFLICTS; }$n note(s) differing only in case kept as *.conflict-$ts.*"
}

# Finishes what an interrupted run left: a merge in progress.
recover() {
  if mid_rebase; then
    fail "$DIR is in the middle of a rebase (left by an older version of this hook); nothing was changed. Run 'git rebase --abort' there, then sync again."
    return 1
  fi
  [ -f .git/MERGE_HEAD ] && { resolve_merge 1 || return 1; }
  return 0
}

start() {
  lock || return 1
  [ -n "$UPSTREAM" ] || { fail "$BRANCH has no upstream in $DIR; nothing was synced"; return 1; }
  auth || return 1
  recover || return 1
}
CONFLICTS=""

pull() {
  if [ "$1" = "throttle" ] && [ -f "$STAMP" ] && [ "$(age "$STAMP")" -lt "$PULL_EVERY" ] && [ ! -f .git/MERGE_HEAD ]; then return 0; fi
  start || return 1
  commit_local || return 1
  sync_remote || return 1
  touch "$STAMP"
  # local commits made by the merge or before it go out now, so the remote has the copies
  [ -n "$(git log "$UPSTREAM..HEAD" --oneline 2>/dev/null)" ] && { git push -q >>"$LOG" 2>&1 || fail "push failed in $DIR (see $LOG)"; }
  report
}

push() {
  start || return 1
  commit_local || return 1
  # nothing committed locally that the remote lacks: no network call at all
  [ -n "$(git log "$UPSTREAM..HEAD" --oneline 2>/dev/null)" ] || return 0
  sync_remote || return 1
  git push -q >>"$LOG" 2>&1 || { fail "push failed in $DIR (see $LOG); the next sync retries"; return 1; }
  touch "$STAMP"
  report
}

# exit 1 after a conflict, so Claude Code shows it
report() { [ -z "$CONFLICTS" ] || fail "the remote changed the same notes; kept the remote version, $CONFLICTS"; }

case "$1" in
  pull) pull ;;
  pull-throttle) pull throttle ;;
  push) push ;;
esac || exit 1
exit 0
