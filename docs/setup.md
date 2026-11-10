# Setup

`npm run deploy-your-own` runs every step below, in order.

Everything that changes per deployment is in `wrangler.jsonc`: `name`, `account_id`, `vars` (`PUBLIC_URL`, `CF_ACCOUNT_ID`, `OWNER_GITHUB_ID`, `GITHUB_CLIENT_ID`), and the D1 and KV ids, which `scripts/setup.sh` writes itself. The scripts read it through `scripts/config.mjs`; `node scripts/config.mjs check` validates it.

## Requirements
- Node 24 or later (`.nvmrc`), then `npm ci`.
- `npx wrangler login` with access to the Cloudflare account in `wrangler.jsonc`.

## Steps
Order matters: the notes must be in Artifacts before any deploy that reads from it, or the server lists no notes and the first MCP write starts a separate history.

1. **Resources:** `scripts/setup.sh`. Creates what is missing (Vectorize index, Artifacts repo `notes`, D1 database and its migrations, the `index-jobs` queues and the Artifacts push subscription) and is safe to run again. It writes the D1 and KV ids into `wrangler.jsonc` itself. Changing an existing Workers subdomain is a dashboard step; the script stops and says so.
2. **Notes:** push the full history into the Artifacts repo once, from a clone: `git push <remote> main`, with a token from `npx wrangler artifacts repos issue-token "$(node scripts/config.mjs NOTES_REPO)" --namespace "$(node scripts/config.mjs namespace)" --scope write`. After that, write only through MCP ([ADR 014](adr/014-mcp-only-clients.md)): stop pushing from the old clone.
3. **Deploy:** `npx wrangler deploy` the first time (the Worker must exist before it has secrets). After that, merges to `main` deploy through CI.
4. **Secrets:**
   - `scripts/secrets.sh github-oauth` (same as `npx wrangler secret put GITHUB_CLIENT_SECRET`): paste the GitHub OAuth app's client secret into Wrangler's hidden prompt. The app's client id is public and lives in `wrangler.jsonc` (`GITHUB_CLIENT_ID`), with `OWNER_GITHUB_ID`; its callback URL is `<PUBLIC_URL>/callback`.
   - `scripts/secrets.sh admin`: new `ADMIN_SECRET` for the admin routes, saved to the Worker and `.dev.vars`.
   - `scripts/secrets.sh hook`: new `HOOK_SECRET`, which can only issue Artifacts tokens, saved to the Worker, `.dev.vars` and the macOS Keychain (the read-only mirror, `npm run mirror`, reads it there).
5. **Index:** start a rebuild once: `POST /admin/reconcile?mode=rebuild` with `Authorization: Bearer <ADMIN_SECRET>`. It enqueues every note. After that, the daily reconciliation keeps the index in line.
6. **Clients:** add `<PUBLIC_URL>/mcp` as a remote MCP server in each client; it starts the OAuth sign-in (consent page, then GitHub). Every client, Claude Code included, reads and writes only through MCP.
7. **Mirror (optional):** `npm run mirror -- <folder>` keeps a read-only copy for viewing, such as Obsidian's graph view. Run it on a schedule; it resets the folder each time, so never edit there.

## CI deploy
The `deploy` job in `.github/workflows/ci.yml` runs on pushes to `main` after the tests. It applies D1 migrations, then deploys. It needs a repository secret `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with the **Edit Cloudflare Workers** template plus **D1: Edit** and **Queues: Edit**, limited to this account. Set it with `gh secret set CLOUDFLARE_API_TOKEN`.

## Related
- [ADR 006](adr/006-wrangler-and-a-setup-script-instead-of-terraform.md)
- [Spec v2](spec/v2.md), §8
