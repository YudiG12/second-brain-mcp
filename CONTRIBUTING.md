# Contributing

## Development

Node 24 or later.

```sh
npm ci
npm run typecheck
npm test              # Vitest inside workerd, with local D1, KV, Queues and Workflows
npm run test:ui       # the same tests in the Vitest UI
bash test/hook/run.sh # the sync hook against real Git repositories
```

To deploy your own: [docs/setup.md](docs/setup.md).

## How changes are made

1. **Failing tests first.** Each PR starts with a red commit that describes the behavior; the next commit makes it green. A known bug can be pinned with `it.fails`, which turns red once the bug is fixed.
2. **CI on every PR:** typecheck, the Vitest suite inside workerd, and the sync hook tests. CI comments a report with a link to the Vitest UI for each commit.
3. **Review** by a separate reviewer with a clean context (only the diff and the docs).
4. **Merge to `main` deploys** (D1 migrations, then `wrangler deploy`).

Decisions that change the design get an ADR in [`docs/adr/`](docs/adr/).
