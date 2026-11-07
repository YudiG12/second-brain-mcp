#!/usr/bin/env bash
# Deploys your own Second Brain MCP to your Cloudflare account, end to end. Safe to run again.
# Usage: npm run deploy-your-own
# Needs: a Cloudflare account on the Workers Paid plan (Artifacts requires it), Node 24+, git.
# Asks for: the Worker name (Enter for the default), your GitHub username if `gh` isn't signed in,
# the GitHub OAuth app's client ID and secret, and a notes folder (Enter for a starter note).
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

wr() { npx --no-install wrangler "$@"; }
cfg() { node scripts/config.mjs "$@"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=new Function("j","return "+process.argv[1])(JSON.parse(s));console.log(v??"")})' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
ask() { local a; read -r -p "  $1${2:+ [$2]}: " a </dev/tty; printf '%s' "${a:-${2:-}}"; }
api() { # Cloudflare API with Wrangler's credentials; the token goes through stdin, never argv
  local t; t=$(wr auth token --json 2>/dev/null | json j.token)
  printf 'header = "Authorization: Bearer %s"\n' "$t" | curl -sS --config - -H "Content-Type: application/json" "$@"
}
open_url() { (open "$1" || xdg-open "$1") >/dev/null 2>&1 || true; }

step "1/7 Cloudflare"
wr whoami --json >/dev/null 2>&1 || wr login
who=$(wr whoami --json)
n=$(printf '%s' "$who" | json 'j.accounts.length')
if [ "$n" -gt 1 ]; then
  printf '%s' "$who" | json 'j.accounts.map((a,i)=>`  ${i+1}. ${a.name}`).join("\n")'
  i=$(ask "Account number" 1)
else i=1; fi
ACCOUNT=$(printf '%s' "$who" | json "j.accounts[$i-1].id")
ok "signed in as $(printf '%s' "$who" | json j.email), account $ACCOUNT"
SUB=$(api "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/subdomain" | json 'j.result&&j.result.subdomain')
[ -n "$SUB" ] || SUB=$(ask "Pick a workers.dev subdomain (yourname.workers.dev)")
ok "subdomain: $SUB.workers.dev"

step "2/7 Your settings"
NAME=$(ask "Worker name" "$(cfg name)")
if gh api user --jq .id >/dev/null 2>&1; then GH_ID=$(gh api user --jq .id); GH_USER=$(gh api user --jq .login)
else GH_USER=$(ask "Your GitHub username"); GH_ID=$(curl -fsS "https://api.github.com/users/$GH_USER" | json j.id); fi
URL="https://$NAME.$SUB.workers.dev"
cfg set name "$NAME"; cfg set account_id "$ACCOUNT"; cfg set CF_ACCOUNT_ID "$ACCOUNT"
cfg set PUBLIC_URL "$URL"; cfg set OWNER_GITHUB_ID "$GH_ID"
ok "$URL, owner: $GH_USER ($GH_ID)"

step "3/7 Resources"
bash scripts/setup.sh | sed 's/^/  /'

step "4/7 Notes"
REPO=$(cfg NOTES_REPO); NS=$(cfg namespace)
repo=$(wr artifacts repos get "$REPO" --namespace "$NS" --json)
REMOTE=$(printf '%s' "$repo" | json '(j.result||j).remote')
if [ -n "$(printf '%s' "$repo" | json '(j.result||j).last_push_at')" ]; then ok "already has notes"
else
  DIR=$(ask "Folder with your Markdown notes (Enter for a starter note)")
  if [ -z "$DIR" ]; then
    DIR=$(mktemp -d); printf '# Welcome\n\nYour second brain. Ask any connected AI client to save an idea here.\n' > "$DIR/welcome.md"
  fi
  DIR=${DIR/#\~/$HOME}
  [ -d "$DIR/.git" ] || git -C "$DIR" init -q -b main
  git -C "$DIR" add -A && { git -C "$DIR" diff --cached --quiet || git -C "$DIR" -c commit.gpgsign=false commit -qm "First notes"; }
  TOKEN=$(wr artifacts repos issue-token "$REPO" --namespace "$NS" --scope write --ttl 600 --json | json j.plaintext)
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $TOKEN" \
    git -C "$DIR" push -q "$REMOTE" HEAD:main
  ok "pushed $(git -C "$DIR" ls-files | wc -l | tr -d ' ') files from $DIR"
fi

step "5/7 GitHub sign-in"
if wr secret list 2>/dev/null | grep -q GITHUB_CLIENT_SECRET && [ "$(ask "Keep the current GitHub OAuth app? (Y/n)" Y)" != n ]; then
  ok "kept"
else
  echo "  Create an OAuth app (opening https://github.com/settings/applications/new):"
  echo "    Application name:            Second Brain MCP"
  echo "    Homepage URL:                $URL"
  echo "    Authorization callback URL:  $URL/callback"
  echo "  Then Register application → Generate a new client secret."
  open_url https://github.com/settings/applications/new
  cfg set GITHUB_CLIENT_ID "$(ask "Client ID")"
  read -r -s -p "  Client secret (hidden): " SECRET </dev/tty; echo
  [[ "$SECRET" =~ ^[0-9a-f]{40}$ ]] || { echo "  That isn't a client secret (40 hex characters). Run again."; exit 1; }
fi

step "6/7 Deploy"
npm run --silent types >/dev/null
wr deploy >/dev/null && ok "deployed $URL"
[ -n "${SECRET:-}" ] && { printf '%s' "$SECRET" | wr secret put GITHUB_CLIENT_SECRET >/dev/null; ok "GitHub client secret saved"; unset SECRET; }
if grep -q '^ADMIN_SECRET=' .dev.vars 2>/dev/null; then sed -n 's/^ADMIN_SECRET=//p' .dev.vars | tr -d '\n' | wr secret put ADMIN_SECRET >/dev/null
else bash scripts/secrets.sh admin >/dev/null; fi
ok "admin secret saved (Worker and .dev.vars)"

step "7/7 Index"
ADMIN=$(sed -n 's/^ADMIN_SECRET=//p' .dev.vars)
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN" | curl -fsS --config - -X POST "$URL/admin/reconcile?mode=rebuild" >/dev/null
ok "rebuild started; search catches up in a minute or two"

printf '\n\033[1mDone.\033[0m Connect a client:\n\n'
printf '  Claude Code:             claude mcp add --transport http second-brain %s/mcp\n' "$URL"
printf '  Claude, ChatGPT, phone:  add a custom connector with %s/mcp\n\n' "$URL"
printf '  Mac sync (optional):     npm run mac-hook\n'
