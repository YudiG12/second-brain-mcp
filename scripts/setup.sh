#!/usr/bin/env bash
# Creates every Cloudflare resource the Worker needs. Idempotent: safe to run again.
# Usage: scripts/setup.sh   (needs `npx wrangler login`, or CLOUDFLARE_API_TOKEN)
set -euo pipefail
cd "$(dirname "$0")/.."

# every value comes from wrangler.jsonc, the one file to edit for your own deployment
cfg() { node scripts/config.mjs "$@"; }
cfg check >/dev/null
ACCOUNT_ID=$(cfg account_id)
SUBDOMAIN=$(cfg subdomain)
INDEX=$(cfg VECTORIZE_INDEX)
NAMESPACE=$(cfg namespace)
NOTES_REPO=$(cfg NOTES_REPO)
DB=$(cfg d1)
QUEUE=$(cfg queue)
DLQ=$(cfg dlq)

wr() { npx --no-install wrangler "$@"; }
api() { # Cloudflare API with the same credentials Wrangler uses; the token goes through stdin, never argv
  local token; token="${CLOUDFLARE_API_TOKEN:-$(wr auth token --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')}"
  printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -sS --config - -H "Content-Type: application/json" "$@"
}

echo "== Vectorize index $INDEX"
if wr vectorize get "$INDEX" >/dev/null 2>&1; then
  echo "ok: exists"
else
  wr vectorize create "$INDEX" --dimensions 1024 --metric cosine
fi

echo "== Artifacts repo $NAMESPACE/$NOTES_REPO"
if wr artifacts repos get "$NOTES_REPO" --namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "ok: exists"
else
  wr artifacts repos create "$NOTES_REPO" --namespace "$NAMESPACE" >/dev/null
  echo "ok: created (empty; push the notes' history into it, see docs/setup.md)"
fi

echo "== D1 database $DB"
# by name through the API: `d1 info` would use the database_id in wrangler.jsonc, which on a fresh
# copy belongs to someone else's account
d1_id() { wr d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).find(d=>d.name===process.argv[1]);console.log(d?d.uuid:"")})' "$DB"; }
id=$(d1_id)
[ -n "$id" ] && echo "ok: exists" || { wr d1 create "$DB" >/dev/null; id=$(d1_id); [ -n "$id" ] || { echo "could not create D1 database $DB"; exit 1; }; echo "ok: created"; }
cfg set d1_id "$id"
wr d1 migrations apply "$DB" --remote >/dev/null && echo "ok: migrations applied"

# OAuth grants live here. The namespace is named after this Worker, never a generic OAUTH_KV that
# another OAuth Worker in the same account could be using; an id already in wrangler.jsonc that
# exists in this account is kept.
KV="$(cfg name)-oauth"
echo "== KV namespace for OAuth"
kv_list=$(wr kv namespace list)
kv_find() { printf '%s' "$kv_list" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).find(n=>n[process.argv[1]]===process.argv[2]);console.log(n?n.id:"")})' "$1" "$2"; }
id=$(kv_find id "$(cfg kv_id)")
[ -n "$id" ] || id=$(kv_find title "$KV")
if [ -n "$id" ]; then echo "ok: exists"; else
  wr kv namespace create "$KV" >/dev/null; kv_list=$(wr kv namespace list); id=$(kv_find title "$KV")
  [ -n "$id" ] || { echo "could not create KV namespace $KV"; exit 1; }; echo "ok: created $KV"
fi
cfg set kv_id "$id"

echo "== Queues"
for q in "$QUEUE" "$DLQ"; do
  if wr queues info "$q" >/dev/null 2>&1; then echo "ok: $q exists"; else wr queues create "$q" >/dev/null && echo "ok: $q created"; fi
done

echo "== Push events from $NAMESPACE/$NOTES_REPO to $QUEUE"
if wr queues subscription list "$QUEUE" 2>/dev/null | grep "pushed" | grep -q "$NAMESPACE/$NOTES_REPO"; then echo "ok: subscribed"; else
  wr queues subscription create "$QUEUE" --source artifacts.repo --events pushed --source-namespace "$NAMESPACE" --source-repo-name "$NOTES_REPO" >/dev/null && echo "ok: subscribed"; fi

# Last, because changing it breaks every URL on the old subdomain at once.
echo "== Workers subdomain"
current=$(api "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" | python3 -c 'import json,sys;d=json.load(sys.stdin);print((d.get("result") or {}).get("subdomain") or "")')
if [ "$current" = "$SUBDOMAIN" ]; then
  echo "ok: $SUBDOMAIN.workers.dev"
elif [ -z "$current" ]; then
  api -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" --data "{\"subdomain\":\"$SUBDOMAIN\"}" >/dev/null
  echo "ok: $SUBDOMAIN.workers.dev"
else
  # The API only sets a first subdomain; changing an existing one is done in the dashboard.
  echo "ACTION: change the subdomain from $current to $SUBDOMAIN in the dashboard:"
  echo "  Workers & Pages > Account details > Subdomain > Change (every *.$current.workers.dev URL stops working)"
  exit 1
fi

[ -n "${DEPLOY_YOUR_OWN:-}" ] || echo "Done. Next: push the notes (first time), npx wrangler deploy, then scripts/secrets.sh github-oauth and admin (and hook for a Mac clone). See docs/setup.md."
