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
cat > "$T/w.jsonc" <<'J'
﻿{
  "name": "my-brain",
  "account_id": "abc123",
  "vars": { "PUBLIC_URL": "https://my-brain.alice.workers.dev", "CF_ACCOUNT_ID": "abc123", "NOTE": "a \"quoted /* not a comment */ ,}\" text", "subdomain": "shadow" },
  "d1_databases": [{ "database_name": "db1" }],
  "queues": { "producers": [{ "queue": "q1" }], "consumers": [{ "queue": "q1", "dead_letter_queue": "q1-dlq" }] },
}
J
echo "edge cases"
check "a BOM and escaped quotes, /* and ,} inside strings" '[ "$(get NOTE)" = "a \"quoted /* not a comment */ ,}\" text" ]'
check "derived keys aren't shadowed by vars" '[ "$(get subdomain)" = alice ]'
check "a prototype key is not a setting" '! get constructor >/dev/null'
check "the D1 name, the queue and the dead-letter queue" '[ "$(get d1) $(get queue) $(get dlq)" = "db1 q1 q1-dlq" ]'
check "check passes when name, PUBLIC_URL and CF_ACCOUNT_ID agree" 'get check >/dev/null'
sed -i.bak 's#"name": "my-brain"#"name": "other"#' "$T/w.jsonc"
check "check fails when the Worker name differs from PUBLIC_URL" '! get check >/dev/null && grep -q "other" "$T/err"'
sed -i.bak 's#"name": "other"#"name": "my-brain"#; s#"CF_ACCOUNT_ID": "abc123"#"CF_ACCOUNT_ID": "zzz"#' "$T/w.jsonc"
check "check fails when CF_ACCOUNT_ID differs from account_id" '! get check >/dev/null && grep -q "CF_ACCOUNT_ID" "$T/err"'
sed -i.bak 's#https://my-brain.alice.workers.dev#not a url#' "$T/w.jsonc"
check "an invalid PUBLIC_URL fails with a message, not a stack trace" '! get subdomain >/dev/null && grep -q "^config:" "$T/err" && ! grep -q "    at " "$T/err"'
echo "set: writes values, keeps comments"
cp "$ROOT/wrangler.jsonc" "$T/w.jsonc"
put() { WRANGLER_CONFIG="$T/w.jsonc" node "$CFG" set "$1" "$2" 2>"$T/err"; }
check "name" 'put name brain && [ "$(get name)" = brain ]'
check "account_id and CF_ACCOUNT_ID" 'put account_id acc9 && put CF_ACCOUNT_ID acc9 && [ "$(get account_id) $(get CF_ACCOUNT_ID)" = "acc9 acc9" ]'
check "PUBLIC_URL, then the derived subdomain follows" 'put PUBLIC_URL https://brain.bob.workers.dev && [ "$(get subdomain)" = bob ]'
check "OWNER_GITHUB_ID and GITHUB_CLIENT_ID" 'put OWNER_GITHUB_ID 77 && put GITHUB_CLIENT_ID Ov23abc && [ "$(get OWNER_GITHUB_ID) $(get GITHUB_CLIENT_ID)" = "77 Ov23abc" ]'
check "the D1 and KV ids" 'put d1_id d1-uuid && put kv_id kv-id && [ "$(get d1_id) $(get kv_id)" = "d1-uuid kv-id" ]'
check "other settings and the comments survive" '[ "$(get NOTES_REPO)" = notes ] && [ "$(grep -c "//" "$T/w.jsonc")" = "$(grep -c "//" "$ROOT/wrangler.jsonc")" ]'
check "after all of it, check passes" 'get check >/dev/null'
check "an unknown key fails" '! put nope x'
check "a value with a quote is refused" '! put name "a\"b"'
check "an empty value is refused" '! put GITHUB_CLIENT_ID ""'

echo "rename: every resource name follows the deployment's name"
get_orig() { for k in d1 namespace queue dlq; do WRANGLER_CONFIG="$ROOT/wrangler.jsonc" node "$CFG" $k; done | paste -sd"|" -; }
cp "$ROOT/wrangler.jsonc" "$T/w.jsonc"
WRANGLER_CONFIG="$T/w.jsonc" node "$CFG" rename brain-test 2>"$T/err"
check "D1, Vectorize, Artifacts namespace" '[ "$(get d1) $(get VECTORIZE_INDEX) $(get namespace)" = "brain-test brain-test brain-test" ]'
check "the Vectorize binding follows VECTORIZE_INDEX" 'grep -q "\"index_name\": \"brain-test\"" "$T/w.jsonc"'
check "queue and dead-letter queue, in producer and both consumers" '[ "$(get queue) $(get dlq)" = "brain-test-index-jobs brain-test-index-jobs-dlq" ] && [ "$(grep -o "brain-test-index-jobs" "$T/w.jsonc" | wc -l | tr -d " ")" = 4 ] && ! grep -q "\"index-jobs" "$T/w.jsonc"'
check "comments survive" '[ "$(grep -c "//" "$T/w.jsonc")" = "$(grep -c "//" "$ROOT/wrangler.jsonc")" ]'
check "the workflow, whose name is global to the account" 'grep -q "\"name\": \"brain-test-reconcile\"" "$T/w.jsonc"'
check "no account-wide name of the original deployment is left (D1, Vectorize, namespace, queues, workflow)" '! grep -qE "\"(database_name|index_name|namespace|queue|dead_letter_queue|VECTORIZE_INDEX)\": \"($(get_orig))\"" "$T/w.jsonc" && ! grep -q "\"name\": \"reconcile\"" "$T/w.jsonc"'
check "the D1 id, the OAuth KV id and the GitHub client ID are reset: they belong to the original" '[ "$(get d1_id) $(get kv_id) $(get GITHUB_CLIENT_ID)" = "none-yet none-yet none-yet" ]'
check "a bad name is refused" '! WRANGLER_CONFIG="$T/w.jsonc" node "$CFG" rename "Bad Name" 2>/dev/null'

echo "merge-hooks: adds the sync hooks to Claude Code settings"
M="$ROOT/scripts/merge-hooks.mjs"
merge() { node "$M" "$1" 2>"$T/err"; }
rm -f "$T/s.json"; merge "$T/s.json"
check "a missing settings file is created with the three hooks" '[ "$(node -e "const s=require(process.argv[1]);console.log(Object.keys(s.hooks).sort().join())" "$T/s.json")" = "SessionStart,Stop,UserPromptSubmit" ]'
printf '{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}' > "$T/s.json"; merge "$T/s.json"
check "other settings and existing hooks are kept" 'grep -q opus "$T/s.json" && grep -q "say done" "$T/s.json" && grep -q notes-sync "$T/s.json"'
check "a backup of the old file is kept" 'grep -q "say done" "$T/s.json.bak" && ! grep -q notes-sync "$T/s.json.bak"'
merge "$T/s.json"
check "running it twice adds nothing" '[ "$(grep -o "notes-sync.sh" "$T/s.json" | wc -l | tr -d " ")" = 3 ]'
printf '{ // a comment\n "model": "opus" }' > "$T/s.json"; cp "$T/s.json" "$T/orig.json"
check "a file it can't parse is left alone, with a clear message" '! merge "$T/s.json" && cmp -s "$T/s.json" "$T/orig.json" && grep -q "can.t parse" "$T/err" && ! grep -q "    at " "$T/err"'

echo "deploy-your-own without a terminal (an agent running it)"
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/npx"; chmod +x "$T/bin/npx"
out=$(PATH="$T/bin:$PATH" bash "$ROOT/scripts/deploy-your-own.sh" --name x </dev/null 2>&1); code=$?
check "not signed in: exits 2 with a NEEDS line, never waits" '[ $code = 2 ] && printf "%s" "$out" | grep -q "^NEEDS: .*wrangler login"'
printf '#!/bin/sh\ncase "$*" in *whoami*) echo "{\\"email\\":\\"a@b\\",\\"accounts\\":[{\\"id\\":\\"acc\\",\\"name\\":\\"A\\"}]}";; *"auth token"*) echo "{\\"token\\":\\"t\\"}";; *) exit 1;; esac\n' > "$T/bin/npx"
printf '#!/bin/sh\ncat >/dev/null; echo "{\\"result\\":{\\"subdomain\\":\\"alice\\"}}"\n' > "$T/bin/curl"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/gh"; chmod +x "$T/bin/curl" "$T/bin/gh"
cp "$ROOT/wrangler.jsonc" "$T/before.jsonc"
out=$(PATH="$T/bin:$PATH" bash "$ROOT/scripts/deploy-your-own.sh" --name x </dev/null 2>&1); code=$?
check "a missing flag behind \$(ask ...): the NEEDS line still shows and it exits 2" '[ $code = 2 ] && printf "%s" "$out" | grep -q "^NEEDS: --github-user"'
check "and it stopped before touching wrangler.jsonc" 'cmp -s "$T/before.jsonc" "$ROOT/wrangler.jsonc"'
rm -f "$T/bin/curl" "$T/bin/gh"
check "the closing hint uses the Worker name and user scope" 'grep -q "claude mcp add -s user --transport http %s" "$ROOT/scripts/deploy-your-own.sh"'
check "setup.sh passes every argument to config.mjs" 'grep -q "^cfg() { node scripts/config.mjs \"\$@\"; }" "$ROOT/scripts/setup.sh"'
check "an unknown option is refused" '! bash "$ROOT/scripts/deploy-your-own.sh" --nope 1 </dev/null >/dev/null 2>&1'

echo "the repo's own config"
check "parses" 'node "$CFG" PUBLIC_URL >/dev/null'

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
