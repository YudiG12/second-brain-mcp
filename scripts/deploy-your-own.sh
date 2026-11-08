#!/usr/bin/env bash
# Deploys your own Second Brain MCP to your Cloudflare account, end to end. Safe to run again.
# Usage: npm run deploy-your-own [-- --name <worker> --github-user <login> --client-id <id>
#                                    --notes starter|<folder> --account <id> --subdomain <name>]
# Needs: a Cloudflare account on the Workers Paid plan (Artifacts requires it), Node 24+, git.
# In a terminal it asks for whatever the flags don't give. Without one (an AI agent running it) it
# never waits for input: when something is missing it prints a "NEEDS:" line and exits 2, and the
# steps only a person can do (signing in to Cloudflare, creating the GitHub OAuth app, typing the
# client secret into Wrangler's hidden prompt) are printed as instructions. The client secret never
# passes through the agent. Re-run after each one; finished steps are skipped.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
export DEPLOY_YOUR_OWN=1

A_NAME="" A_GH="" A_CID="" A_NOTES="" A_ACCOUNT="" A_SUB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) A_NAME=$2;; --github-user) A_GH=$2;; --client-id) A_CID=$2;; --notes) A_NOTES=$2;;
    --account) A_ACCOUNT=$2;; --subdomain) A_SUB=$2;;
    *) echo "unknown option: $1"; exit 1;;
  esac; shift 2
done
TTY=""; { [ -t 0 ] && : </dev/tty; } 2>/dev/null && TTY=1

wr() { npx --no-install wrangler "$@"; }
cfg() { node scripts/config.mjs "$@"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=new Function("j","return "+process.argv[1])(JSON.parse(s));console.log(v??"")})' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }
need() { printf 'NEEDS: %s\n' "$*"; exit 2; }   # for agents: what to ask the person, then re-run
# ask <prompt> <default> <flag>: the flag's value, else a terminal prompt, else the default, else NEEDS
ask() {
  local a=""
  if [ -n "$TTY" ]; then read -r -p "  $1${2:+ [$2]}: " a </dev/tty; printf '%s' "${a:-${2:-}}"
  elif [ -n "${2:-}" ]; then printf '%s' "$2"
  else need "$3 ($1)"; fi
}
yes() { [ -z "$TTY" ] && { [ "$2" = y ]; return; }; case "$(ask "$1 (y/n)" "$2")" in [nN]*) return 1;; *) return 0;; esac; }
api() { # Cloudflare API with Wrangler's credentials; the token goes through stdin, never argv
  local t; t=$(wr auth token --json 2>/dev/null | json j.token)
  [ -n "$t" ] || die "no API token from Wrangler (sign in with 'npx wrangler login', or set CLOUDFLARE_API_TOKEN)"
  printf 'header = "Authorization: Bearer %s"\n' "$t" | curl -sS --config - -H "Content-Type: application/json" "$@"
}
open_url() { (open "$1" || xdg-open "$1") >/dev/null 2>&1 || true; }
tmp=""; trap '[ -z "$tmp" ] || rm -rf "$tmp"' EXIT

step "1/7 Cloudflare"
if ! wr whoami --json >/dev/null 2>&1; then
  [ -n "$TTY" ] || need "a person signs in to Cloudflare: run 'npx wrangler login' in a terminal in $(pwd) and approve in the browser"
  wr login
fi
who=$(wr whoami --json)
n=$(printf '%s' "$who" | json 'j.accounts.length')
i=1
if [ "$n" -gt 1 ]; then
  printf '%s' "$who" | json 'j.accounts.map((a,i)=>`  ${i+1}. ${a.name}`).join("\n")'
  if [ -n "$A_ACCOUNT" ]; then i=$(printf '%s' "$who" | json "j.accounts.findIndex(a=>a.id==='$A_ACCOUNT')+1")
  else [ -n "$TTY" ] || need "--account <id> (this login has $n Cloudflare accounts)"; i=$(ask "Account number" 1); fi
  [[ "$i" =~ ^[0-9]+$ ]] && [ "$i" -ge 1 ] && [ "$i" -le "$n" ] || die "pick a number from 1 to $n"
fi
ACCOUNT=$(printf '%s' "$who" | json "j.accounts[$i-1].id")
ok "signed in as $(printf '%s' "$who" | json j.email), account $ACCOUNT"
SUB=$(api "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/subdomain" | json 'j.result&&j.result.subdomain')
[ -n "$SUB" ] || SUB=${A_SUB:-$(ask "Pick a workers.dev subdomain (yourname.workers.dev)" "" --subdomain)}
[ -n "$SUB" ] || die "a subdomain is needed"
ok "subdomain: $SUB.workers.dev"

step "2/7 Your settings"
NAME=${A_NAME:-$(ask "Worker name" "$(cfg name)" --name)}
if gh api user --jq .id >/dev/null 2>&1; then GH_ID=$(gh api user --jq .id); GH_USER=$(gh api user --jq .login)
else GH_USER=${A_GH:-$(ask "Your GitHub username" "" --github-user)}; GH_ID=$(curl -fsS "https://api.github.com/users/$GH_USER" | json j.id); fi
[ -n "$GH_ID" ] || die "couldn't find the GitHub user $GH_USER"
URL="https://$NAME.$SUB.workers.dev"
# a new deployment (another name or account) gets its own D1, index, notes and queues
if [ "$NAME" != "$(cfg name)" ] || [ "$ACCOUNT" != "$(cfg account_id)" ]; then cfg rename "$NAME"; fi
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
  DIR=${A_NOTES:-$(ask "Folder with your Markdown notes (Enter for a starter note)" starter --notes)}; DIR=${DIR/#\~/$HOME}
  [ "$DIR" = starter ] && DIR=""
  if [ -z "$DIR" ]; then
    tmp=$(mktemp -d); DIR=$tmp
    printf '# Welcome\n\nYour second brain. Ask any connected AI client to save an idea here.\n' > "$DIR/welcome.md"
  fi
  [ -d "$DIR" ] || die "$DIR doesn't exist"
  if top=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null); then
    # an existing repository: push what's committed, never commit the user's pending work
    [ "$top" = "$(cd "$DIR" && pwd -P)" ] || die "$DIR is inside another Git repository ($top); use a folder of its own"
    git -C "$DIR" rev-parse -q --verify HEAD >/dev/null || die "$DIR has no commits yet"
  else
    git -C "$DIR" init -q -b main
    git -C "$DIR" add -A
    git -C "$DIR" -c commit.gpgsign=false -c user.name="${GIT_AUTHOR_NAME:-$GH_USER}" -c user.email="${GIT_AUTHOR_EMAIL:-$GH_ID+$GH_USER@users.noreply.github.com}" commit -qm "First notes"
  fi
  TOKEN=$(wr artifacts repos issue-token "$REPO" --namespace "$NS" --scope write --ttl 600 --json | json j.plaintext)
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $TOKEN" \
    git -C "$DIR" push -q "$REMOTE" HEAD:main
  if [ -n "$tmp" ]; then ok "pushed a starter note"; else ok "pushed $(git -C "$DIR" ls-files | wc -l | tr -d ' ') files from $DIR"; fi
fi

step "5/7 GitHub sign-in app"
HAS_SECRET=""; wr secret list 2>/dev/null | grep -q GITHUB_CLIENT_SECRET && HAS_SECRET=1
NEW_APP=""
if [ -n "$A_CID" ]; then NEW_APP=$A_CID
elif [ -n "$HAS_SECRET" ] && yes "Keep the current GitHub OAuth app?" y; then ok "kept"
else
  echo "  A person creates a GitHub OAuth app at https://github.com/settings/applications/new with:"
  echo "    Application name:            Second Brain MCP"
  echo "    Homepage URL:                $URL"
  echo "    Authorization callback URL:  $URL/callback"
  echo "  then Register application, and Generate a new client secret (keep that page open)."
  [ -n "$TTY" ] && open_url https://github.com/settings/applications/new
  NEW_APP=$(ask "Client ID" "" --client-id)
fi
if [ -n "$NEW_APP" ]; then
  [[ "$NEW_APP" =~ ^[A-Za-z0-9._-]{10,}$ ]] || die "that doesn't look like a client ID"
  [ "$NEW_APP" = "$(cfg GITHUB_CLIENT_ID)" ] || { cfg set GITHUB_CLIENT_ID "$NEW_APP"; HAS_SECRET=""; }
  ok "client ID $NEW_APP"
fi

step "6/7 Deploy"
npm run --silent types >/dev/null
wr deploy >/dev/null
ok "deployed $URL"
if [ -z "$HAS_SECRET" ]; then
  # the client secret goes straight into Wrangler's hidden prompt; it never passes through this script
  if [ -n "$TTY" ]; then echo "  Paste the client secret from the app's page:"; wr secret put GITHUB_CLIENT_SECRET </dev/tty
  else need "a person types the client secret into Wrangler's hidden prompt: run 'npx wrangler secret put GITHUB_CLIENT_SECRET' in a terminal in $(pwd), then re-run"; fi
fi
ok "GitHub client secret is on the Worker"
if grep -q '^ADMIN_SECRET=' .dev.vars 2>/dev/null; then sed -n 's/^ADMIN_SECRET=//p' .dev.vars | tr -d '\n' | wr secret put ADMIN_SECRET >/dev/null
else bash scripts/secrets.sh admin >/dev/null; fi
ok "admin secret saved (Worker and .dev.vars)"

step "7/7 Index"
ADMIN=$(sed -n 's/^ADMIN_SECRET=//p' .dev.vars)
for t in 1 2 3 4 5 6 7 8 9 10; do # a new workers.dev hostname can take a minute to answer
  printf 'header = "Authorization: Bearer %s"\n' "$ADMIN" | curl -fsS --config - -X POST "$URL/admin/reconcile?mode=rebuild" >/dev/null 2>&1 && break
  [ "$t" = 10 ] && die "$URL didn't answer; run again in a minute"
  sleep $((t * 3))
done
ok "rebuild started; search catches up in a minute or two"

printf '\n\033[1mDone.\033[0m Connect a client:\n\n'
printf '  Claude Code:             claude mcp add --transport http second-brain %s/mcp\n' "$URL"
printf '  Claude, ChatGPT, phone:  add a custom connector with %s/mcp\n\n' "$URL"
printf '  Mac sync (optional):     npm run mac-hook\n'
