import type { IndexMessage } from "../indexer/types";
import type { DropMessage, Mode, NoteSha, ReconcileDeps, Report, Step } from "./types";
import { ALERT_ABOVE, BATCH } from "./types";

/**
 * Compares the notes with the index and enqueues what needs fixing. Each phase is a Workflow step,
 * so a failure resumes from the step that failed, not from the start (ADR 009).
 */
export async function runReconcile(mode: Mode, step: Step, deps: ReconcileDeps): Promise<Report> {
  const reason = mode === "rebuild" ? "rebuild" : "reconcile";

  const { commit, notes } = await step.do("snapshot source", async () => {
    const commit = await deps.source.head();
    return { commit, notes: commit ? await deps.source.allNotes(commit) : ([] as NoteSha[]) };
  });

  const { manifest, vectorHashes } = await step.do("snapshot index", async () => ({
    manifest: await deps.index.manifest(),
    vectorHashes: mode === "rebuild" ? await deps.index.vectorPathHashes() : null,
  }));

  // compare
  const indexed = new Map(manifest.map((r) => [r.path, r.sha]));
  const inSource = new Set(notes.map((n) => n.path));
  const fresh = notes.filter((n) => !indexed.has(n.path)).map((n) => n.path);
  const changed = notes.filter((n) => indexed.has(n.path) && indexed.get(n.path) !== n.sha).map((n) => n.path);
  const orphans = manifest.filter((r) => !inSource.has(r.path)).map((r) => r.path);

  let messages: (IndexMessage | DropMessage)[];
  let vectorOrphans: number | null = null;
  if (mode === "rebuild") {
    // every note again, plus manifest orphans (the consumer finds them missing and deletes them)
    messages = [...notes.map((n) => n.path), ...orphans].map((path) => ({ type: "index", path, reason }));
    if (vectorHashes) {
      const expected = new Set(await Promise.all(notes.map((n) => deps.pathHash(n.path))));
      const drops = vectorHashes.filter((h) => !expected.has(h));
      vectorOrphans = drops.length;
      messages.push(...drops.map((pathHash) => ({ type: "drop" as const, pathHash })));
    }
  } else {
    messages = [...fresh, ...changed, ...orphans].map((path) => ({ type: "index", path, reason }));
  }

  const batches = Math.ceil(messages.length / BATCH);
  for (let i = 0; i < batches; i++) {
    await step.do(`enqueue ${i + 1}/${batches}`, () => deps.enqueue(messages.slice(i * BATCH, (i + 1) * BATCH)));
  }

  return step.do("report", async () => {
    const now = await deps.source.head();
    const inFlightPaths = commit && now && now !== commit ? new Set(await deps.source.changedPaths(commit, now)) : new Set<string>();
    const fixedPaths = [...fresh, ...changed, ...orphans];
    const missed = fixedPaths.filter((p) => !inFlightPaths.has(p)).length;
    const report: Report = {
      mode,
      commit,
      notes: notes.length,
      enqueued: messages.length,
      fixed: { new: fresh.length, changed: changed.length, orphans: orphans.length, vectorOrphans },
      inFlight: fixedPaths.length - missed,
      alerted: mode === "daily" && missed > ALERT_ABOVE,
    };
    if (report.alerted) await deps.alert(JSON.stringify(report));
    return report;
  });
}
