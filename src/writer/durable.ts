import { DurableObject } from "cloudflare:workers";
import { ArtifactsWorkingCopy } from "./artifacts";
import type { Operation, WriteResult } from "./types";
import { Writer } from "./writer";

/** One instance per repository (ADR 008): `env.WRITER.idFromName(env.NOTES_REPO)`. */
export class RepoWriter extends DurableObject<Env> {
  private writer = new Writer(new ArtifactsWorkingCopy(this.env.ARTIFACTS, this.env.NOTES_REPO));

  run(op: Operation): Promise<WriteResult> {
    return this.writer.run(op);
  }
}
