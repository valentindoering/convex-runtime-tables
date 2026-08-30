/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { normalizeIndexSlots, type Scalar } from "./normalization.js";
import { initConvexTest } from "./setup.test.js";

const REPETITIONS = 20;
type TestInstance = ReturnType<typeof initConvexTest>;

describe("forced lifecycle and write races", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("R1 delete versus backfill leaves no orphan", async () => {
    for (let run = 0; run < REPETITIONS; run += 1) {
      const t = initConvexTest();
      const fixture = await createFixture(t, `test-r1-${run}`);
      await insert(t, fixture, "a", "before");
      const build = await createIndex(t, fixture, false);
      await t.mutation(api.public.deleteIndex, {
        scopeId: fixture.scopeId,
        indexId: build.indexId,
      });
      await drain(t);
      await assertOracle(t, fixture);
      const residue = await t.run(
        async (ctx) =>
          await ctx.db
            .query("indexEntries")
            .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
              q.eq("scopeId", fixture.scopeId).eq("indexId", build.indexId),
            )
            .take(1),
      );
      expect(residue).toHaveLength(0);
    }
  });

  test("R2 updates before and after the backfill cursor converge", async () => {
    for (let run = 0; run < REPETITIONS; run += 1) {
      const t = initConvexTest();
      const fixture = await createFixture(t, `test-r2-${run}`);
      const ids: Id<"records">[] = [];
      for (let index = 0; index < 60; index += 1) {
        ids.push(await insert(t, fixture, `key-${index}`, `value-${index}`));
      }
      const build = await createIndex(t, fixture, false);
      await patch(t, fixture, ids[55]!, 1, "before-cursor");
      await step(t);
      await patch(t, fixture, ids[0]!, 1, "after-cursor");
      await drain(t);
      await expectReady(t, fixture, build.indexId);
      await assertOracle(t, fixture);
    }
  }, 120_000);

  test("R3 insert around the backfill cursor is indexed", async () => {
    for (let run = 0; run < REPETITIONS; run += 1) {
      const t = initConvexTest();
      const fixture = await createFixture(t, `test-r3-${run}`);
      for (let index = 0; index < 60; index += 1) {
        await insert(t, fixture, `key-${index}`, `value-${index}`);
      }
      const build = await createIndex(t, fixture, false);
      await step(t);
      await insert(t, fixture, "inserted-at-boundary", "latest");
      await drain(t);
      await expectReady(t, fixture, build.indexId);
      await assertOracle(t, fixture);
    }
  }, 120_000);

  test("R4 repair mid-backfill supersedes the old generation", async () => {
    for (let run = 0; run < REPETITIONS; run += 1) {
      const t = initConvexTest();
      const fixture = await createFixture(t, `test-r4-${run}`);
      for (let index = 0; index < 60; index += 1) {
        await insert(t, fixture, `key-${index}`, `value-${index}`);
      }
      const build = await createIndex(t, fixture, false);
      await step(t);
      const repair = await t.mutation(api.public.repairIndex, {
        scopeId: fixture.scopeId,
        indexId: build.indexId,
      });
      expect(repair.jobId).not.toBe(build.jobId);
      await drain(t);
      const oldJob = await t.query(api.public.getJob, {
        scopeId: fixture.scopeId,
        jobId: build.jobId,
      });
      const newJob = await t.query(api.public.getJob, {
        scopeId: fixture.scopeId,
        jobId: repair.jobId,
      });
      expect(oldJob?.state).toBe("superseded");
      expect(newJob?.state).toBe("succeeded");
      await expectReady(t, fixture, build.indexId);
      await assertOracle(t, fixture);
    }
  }, 120_000);

  test("R5 create delete create leaves no entries under the dead index", async () => {
    for (let run = 0; run < REPETITIONS; run += 1) {
      const t = initConvexTest();
      const fixture = await createFixture(t, `test-r5-${run}`);
      await insert(t, fixture, "key", "value");
      const first = await createIndex(t, fixture, false, "first");
      await t.mutation(api.public.deleteIndex, {
        scopeId: fixture.scopeId,
        indexId: first.indexId,
      });
      await drain(t);
      const second = await createIndex(t, fixture, false, "second");
      await drain(t);
      await expectReady(t, fixture, second.indexId);
      const deadEntries = await t.run(
        async (ctx) =>
          await ctx.db
            .query("indexEntries")
            .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
              q.eq("scopeId", fixture.scopeId).eq("indexId", first.indexId),
            )
            .take(1),
      );
      expect(deadEntries).toHaveLength(0);
      await assertOracle(t, fixture);
    }
  });

  test("R6 table deletion during backfill purges all residue", async () => {
    for (let run = 0; run < REPETITIONS; run += 1) {
      const t = initConvexTest();
      const fixture = await createFixture(t, `test-r6-${run}`);
      for (let index = 0; index < 60; index += 1) {
        await insert(t, fixture, `key-${index}`, `value-${index}`);
      }
      await createIndex(t, fixture, false);
      await step(t);
      const deleted = await t.mutation(api.public.deleteTable, {
        scopeId: fixture.scopeId,
        tableId: fixture.tableId,
      });
      await drain(t);
      expect(
        await t.query(api.public.getJob, {
          scopeId: fixture.scopeId,
          jobId: deleted.jobId,
        }),
      ).toMatchObject({ state: "succeeded" });
      const residue = await t.run(async (ctx) => ({
        records: await ctx.db
          .query("records")
          .withIndex("by_scopeId_and_tableId", (q) =>
            q.eq("scopeId", fixture.scopeId).eq("tableId", fixture.tableId),
          )
          .take(1),
        entries: await ctx.db
          .query("indexEntries")
          .withIndex("by_scopeId_and_recordId_and_indexId", (q) =>
            q.eq("scopeId", fixture.scopeId),
          )
          .take(1),
      }));
      expect(residue.records).toHaveLength(0);
      expect(residue.entries).toHaveLength(0);
    }
  }, 120_000);

  test("R7 concurrent unique inserts admit one logical value", async () => {
    for (let run = 0; run < REPETITIONS; run += 1) {
      const t = initConvexTest();
      const fixture = await createFixture(t, `test-r7-${run}`);
      const build = await createIndex(t, fixture, true);
      await drain(t);
      await expectReady(t, fixture, build.indexId);
      const results = await Promise.allSettled([
        insert(t, fixture, "same", "left"),
        insert(t, fixture, "same", "right"),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      await assertOracle(t, fixture);
    }
  });

  test("R8 concurrent idempotent batches return the same IDs", async () => {
    for (let run = 0; run < REPETITIONS; run += 1) {
      const t = initConvexTest();
      const fixture = await createFixture(t, `test-r8-${run}`);
      const request = {
        scopeId: fixture.scopeId,
        tableId: fixture.tableId,
        records: [{ values: values(fixture, "same", "payload") }],
        idempotencyKey: "same-key",
      };
      const [left, right] = await Promise.all([
        t.mutation(api.public.insertRecords, request),
        t.mutation(api.public.insertRecords, request),
      ]);
      expect(right).toEqual(left);
      await expect(
        t.mutation(api.public.insertRecords, {
          ...request,
          records: [{ values: values(fixture, "different", "payload") }],
        }),
      ).rejects.toThrow(/IDEMPOTENCY_MISMATCH/);
      await assertOracle(t, fixture);
    }
  });

  test("R9 concurrent expectedRev patches have one winner", async () => {
    for (let run = 0; run < REPETITIONS; run += 1) {
      const t = initConvexTest();
      const fixture = await createFixture(t, `test-r9-${run}`);
      const recordId = await insert(t, fixture, "key", "initial");
      const results = await Promise.allSettled([
        patch(t, fixture, recordId, 1, "left"),
        patch(t, fixture, recordId, 1, "right"),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      await assertOracle(t, fixture);
    }
  });
});

type Fixture = {
  scopeId: string;
  tableId: Id<"tables">;
  keyId: Id<"fields">;
  valueId: Id<"fields">;
};

async function createFixture(
  t: TestInstance,
  scopeId: string,
): Promise<Fixture> {
  const created = await t.mutation(api.public.createTable, {
    scopeId,
    slug: "items",
    name: "Items",
    fields: [
      { key: "key", name: "Key", type: "text", required: true },
      { key: "value", name: "Value", type: "text", required: true },
    ],
  });
  return {
    scopeId,
    tableId: created.table._id,
    keyId: created.fields.find((field) => field.key === "key")!._id,
    valueId: created.fields.find((field) => field.key === "value")!._id,
  };
}

function values(fixture: Fixture, key: string, value: string) {
  return { [fixture.keyId]: key, [fixture.valueId]: value };
}

async function insert(
  t: TestInstance,
  fixture: Fixture,
  key: string,
  value: string,
) {
  const [result] = await t.mutation(api.public.insertRecords, {
    scopeId: fixture.scopeId,
    tableId: fixture.tableId,
    records: [{ values: values(fixture, key, value) }],
  });
  return result!.recordId;
}

async function patch(
  t: TestInstance,
  fixture: Fixture,
  recordId: Id<"records">,
  expectedRev: number,
  value: string,
) {
  return await t.mutation(api.public.patchRecord, {
    scopeId: fixture.scopeId,
    tableId: fixture.tableId,
    recordId,
    patch: { values: { [fixture.valueId]: value } },
    expectedRev,
  });
}

async function createIndex(
  t: TestInstance,
  fixture: Fixture,
  unique: boolean,
  name = "byKey",
) {
  return await t.mutation(api.public.createIndex, {
    scopeId: fixture.scopeId,
    tableId: fixture.tableId,
    name,
    fieldIds: [fixture.keyId],
    unique,
  });
}

async function step(t: TestInstance) {
  vi.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
}

async function drain(t: TestInstance) {
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
}

async function expectReady(
  t: TestInstance,
  fixture: Fixture,
  indexId: Id<"indexDefinitions">,
) {
  const schema = await t.query(api.public.getTable, {
    scopeId: fixture.scopeId,
    tableId: fixture.tableId,
  });
  expect(schema.indexes.find((index) => index._id === indexId)).toMatchObject({
    state: "ready",
    maintenanceState: "idle",
  });
}

async function assertOracle(t: TestInstance, fixture: Fixture) {
  const snapshot = await t.run(async (ctx) => ({
    records: await ctx.db
      .query("records")
      .withIndex("by_scopeId_and_tableId", (q) =>
        q.eq("scopeId", fixture.scopeId).eq("tableId", fixture.tableId),
      )
      .take(500),
    indexes: await ctx.db
      .query("indexDefinitions")
      .withIndex("by_scopeId_and_tableId_and_state", (q) =>
        q
          .eq("scopeId", fixture.scopeId)
          .eq("tableId", fixture.tableId)
          .eq("state", "ready"),
      )
      .take(10),
    entries: await ctx.db
      .query("indexEntries")
      .withIndex("by_scopeId_and_recordId_and_indexId", (q) =>
        q.eq("scopeId", fixture.scopeId),
      )
      .take(1_000),
  }));
  const actual = snapshot.entries
    .map((entry) =>
      JSON.stringify([
        entry.indexId,
        entry.recordId,
        entry.k0,
        entry.k1,
        entry.k2,
        entry.recordRev,
      ]),
    )
    .sort();
  const expected = snapshot.indexes
    .flatMap((index) =>
      snapshot.records.map((record) => {
        const slots = normalizeIndexSlots(
          index.fieldIds,
          record.values as Record<string, Scalar>,
        );
        return JSON.stringify([
          index._id,
          record._id,
          slots[0],
          slots[1],
          slots[2],
          record.rev,
        ]);
      }),
    )
    .sort();
  expect(actual).toEqual(expected);
}
