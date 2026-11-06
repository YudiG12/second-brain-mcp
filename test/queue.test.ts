import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { retryDelay } from "../src/index";

const testEnv = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

beforeAll(() => applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS));

describe("queue() handler", () => {
  it("backs off 10, 20, 40, 80, 160 seconds", () => {
    expect([1, 2, 3, 4, 5].map(retryDelay)).toEqual([10, 20, 40, 80, 160]);
  });

  it("retries a failing index job instead of acking it", async () => {
    // no Artifacts binding in tests, so indexing fails
    const batch = createMessageBatch("index-jobs", [{ id: "m1", timestamp: new Date(), attempts: 1, body: { type: "index", path: "a.md", reason: "write" } }]);
    const ctx = createExecutionContext();
    await (worker.queue as any)(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    // the local runtime records the retry but not its delay; retryDelay is tested above
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m1"]);
  });

  it("acks an unknown message type instead of retrying it", async () => {
    const batch = createMessageBatch("index-jobs", [{ id: "m3", timestamp: new Date(), attempts: 1, body: { type: "cf.artifacts.repo.cloned" } }]);
    const ctx = createExecutionContext();
    await (worker.queue as any)(batch, env, ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["m3"]);
  });

  it("records dead-lettered jobs in the alerts table and acks them", async () => {
    const body = { type: "index", path: "dead.md", reason: "write" };
    const batch = createMessageBatch("index-jobs-dlq", [{ id: "d1", timestamp: new Date(), attempts: 1, body }]);
    const ctx = createExecutionContext();
    await (worker.queue as any)(batch, env, ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["d1"]);
    const row = await testEnv.DB.prepare("SELECT source, body FROM alerts WHERE body LIKE '%dead.md%'").first();
    expect(row).toEqual({ source: "dlq", body: JSON.stringify(body) });
  });
});
