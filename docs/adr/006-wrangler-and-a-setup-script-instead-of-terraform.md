# ADR 006: Wrangler and a setup script instead of Terraform

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-06 |
| **Deciders** | Yudi Ganeko |

## Context

In v1 the infrastructure was created by hand with one-off commands: the Vectorize index, the Worker secrets, the GitHub webhook. Nothing in the repo could recreate it. v2 adds more pieces (a Queue, a Workflow, a D1 database, a Cron Trigger, an Artifacts repo, the `yudiganeko` Workers subdomain), so "recreate everything from the repo" became a goal ([PRD v2](../prd/v2.md), G2).

The first plan was Terraform. Checking the Cloudflare provider (v5.28.1) showed what it can and can't manage:

| Resource | Terraform provider |
|---|---|
| Worker and bindings, Queue and consumer, Workflow, D1, Cron Trigger | Supported |
| **Vectorize index** | Not supported |
| **Artifacts repository** | Not supported |
| **Account Workers subdomain** | Not supported |

The three resources the system depends on most are outside the provider. Everything it does support is also declared in `wrangler.jsonc` or created with `wrangler` (`d1 create`, `queues create`).

The infrastructure also changes rarely: it is created once and touched only when the architecture changes.

## Decision

- **`wrangler.jsonc` is the declaration** of the Worker and everything it binds to: Workers AI, Vectorize, D1, the Queue, the Workflow and the Cron Trigger.
- **An idempotent `scripts/setup.sh`** creates what Wrangler doesn't create on deploy (the Vectorize index, the D1 database, the Queue, the Artifacts repository) and checks the account subdomain. Running it twice changes nothing.
- **Secrets** are set with `wrangler secret put` and never stored in the repo.
- **Deploys** run from CI with `wrangler deploy` on merge to `main`.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Terraform for the supported resources, a script for the rest** | Two tools for one small system, a remote state to host and protect (HCP Terraform or an R2 backend), and a Cloudflare token in CI, to manage five resources that `wrangler.jsonc` already declares. The resources Terraform can't manage are the critical ones. |
| **Terraform only** | Not possible: the provider doesn't cover Vectorize, Artifacts or the account subdomain. |
| **Keep creating resources by hand** (v1) | Nothing reproducible, nothing reviewable. |

## Consequences

**Gained**
- One tool, the one Cloudflare's own docs lead with. No state file to host, lock or protect.
- The whole setup is readable in two files: `wrangler.jsonc` and `scripts/setup.sh`.

**Costs**
- **No drift detection.** Terraform would notice a resource changed by hand in the dashboard; Wrangler doesn't.
- **No plan step.** There is no `terraform plan` preview of infrastructure changes in a PR; the script and `wrangler.jsonc` diff are the review.
- **The script has to stay idempotent by hand:** every step checks before it creates.

## Revisit when

- The Cloudflare provider supports Vectorize, Artifacts and the account subdomain.
- The infrastructure starts changing often, or several environments (staging, production) or accounts are needed. That is where drift detection and plans pay for themselves.

## Related

- [PRD v2](../prd/v2.md)
- [Issue #25](https://github.com/YudiG12/second-brain-mcp/issues/25)
