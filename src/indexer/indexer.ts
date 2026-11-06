import type { Deps, Outcome, QueueMessage } from "./types";

/** Handles one queue message. Throws on failure, so the queue retries it. */
export async function handle(_msg: QueueMessage, _deps: Deps): Promise<Outcome> {
  throw new Error("not implemented");
}
