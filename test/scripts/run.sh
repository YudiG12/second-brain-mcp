#!/usr/bin/env bash
# Tests for scripts/config.mjs, the one place the scripts read the deployment's settings from.
# Run: bash test/scripts/run.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFG="$ROOT/scripts/config.mjs"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
ko() { echo "  ✗ $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }
get() { WRANGLER_CONFIG="$T/w.jsonc" node "$CFG" "$1" 2>"$T/err"; }

cat > "$T/w.jsonc" <<'J'
{
  // a comment with a URL: https://example.com
  "account_id": "abc123", /* block comment */
  "vars": { "PUBLIC_URL": "https://my-brain.alice.workers.dev", "NOTES_REPO": "notes", "VECTORIZE_INDEX": "idx", },
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "ns" }],
}
J
echo "reads wrangler.jsonc"
check "account_id" '[ "$(get account_id)" = abc123 ]'
check "PUBLIC_URL, with // inside the string" '[ "$(get PUBLIC_URL)" = "https://my-brain.alice.workers.dev" ]'
check "the Workers subdomain comes from PUBLIC_URL" '[ "$(get subdomain)" = alice ]'
check "the Worker name comes from PUBLIC_URL" '[ "$(get worker)" = my-brain ]'
check "NOTES_REPO, VECTORIZE_INDEX and the Artifacts namespace" '[ "$(get NOTES_REPO) $(get VECTORIZE_INDEX) $(get namespace)" = "notes idx ns" ]'
check "an unknown key fails" '! get nope >/dev/null && grep -q nope "$T/err"'
sed -i.bak 's#https://my-brain.alice.workers.dev#https://brain.example.com#' "$T/w.jsonc"
check "a custom domain has no workers.dev subdomain: fails with a message" '! get subdomain >/dev/null && grep -qi "workers.dev" "$T/err"'
echo "the repo's own config"
check "parses" 'node "$CFG" PUBLIC_URL >/dev/null'

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
