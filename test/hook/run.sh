#!/usr/bin/env bash
# Tests for clients/claude-code/notes-sync.sh against real Git repositories (a local bare repo as
# the remote, so no network and no auth). Run: bash test/hook/run.sh
set -uo pipefail
HOOK="$(cd "$(dirname "$0")/../.." && pwd)/clients/claude-code/notes-sync.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export NOTES_SYNC_NO_AUTH=1 HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig"
mkdir -p "$HOME/.claude"
git config --global user.email t@t; git config --global user.name t; git config --global init.defaultBranch main
pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
ko() { echo "  ✗ $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }

setup() {
  rm -rf "$T/remote.git" "$T/mac" "$T/other"
  git init -q --bare "$T/remote.git"
  git clone -q "$T/remote.git" "$T/other" 2>/dev/null
  (cd "$T/other" && mkdir -p ideias && printf 'one\n' > ideias/a.md && git add -A && git commit -qm seed && git push -q origin main)
  git clone -q "$T/remote.git" "$T/mac"
  export NOTES_DIR="$T/mac"
}
remote_file() { git -C "$T/remote.git" show "main:$1" 2>/dev/null; }

echo "push and pull"
setup
printf 'from the mac\n' > "$T/mac/ideias/b.md"
bash "$HOOK" push; code=$?
check "push exits 0" '[ $code = 0 ]'
check "the new note reached the remote" '[ "$(remote_file ideias/b.md)" = "from the mac" ]'
(cd "$T/other" && git pull -q && printf 'from the phone\n' > ideias/c.md && git add -A && git commit -qm phone && git push -q)
bash "$HOOK" pull
check "pull brings in a note saved elsewhere" '[ -f "$T/mac/ideias/c.md" ]'

echo "conflict (#15)"
setup
(cd "$T/other" && printf 'changed on the phone\n' > ideias/a.md && git commit -qam phone && git push -q)
printf 'changed on the mac\n' > "$T/mac/ideias/a.md"
bash "$HOOK" push 2>"$T/err"; code=$?
check "exits 1 so Claude Code shows it" '[ $code = 1 ]'
check "says it saved a conflict copy" 'grep -q "conflict" "$T/err"'
check "the remote keeps the phone version" '[ "$(remote_file ideias/a.md)" = "changed on the phone" ]'
copy=$(git -C "$T/remote.git" ls-tree -r --name-only main | grep "ideias/a.conflict-.*\.md" | head -1)
check "the mac version is pushed as a conflict copy" '[ -n "$copy" ] && [ "$(remote_file "$copy")" = "changed on the mac" ]'
check "the clone is not left mid-rebase" '[ ! -d "$T/mac/.git/rebase-merge" ] && [ ! -d "$T/mac/.git/rebase-apply" ]'
printf 'later\n' > "$T/mac/ideias/d.md"
bash "$HOOK" push; code=$?
check "sync keeps working afterwards" '[ $code = 0 ] && [ "$(remote_file ideias/d.md)" = "later" ]'

echo "conflict on names with accents and spaces"
setup
(cd "$T/other" && printf 'base\n' > "ideias/visão.md" && printf 'base\n' > "ideias/minha nota.md" && git add -A && git commit -qm acc && git push -q)
bash "$HOOK" pull
(cd "$T/other" && printf 'phone\n' > "ideias/visão.md" && printf 'phone\n' > "ideias/minha nota.md" && git commit -qam phone && git push -q)
printf 'mac\n' > "$T/mac/ideias/visão.md"; printf 'mac\n' > "$T/mac/ideias/minha nota.md"
bash "$HOOK" push 2>/dev/null
check "accented name: mac version kept as a copy" '[ "$(git -C "$T/remote.git" ls-tree -r --name-only -z main | tr "\0" "\n" | grep -c "conflict")" = 2 ]'
check "accented name: the copies hold the mac text" 'for f in $(git -C "$T/remote.git" ls-tree -r --name-only main | grep -c x); do :; done; git -C "$T/remote.git" ls-tree -r --name-only -z main | tr "\0" "\n" | grep conflict | while IFS= read -r f; do [ "$(remote_file "$f")" = "mac" ] || exit 1; done'

echo "conflict keeps local changes that didn't conflict"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && printf 'remote only\n' > ideias/r.md && git add -A && git commit -qm phone && git push -q)
printf 'mac\n' > "$T/mac/ideias/a.md"; printf 'brand new\n' > "$T/mac/ideias/new.md"
bash "$HOOK" push 2>/dev/null
check "a new local note stays at its own path" '[ "$(remote_file ideias/new.md)" = "brand new" ]'
check "a remote-only change is not copied" '! git -C "$T/remote.git" ls-tree -r --name-only main | grep -q "r.conflict"'
check "only the conflicting note gets a copy" '[ "$(git -C "$T/remote.git" ls-tree -r --name-only main | grep -c conflict)" = 1 ]'

echo "conflict on pull with uncommitted edits"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && git commit -qam phone && git push -q)
printf 'mac, not committed\n' > "$T/mac/ideias/a.md"; printf 'also local\n' > "$T/mac/ideias/u.md"
bash "$HOOK" pull 2>/dev/null; code=$?
check "pull reports the conflict" '[ $code = 1 ]'
check "no conflict markers anywhere" '! grep -rq "<<<<<<<" "$T/mac/ideias" && ! git -C "$T/remote.git" grep -q "<<<<<<<" main'
check "the uncommitted edit survives as a copy" 'ls "$T/mac/ideias" | grep -q "a.conflict" && [ "$(cat "$T/mac"/ideias/a.conflict-*.md)" = "mac, not committed" ]'
check "the other uncommitted note survives" '[ "$(cat "$T/mac/ideias/u.md")" = "also local" ]'
check "no stash left behind" '[ -z "$(git -C "$T/mac" stash list)" ]'

echo "conflict across several local commits"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && git commit -qam phone && git push -q)
(cd "$T/mac" && printf 'mac 1\n' > ideias/a.md && git commit -qam m1 && printf 'b\n' > ideias/b.md && git add -A && git commit -qm m2 && printf 'mac 3\n' > ideias/a.md && git commit -qam m3)
bash "$HOOK" push 2>/dev/null
check "the latest local version is the copy" '[ "$(remote_file "$(git -C "$T/remote.git" ls-tree -r --name-only main | grep a.conflict)")" = "mac 3" ]'
check "the other local commit's note is kept" '[ "$(remote_file ideias/b.md)" = "b" ]'

echo "quiet stdout (hook stdout goes into Claude's context)"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && git commit -qam phone && git push -q)
printf 'mac\n' > "$T/mac/ideias/a.md"
out=$(bash "$HOOK" push 2>/dev/null)
check "nothing on stdout" '[ -z "$out" ]'

echo "interrupted in the middle of resolving a merge (Mac asleep, hook timeout)"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && printf 'phone\n' > ideias/b.md && git add -A && git commit -qm phone && git push -q)
printf 'mac a\n' > "$T/mac/ideias/a.md"; printf 'mac b\n' > "$T/mac/ideias/b.md"; printf 'only here\n' > "$T/mac/ideias/only-local.md"
NOTES_SYNC_TEST_DIE_MID_RESOLVE=1 bash "$HOOK" push 2>/dev/null
printf 'edited after the kill\n' > "$T/mac/ideias/later.md"; printf 'edited too\n' > "$T/mac/ideias/only-local.md"
bash "$HOOK" push 2>/dev/null
check "the next run finishes the merge" '[ ! -f "$T/mac/.git/MERGE_HEAD" ] && [ -z "$(git -C "$T/mac" ls-files -u)" ]'
check "both conflict copies reach the remote" '[ "$(git -C "$T/remote.git" ls-tree -r --name-only main | grep -c conflict)" = 2 ]'
check "edits made after the kill survive" '[ "$(remote_file ideias/later.md)" = "edited after the kill" ] && [ "$(remote_file ideias/only-local.md)" = "edited too" ]'
check "no conflict markers reach the remote" '! git -C "$T/remote.git" grep -q "<<<<<<<" main'

echo "a conflicted note edited after an interrupted merge"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && git commit -qam phone && git push -q)
printf 'mac\n' > "$T/mac/ideias/a.md"
(cd "$T/mac" && git add -A && git commit -qm mac && git fetch -q && git merge -q --no-edit origin/main >/dev/null 2>&1)
printf 'cleaned up by hand\n' > "$T/mac/ideias/a.md"
bash "$HOOK" push 2>/dev/null
check "the edit to the conflicted note is kept" 'git -C "$T/remote.git" grep -q "cleaned up by hand" main'

echo "a hand edit to a note that quotes conflict markers"
setup
(cd "$T/other" && printf 'how git marks a conflict:\n<<<<<<< HEAD\nend: base\n' > ideias/git.md && git add -A && git commit -qm g && git push -q)
bash "$HOOK" pull 2>/dev/null
(cd "$T/other" && printf 'how git marks a conflict:\n<<<<<<< HEAD\nend: phone\n' > ideias/git.md && git commit -qam p && git push -q)
printf 'how git marks a conflict:\n<<<<<<< HEAD\nend: mac\n' > "$T/mac/ideias/git.md"
(cd "$T/mac" && git add -A && git commit -qm mac && git fetch -q && git merge -q --no-edit origin/main >/dev/null 2>&1)
printf 'how git marks a conflict:\n<<<<<<< HEAD\nend: HAND-RESOLVED\n' > "$T/mac/ideias/git.md"
bash "$HOOK" push 2>/dev/null
check "the hand edit is kept" 'git -C "$T/remote.git" grep -q "HAND-RESOLVED" main'

echo "both spellings of a name come from the remote (macOS: one file on disk)"
setup
(cd "$T/other" && printf 'mac-old\n' > ideias/nota.md && git add -A && git commit -qm n && git push -q)
bash "$HOOK" pull 2>/dev/null
# a case-sensitive writer (the Worker) adds Nota.md next to nota.md; plumbing, so it works on macOS too
(cd "$T/other" && h=$(printf 'phone\n' | git hash-object -w --stdin) && git update-index --add --cacheinfo "100644,$h,ideias/Nota.md" && git commit -qm N && git push -q)
bash "$HOOK" pull 2>/dev/null
printf 'y\n' > "$T/mac/ideias/y.md"; bash "$HOOK" push 2>/dev/null
check "a later sync doesn't overwrite one spelling with the other" '[ "$(remote_file ideias/nota.md)" = "mac-old" ] && [ "$(remote_file ideias/Nota.md)" = "phone" ]'

echo "a local commit that can't be made"
setup
printf 'x\n' > "$T/mac/ideias/x.md"; touch "$T/mac/.git/index.lock"
bash "$HOOK" push 2>/dev/null; code=$?
check "fails instead of silently syncing nothing" '[ $code = 1 ]'
rm -f "$T/mac/.git/index.lock"

echo "user git config doesn't break the hook"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && git commit -qam phone && git push -q)
printf 'mac new\n' > "$T/mac/ideias/n.md"
git config --global merge.ff only; git config --global commit.gpgsign true; git config --global user.signingkey nokey
bash "$HOOK" push 2>/dev/null; code=$?
git config --global --unset merge.ff; git config --global --unset commit.gpgsign; git config --global --unset user.signingkey
check "merge.ff=only and commit.gpgsign without a key don't block a sync" '[ $code = 0 ] && [ "$(remote_file ideias/n.md)" = "mac new" ]'

echo "names that differ only in case (one file on macOS)"
setup
(cd "$T/other" && printf 'phone\n' > ideias/Nota.md && git add -A && git commit -qm phone && git push -q)
printf 'mac\n' > "$T/mac/ideias/nota.md"
bash "$HOOK" push 2>/dev/null
printf 'later\n' > "$T/mac/ideias/other.md"; bash "$HOOK" push 2>/dev/null # a later sync must not overwrite one with the other
check "both texts survive on the remote, also after the next sync" 'git -C "$T/remote.git" grep -q "^phone" main && git -C "$T/remote.git" grep -q "^mac" main'

echo "a remote file where the Mac has a folder"
setup
(cd "$T/other" && printf 'a file\n' > proj && git add -A && git commit -qm p && git push -q)
mkdir -p "$T/mac/proj"; printf 'n\n' > "$T/mac/proj/n.md"
bash "$HOOK" push 2>"$T/err"; code=$?
check "is reported as a conflict, and both survive" '[ $code = 1 ] && [ "$(remote_file proj/n.md)" = "n" ] && git -C "$T/remote.git" grep -q "a file" main'

echo "a clone left mid-rebase by an older hook"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && git commit -qam phone && git push -q)
(cd "$T/mac" && printf 'mac\n' > ideias/a.md && git commit -qam mac && git pull --rebase -q >/dev/null 2>&1)
bash "$HOOK" push 2>"$T/err"; code=$?
check "fails loudly and changes nothing" '[ $code = 1 ] && grep -q "rebase" "$T/err" && [ -d "$T/mac/.git/rebase-merge" ]'

echo "several local commits: the newest local version wins"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && git commit -qam phone && git push -q)
(cd "$T/mac" && printf 'mac\n' > ideias/a.md && printf 'v1\n' > ideias/x.md && git add -A && git commit -qm m1 && printf 'v2\n' > ideias/x.md && git commit -qam m2 && printf 'gone\n' > ideias/g.md && git add -A && git commit -qm m3 && git rm -q ideias/g.md && git commit -qm m4)
bash "$HOOK" push 2>/dev/null
check "x.md has the newest local version" '[ "$(remote_file ideias/x.md)" = "v2" ]'
check "a note deleted locally stays deleted" '! git -C "$T/remote.git" cat-file -e main:ideias/g.md 2>/dev/null'

echo "many conflicts finish well within the hook timeout"
setup
(cd "$T/other" && for i in $(seq 1 150); do printf 'base\n' > "ideias/n$i.md"; done && git add -A && git commit -qm many && git push -q)
bash "$HOOK" pull 2>/dev/null
(cd "$T/other" && for i in $(seq 1 150); do printf 'phone\n' > "ideias/n$i.md"; done && git commit -qam phone && git push -q)
for i in $(seq 1 150); do printf 'mac\n' > "$T/mac/ideias/n$i.md"; done
start=$(date +%s); bash "$HOOK" push 2>/dev/null; took=$(( $(date +%s) - start ))
check "150 conflicts resolved in under 10 s (took ${took}s)" '[ "$took" -lt 10 ] && [ "$(git -C "$T/remote.git" ls-tree -r --name-only main | grep -c conflict)" = 150 ]'

echo "an edit made while the conflict is being resolved"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && printf 'b\n' > ideias/b.md && git add -A && git commit -qm phone && git push -q)
bash "$HOOK" pull 2>/dev/null
(cd "$T/other" && printf 'phone 2\n' > ideias/a.md && git commit -qam phone2 && git push -q)
printf 'mac\n' > "$T/mac/ideias/a.md"
NOTES_SYNC_TEST_DURING_RESOLVE='printf "edited meanwhile\n" > ideias/b.md' bash "$HOOK" push 2>/dev/null
check "the edit is not wiped" '[ "$(remote_file ideias/b.md)" = "edited meanwhile" ] || [ "$(cat "$T/mac/ideias/b.md")" = "edited meanwhile" ]'

echo "odd names and clashes"
setup
(cd "$T/other" && printf 'base\n' > ./-nota.md && git add -A && git commit -qm d && git push -q)
bash "$HOOK" pull 2>/dev/null
(cd "$T/other" && printf 'phone\n' > ./-nota.md && git commit -qam p && git push -q)
printf 'mac\n' > "$T/mac/-nota.md"
bash "$HOOK" push 2>/dev/null
check "a name starting with a dash keeps the local version" 'git -C "$T/remote.git" ls-tree -r --name-only main | grep -q -- "-nota.conflict"'
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && printf 'a file\n' > proj && git add -A && git commit -qm p && git push -q)
printf 'mac\n' > "$T/mac/ideias/a.md"; mkdir -p "$T/mac/proj"; printf 'n\n' > "$T/mac/proj/n.md"
bash "$HOOK" push 2>"$T/err"; code=$?
check "a file/folder clash loses nothing: both versions reach the remote" '[ "$(remote_file proj/n.md)" = "n" ] && git -C "$T/remote.git" ls-tree -r --name-only main | grep -q "^proj~"'
setup
(cd "$T/other" && printf 'phone\n' > ideias/img.png && git add -A && git commit -qm p && git push -q)
printf 'mac\n' > "$T/mac/ideias/img.png"
bash "$HOOK" push 2>/dev/null
check "a non-Markdown conflict copy keeps its extension" 'git -C "$T/remote.git" ls-tree -r --name-only main | grep -q "img.conflict-.*\.png$"'

echo "no upstream"
setup
git -C "$T/mac" branch -q --unset-upstream
printf 'x\n' > "$T/mac/ideias/x.md"
bash "$HOOK" push 2>/dev/null; code=$?
check "fails instead of silently not pushing" '[ $code = 1 ]'

echo "concurrent sessions (#16)"
setup
for i in 1 2 3 4; do printf "n$i\n" > "$T/mac/ideias/p$i.md"; done
bash "$HOOK" push & bash "$HOOK" push & bash "$HOOK" push & wait
check "no index.lock left behind" '[ ! -f "$T/mac/.git/index.lock" ]'
check "all notes reached the remote" '[ "$(git -C "$T/remote.git" ls-tree -r --name-only main | grep -c "ideias/p")" = 4 ]'
check "the lock is released" '[ ! -d "$T/mac/.git/notes-sync.lock" ]'

echo "stale lock"
setup
mkdir "$T/mac/.git/notes-sync.lock" && echo 999999 > "$T/mac/.git/notes-sync.lock/pid"
printf 'x\n' > "$T/mac/ideias/s.md"
bash "$HOOK" push; code=$?
check "a lock whose process is gone is taken over" '[ $code = 0 ] && [ "$(remote_file ideias/s.md)" = "x" ]'

echo "a long-running live owner keeps its lock"
setup
mkdir "$T/mac/.git/notes-sync.lock" && echo $$ > "$T/mac/.git/notes-sync.lock/pid" && touch -t 202001010000 "$T/mac/.git/notes-sync.lock"
NOTES_SYNC_LOCK_WAIT=1 bash "$HOOK" push 2>/dev/null; code=$?
check "an old lock whose pid is alive is not taken over" '[ $code = 1 ] && [ "$(cat "$T/mac/.git/notes-sync.lock/pid")" = "$$" ]'
rm -rf "$T/mac/.git/notes-sync.lock"

echo "busy lock"
setup
mkdir "$T/mac/.git/notes-sync.lock" && echo $$ > "$T/mac/.git/notes-sync.lock/pid"
NOTES_SYNC_LOCK_WAIT=1 bash "$HOOK" push 2>"$T/err"; code=$?
check "a skip is visible, not silent" '[ $code = 1 ] && grep -q "skipped" "$T/err" && grep -q "skipped" "$HOME/.claude/notes-sync.log"'
rm -rf "$T/mac/.git/notes-sync.lock"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
