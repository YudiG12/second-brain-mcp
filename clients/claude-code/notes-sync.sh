#!/bin/bash
# Keeps the local clone of the notes in sync with GitHub.
# pull: brings in what was saved from the phone or ChatGPT (through the MCP). push: sends what changed here.
DIR="${NOTES_DIR:-$HOME/dev/agentes/cerebro/notas}"
STAMP="$DIR/.git/.last-pull"
cd "$DIR" 2>/dev/null || exit 0
[ -d .git ] || exit 0
export GIT_TERMINAL_PROMPT=0

pull() {
  # on every prompt, at most one pull per minute
  if [ "$1" = "throttle" ] && [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -f %m "$STAMP") )) -lt 60 ]; then return; fi
  git pull --rebase --autostash -q && touch "$STAMP"
}

push() {
  if [ -n "$(git status --porcelain)" ]; then
    n=$(git status --porcelain | wc -l | tr -d ' ')
    git add -A && git commit -qm "notes: $n file(s) via Claude Code, $(date '+%F %H:%M')" || true
  fi
  git pull --rebase --autostash -q || return 1
  [ -n "$(git log @{u}..HEAD --oneline)" ] && git push -q
}

case "$1" in
  pull) pull ;;
  pull-throttle) pull throttle ;;
  push) push ;;
esac
exit 0
