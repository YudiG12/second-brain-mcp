#!/usr/bin/env bash
# Creates every Cloudflare resource the Worker needs. Idempotent: safe to run again.
# Usage: scripts/setup.sh   (needs `npx wrangler login`, or CLOUDFLARE_API_TOKEN)
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT_ID="337de6b8e4de301a53ecae0c06afcc72"
SUBDOMAIN="yudiganeko"
INDEX="second-brain"

wr() { npx --no-install wrangler "$@"; }
api() { # Cloudflare API with the same credentials Wrangler uses; the token is never printed
  local token; token="${CLOUDFLARE_API_TOKEN:-$(wr auth token --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')}"
  curl -fsS -H "Authorization: Bearer $token" -H "Content-Type: application/json" "$@"
}

echo "== Vectorize index $INDEX"
if wr vectorize get "$INDEX" >/dev/null 2>&1; then
  echo "ok: exists"
else
  wr vectorize create "$INDEX" --dimensions 1024 --metric cosine
fi

# Last, because changing it breaks every URL on the old subdomain at once.
echo "== Workers subdomain"
current=$(api "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["subdomain"])')
if [ "$current" = "$SUBDOMAIN" ]; then
  echo "ok: $SUBDOMAIN.workers.dev"
elif [ -z "$current" ] || [ "$current" = "None" ]; then
  api -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" --data "{\"subdomain\":\"$SUBDOMAIN\"}" >/dev/null
  echo "ok: $SUBDOMAIN.workers.dev"
else
  # The API only sets a first subdomain; changing an existing one is done in the dashboard.
  echo "ACTION: change the subdomain from $current to $SUBDOMAIN in the dashboard:"
  echo "  Workers & Pages > Account details > Subdomain > Change (every *.$current.workers.dev URL stops working)"
  exit 1
fi

echo "Done. Next: scripts/secrets.sh, then npx wrangler deploy (or merge to main)."
