#!/bin/bash
# Lê o token do GitHub do clipboard, testa no repositório e só então manda pro Worker.
cd "$(dirname "$0")"
T=$(pbpaste | tr -d '[:space:]')
case "$T" in github_pat_*|ghp_*) ;; *) echo "O clipboard não tem um token do GitHub (deveria começar com github_pat_). Copie o token e rode de novo."; exit 1;; esac
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" https://api.github.com/repos/YudiG12/segundo-cerebro/contents/)
[ "$code" = 200 ] || { echo "GitHub recusou o token (HTTP $code). Confira o acesso ao repositório segundo-cerebro e a permissão Contents."; exit 1; }
printf '%s' "$T" | npx wrangler secret put GITHUB_TOKEN 2>&1 | tail -1
pbcopy </dev/null
echo "Token ok e salvo no Worker. Clipboard limpo."
