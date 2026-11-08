# AGENTS.md

Instructions for AI coding agents working in this repository.

## Deploying it for someone

The person wants their own Second Brain MCP on their Cloudflare account. Run the installer; it is safe to re-run and skips finished steps.

```sh
npm ci
npm run deploy-your-own -- --name <worker-name> --notes starter
```

- Ask the person for the Worker name (suggest `second-brain-mcp`) and whether to start with a starter note or push a notes folder (`--notes <path>`).
- When the installer prints a `NEEDS:` line and exits 2, relay that line to the person in plain words, wait, then re-run with the same flags plus anything new (`--client-id`, `--github-user`, `--account`, `--subdomain`).
- Three steps are the person's, never yours:
  1. **Cloudflare sign-in:** they run `npx wrangler login` in their terminal and approve in the browser.
  2. **GitHub OAuth app:** they create it with the three values the installer prints and tell you the Client ID.
  3. **Client secret:** they run `npx wrangler secret put GITHUB_CLIENT_SECRET` in their own terminal and paste it into Wrangler's hidden prompt. **Never ask for the secret in chat, never read it from the clipboard, never pass it as an argument or write it to a file.**
- The plan must be Workers Paid (Artifacts requires it). If a step fails with a plan error, tell the person.
- When it finishes, it prints the MCP URL. Connect it (`claude mcp add --transport http second-brain <PUBLIC_URL>/mcp`), let the person sign in with GitHub, then check: save a test idea, search for it, delete it.
- Optional, on a Mac: `npm run mac-hook` (asks where to keep the notes clone; in a non-interactive run, tell the person to run it in their terminal).

## Working on the code

- Tests first: a failing test in its own commit, then the change. `npm test`, `npm run typecheck`, `bash test/hook/run.sh`, `bash test/scripts/run.sh`.
- Design decisions are ADRs in `docs/adr/`; the low-level design is `ARCHITECTURE.md`.
- Every deployment-specific value lives in `wrangler.jsonc`, read through `scripts/config.mjs`. Don't hard-code account ids, URLs or resource names elsewhere.
- Secrets live only in Worker secrets, the gitignored `.dev.vars` and the macOS Keychain.
