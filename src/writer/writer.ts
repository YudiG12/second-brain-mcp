import type { Operation, WorkingCopy, WriteResult } from "./types";

export class Writer {
  constructor(private readonly copy: WorkingCopy) {}

  async run(_op: Operation): Promise<WriteResult> {
    throw new Error("not implemented");
  }
}
