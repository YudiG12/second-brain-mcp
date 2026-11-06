import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { allNotes, ArtifactsNotes, vectorPathHashes } from "../indexer/adapters";
import { pathHash } from "../lib/notes";
import { runReconcile } from "./reconcile";
import type { Mode, ReconcileDeps } from "./types";

type Env = {
  ARTIFACTS: Artifacts;
  DB: D1Database;
  INDEX_JOBS: Queue;
  NOTES_REPO: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN?: string; // optional: Vectorize read, for the rebuild's orphan scan
};

/**
 * Daily reconciliation (scheduled in wrangler.jsonc) and on-demand rebuild (/admin/reconcile).
 * Two runs may overlap; that's safe, because this only enqueues and the Queue consumer re-checks
 * each note at the head (ADR 009).
 */
export class Reconcile extends WorkflowEntrypoint<Env, { mode?: Mode }> {
  async run(event: WorkflowEvent<{ mode?: Mode }>, step: WorkflowStep) {
    const env = this.env;
    const notes = new ArtifactsNotes(env.ARTIFACTS, env.NOTES_REPO);
    const deps: ReconcileDeps = {
      source: {
        head: () => notes.head(),
        allNotes: (commit) => allNotes(env.ARTIFACTS, env.NOTES_REPO, commit),
        changedPaths: (a, b) => notes.changedPaths(a, b),
      },
      index: {
        manifest: async () => (await env.DB.prepare("SELECT path, sha FROM manifest").all<{ path: string; sha: string }>()).results,
        vectorPathHashes: () => vectorPathHashes(env.CF_ACCOUNT_ID, "second-brain", env.CF_API_TOKEN),
      },
      enqueue: async (ms) => {
        if (ms.length) await env.INDEX_JOBS.sendBatch(ms.map((body) => ({ body })));
      },
      pathHash,
      alert: async (body) => {
        await env.DB.prepare("INSERT INTO alerts (source, body, created_at) VALUES ('reconcile', ?, ?)").bind(body, new Date().toISOString()).run();
      },
    };
    const report = await runReconcile(event.payload?.mode ?? "daily", step as any, deps);
    console.log(JSON.stringify({ reconcile: report }));
    return report;
  }
}
