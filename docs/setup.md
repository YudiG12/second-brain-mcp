# Setup

How to recreate the infrastructure from this repo ([ADR 006](adr/006-wrangler-and-a-setup-script-instead-of-terraform.md)).

## Requirements
- Node 24 or later (`.nvmrc`), then `npm ci`.
- `npx wrangler login` with access to the Cloudflare account in `wrangler.jsonc`.

## Steps
Order matters: the notes must be in Artifacts before any deploy that reads from it, or the server lists no notes and the first MCP write starts a separate history.

1. **Resources:** `scripts/setup.sh`. Creates what is missing (Vectorize index, Artifacts repo `notes`, D1 database and its migrations, the `index-jobs` queues and the Artifacts push subscription) and is safe to run again. A new D1 database prints an id that goes in `wrangler.jsonc`. Changing an existing Workers subdomain is a dashboard step; the script stops and says so.
2. **Notes:** push the full history into the Artifacts repo once, from a clone: `git push <remote> main`, with a token from `npx wrangler artifacts repos issue-token notes --namespace second-brain --scope write`. Then point the Mac clone at it: `git remote set-url origin <remote>`.
3. **Deploy:** `npx wrangler deploy` the first time (the Worker must exist before it has secrets). After that, merges to `main` deploy through CI.
4. **Secrets:**
   - `scripts/secrets.sh rotate`: new `MCP_TOKEN`, saved to `.dev.vars` (gitignored) first, then to the Worker. It asks for confirmation, since every client must reconnect.
   - `scripts/secrets.sh admin`: new `ADMIN_SECRET`, saved to the Worker, `.dev.vars` and the macOS Keychain (the Mac sync hook reads it there).
5. **Index:** start a rebuild once: `POST /admin/reconcile?mode=rebuild` with `Authorization: Bearer <ADMIN_SECRET>`. It enqueues every note. After that, the daily reconciliation keeps the index in line.
6. **Clients:** reconnect each MCP client to `https://second-brain-mcp.yudiganeko.workers.dev/<MCP_TOKEN>/mcp`.

## CI deploy
The `deploy` job in `.github/workflows/ci.yml` runs on pushes to `main` after the tests. It applies D1 migrations, then deploys. It needs a repository secret `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with the **Edit Cloudflare Workers** template plus **D1: Edit** and **Queues: Edit**, limited to this account. Set it with `gh secret set CLOUDFLARE_API_TOKEN`.

## Related
- [ADR 006](adr/006-wrangler-and-a-setup-script-instead-of-terraform.md)
- [Spec v2](spec/v2.md), §8
