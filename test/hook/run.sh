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

echo "busy lock"
setup
mkdir "$T/mac/.git/notes-sync.lock" && echo $$ > "$T/mac/.git/notes-sync.lock/pid"
NOTES_SYNC_LOCK_WAIT=1 bash "$HOOK" push 2>"$T/err"; code=$?
check "a skip is visible, not silent" '[ $code = 1 ] && grep -q "skipped" "$T/err" && grep -q "skipped" "$HOME/.claude/notes-sync.log"'
rm -rf "$T/mac/.git/notes-sync.lock"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
