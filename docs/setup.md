# Setup

How to recreate the infrastructure from this repo ([ADR 006](adr/006-wrangler-and-a-setup-script-instead-of-terraform.md)).

## Requirements
- Node 24 or later (`.nvmrc`), then `npm ci`.
- `npx wrangler login` with access to the Cloudflare account in `wrangler.jsonc`.
- `gh auth login` with admin access to the notes repository (for the webhook).

## Steps
1. **Resources:** `scripts/setup.sh`. Creates what is missing and is safe to run again. Changing an existing Workers subdomain is a dashboard step; the script stops and says so.
2. **Deploy:** `npx wrangler deploy` the first time (the Worker must exist before it has secrets). After that, merges to `main` deploy through CI.
3. **Secrets:**
   - `scripts/secrets.sh rotate`: new `MCP_TOKEN` and `WEBHOOK_SECRET`, saved to `.dev.vars` (gitignored) first, then to the Worker, then the GitHub webhook is pointed at the new URL. It asks for confirmation, since every client must reconnect. If the webhook step fails, `scripts/secrets.sh webhook` retries it without rotating again.
   - `scripts/secrets.sh github`: copy a fine-grained GitHub token (Contents read and write on the notes repo) and run it; the script tests it, saves it and clears the clipboard.
4. **Index:** `POST /<MCP_TOKEN>/reindex` once.
5. **Clients:** reconnect each MCP client to `https://second-brain-mcp.yudiganeko.workers.dev/<MCP_TOKEN>/mcp`.

## CI deploy
The `deploy` job in `.github/workflows/ci.yml` runs on pushes to `main` after the tests. It needs a repository secret `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with the **Edit Cloudflare Workers** template, limited to this account. Set it with `gh secret set CLOUDFLARE_API_TOKEN`.

## Related
- [ADR 006](adr/006-wrangler-and-a-setup-script-instead-of-terraform.md)
- [Spec v2](spec/v2.md), §8
