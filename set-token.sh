#!/bin/bash
# Reads the GitHub token from the clipboard, tests it against the notes repo, and only then sends it to the Worker.
cd "$(dirname "$0")"
T=$(pbpaste | tr -d '[:space:]')
case "$T" in github_pat_*|ghp_*) ;; *) echo "The clipboard does not hold a GitHub token (it should start with github_pat_). Copy the token and run again."; exit 1;; esac
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" https://api.github.com/repos/YudiG12/segundo-cerebro/contents/)
[ "$code" = 200 ] || { echo "GitHub rejected the token (HTTP $code). Check access to the segundo-cerebro repo and the Contents permission."; exit 1; }
printf '%s' "$T" | npx wrangler secret put GITHUB_TOKEN 2>&1 | tail -1
pbcopy </dev/null
echo "Token OK and saved to the Worker. Clipboard cleared."
