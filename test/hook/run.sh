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

echo "interrupted: killed right after the reset (Mac asleep, hook timeout)"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && git commit -qam phone && git push -q)
printf 'mac\n' > "$T/mac/ideias/a.md"; printf 'only here\n' > "$T/mac/ideias/only-local.md"
NOTES_SYNC_TEST_DIE_AFTER_RESET=1 bash "$HOOK" push 2>/dev/null
check "the local version is kept in refs/notes-sync/pending" 'git -C "$T/mac" rev-parse -q --verify refs/notes-sync/pending >/dev/null'
bash "$HOOK" push 2>/dev/null
check "the next run finishes the restore: only-local note reaches the remote" '[ "$(remote_file ideias/only-local.md)" = "only here" ]'
check "and the conflict copy" 'git -C "$T/remote.git" ls-tree -r --name-only main | grep -q "a.conflict"'
check "the pending ref is cleared" '! git -C "$T/mac" rev-parse -q --verify refs/notes-sync/pending >/dev/null'

echo "interrupted: left in the middle of a rebase, then more edits"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && git commit -qam phone && git push -q)
(cd "$T/mac" && printf 'mac\n' > ideias/a.md && git commit -qam mac && git pull --rebase -q >/dev/null 2>&1)
printf 'written after\n' > "$T/mac/ideias/after.md"
bash "$HOOK" push 2>/dev/null
check "recovers the clone from the stopped rebase" '[ ! -d "$T/mac/.git/rebase-merge" ] && [ ! -d "$T/mac/.git/rebase-apply" ]'
check "the note written afterwards reaches the remote" '[ "$(remote_file ideias/after.md)" = "written after" ]'
check "the stopped commit's version is kept as a copy" 'git -C "$T/remote.git" ls-tree -r --name-only main | grep -q "a.conflict"'
check "no conflict markers reach the remote" '! git -C "$T/remote.git" grep -q "<<<<<<<" main'

echo "an edit made while the conflict is being resolved"
setup
(cd "$T/other" && printf 'phone\n' > ideias/a.md && printf 'b\n' > ideias/b.md && git add -A && git commit -qm phone && git push -q)
bash "$HOOK" pull 2>/dev/null
(cd "$T/other" && printf 'phone 2\n' > ideias/a.md && git commit -qam phone2 && git push -q)
printf 'mac\n' > "$T/mac/ideias/a.md"
NOTES_SYNC_TEST_BEFORE_ABORT='printf "edited meanwhile\n" > ideias/b.md' bash "$HOOK" push 2>/dev/null
check "the edit is not wiped by the reset" '[ "$(remote_file ideias/b.md)" = "edited meanwhile" ] || [ "$(cat "$T/mac/ideias/b.md")" = "edited meanwhile" ]'

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
check "a file/folder clash fails loudly and keeps the local version" '[ $code = 1 ] && git -C "$T/mac" rev-parse -q --verify refs/notes-sync/pending >/dev/null && git -C "$T/mac" show refs/notes-sync/pending:proj/n.md | grep -q n'
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
