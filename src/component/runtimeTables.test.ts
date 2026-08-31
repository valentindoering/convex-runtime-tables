/// <reference types="vite/client" />

import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { QuerySpec } from "./planner.js";
import * as publicFunctions from "./public.js";
import { initConvexTest } from "./setup.test.js";

const scopeId = "scope-a";
const patchRecordWithoutIndexMaintenance = makeFunctionReference<
  "mutation",
  {
    scopeId: string;
    recordId: Id<"records">;
    values: Record<string, null | boolean | number | string>;
  },
  null
>("faults.test:patchRecordWithoutIndexMaintenance");
const deleteRecordWithoutIndexMaintenance = makeFunctionReference<
  "mutation",
  {
    scopeId: string;
    recordId: Id<"records">;
  },
  null
>("faults.test:deleteRecordWithoutIndexMaintenance");

describe("runtime tables component", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("validates records, preserves field IDs on rename, and enforces revisions", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    const merchantId = created.fieldIds.merchant!;
    const [written] = await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: created.tableId,
      records: [{ values: valuesFor(created.fieldIds, 1) }],
    });
    expect(written?.rev).toBe(1);

    const renamed = await t.mutation(api.public.updateField, {
      scopeId,
      fieldId: merchantId,
      patch: { name: "Payee" },
      expectedSchemaRev: 1,
    });
    expect(renamed._id).toBe(merchantId);
    expect(renamed.name).toBe("Payee");

    const patched = await t.mutation(api.public.patchRecord, {
      scopeId,
      tableId: created.tableId,
      recordId: written!.recordId,
      patch: { values: { [merchantId]: "Updated Merchant" } },
      expectedRev: 1,
    });
    expect(patched.rev).toBe(2);
    await expect(
      t.mutation(api.public.patchRecord, {
        scopeId,
        tableId: created.tableId,
        recordId: written!.recordId,
        patch: { values: { [merchantId]: "Stale write" } },
        expectedRev: 1,
      }),
    ).rejects.toThrow(/CONFLICT|revision changed/);
  });

  test("deduplicates batches by idempotency key and rejects mismatched reuse", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    const request = {
      scopeId,
      tableId: created.tableId,
      records: Array.from({ length: 20 }, (_, index) => ({
        values: valuesFor(created.fieldIds, index),
      })),
      idempotencyKey: "import-batch-1",
    };
    const first = await t.mutation(api.public.insertRecords, request);
    const second = await t.mutation(api.public.insertRecords, request);
    expect(second).toEqual(first);
    const page = await t.query(api.public.queryRecords, {
      scopeId,
      tableId: created.tableId,
      query: { where: [] },
      pagination: { pageSize: 100 },
    });
    expect(page.page).toHaveLength(20);
    await expect(
      t.mutation(api.public.insertRecords, {
        ...request,
        records: [{ values: valuesFor(created.fieldIds, 99) }],
      }),
    ).rejects.toThrow(/IDEMPOTENCY_MISMATCH|different request/);
  });

  test("builds and pages a composite range index in exact order", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: created.tableId,
      records: Array.from({ length: 30 }, (_, index) => ({
        values: valuesFor(created.fieldIds, index),
      })),
    });
    const { indexId } = await t.mutation(api.public.createIndex, {
      scopeId,
      tableId: created.tableId,
      name: "accountBookingDate",
      fieldIds: [created.fieldIds.accountId!, created.fieldIds.bookingDate!],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const schema = await t.query(api.public.getTable, {
      scopeId,
      tableId: created.tableId,
    });
    expect(schema.indexes.find((index) => index._id === indexId)?.state).toBe(
      "ready",
    );

    const seen: number[] = [];
    const seenIds: string[] = [];
    let cursor: string | undefined;
    let pageNumber = 0;
    do {
      const page = await t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: {
          where: [
            {
              fieldId: created.fieldIds.accountId!,
              op: "eq" as const,
              value: "account-1",
            },
            {
              fieldId: created.fieldIds.bookingDate!,
              op: "gte" as const,
              value: 1_700_000_000_000,
            },
          ],
          orderBy: {
            fieldIds: [created.fieldIds.bookingDate!],
            direction: "asc",
          },
        },
        pagination: { pageSize: 4, cursor },
      });
      expect(page.plan.kind).toBe("index");
      seen.push(
        ...page.page.map((record) =>
          Number(record.values[created.fieldIds.bookingDate!]!),
        ),
      );
      seenIds.push(...page.page.map((record) => record._id));
      if (pageNumber === 0) {
        const record = page.page[0]!;
        await t.mutation(api.public.patchRecord, {
          scopeId,
          tableId: created.tableId,
          recordId: record._id,
          patch: {
            values: { [created.fieldIds.merchant!]: "Changed between pages" },
          },
          expectedRev: record.rev,
        });
      }
      pageNumber += 1;
      cursor = page.continueCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([...seen].sort((left, right) => left - right));
    expect(seen).toHaveLength(10);

    const descendingIds: string[] = [];
    cursor = undefined;
    do {
      const page: {
        page: Array<{ _id: string }>;
        continueCursor: string | null;
      } = await t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: {
          where: [
            {
              fieldId: created.fieldIds.accountId!,
              op: "eq" as const,
              value: "account-1",
            },
            {
              fieldId: created.fieldIds.bookingDate!,
              op: "gte" as const,
              value: 1_700_000_000_000,
            },
          ],
          orderBy: {
            fieldIds: [created.fieldIds.bookingDate!],
            direction: "desc" as const,
          },
        },
        pagination: { pageSize: 4, cursor },
      });
      descendingIds.push(...page.page.map((record) => record._id));
      cursor = page.continueCursor ?? undefined;
    } while (cursor);
    expect(descendingIds).toEqual([...seenIds].reverse());
  });

  test("supports ready unique-index upserts without duplicates", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    const { indexId } = await t.mutation(api.public.createIndex, {
      scopeId,
      tableId: created.tableId,
      name: "sourceRefUnique",
      fieldIds: [created.fieldIds.sourceRef!],
      unique: true,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const first = await t.mutation(api.public.upsertRecords, {
      scopeId,
      tableId: created.tableId,
      uniqueIndexId: indexId,
      records: [{ values: valuesFor(created.fieldIds, 1) }],
    });
    const second = await t.mutation(api.public.upsertRecords, {
      scopeId,
      tableId: created.tableId,
      uniqueIndexId: indexId,
      records: [
        {
          values: {
            ...valuesFor(created.fieldIds, 1),
            [created.fieldIds.merchant!]: "Replacement",
          },
        },
      ],
    });
    expect(second[0]!.recordId).toBe(first[0]!.recordId);
    expect(second[0]!.rev).toBe(2);
  });

  test("documents bounded post-filter pages as possibly short while not done", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: created.tableId,
      records: Array.from({ length: 9 }, (_, index) => ({
        values: valuesFor(created.fieldIds, index),
      })),
    });
    await t.mutation(api.public.createIndex, {
      scopeId,
      tableId: created.tableId,
      name: "byAccount",
      fieldIds: [created.fieldIds.accountId!],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const first = await t.query(api.public.queryRecords, {
      scopeId,
      tableId: created.tableId,
      query: {
        where: [
          {
            fieldId: created.fieldIds.accountId!,
            op: "eq",
            value: "account-1",
          },
          {
            fieldId: created.fieldIds.merchant!,
            op: "eq",
            value: "Merchant 6",
          },
        ],
      },
      pagination: { pageSize: 1 },
    });
    expect(first.plan).toMatchObject({ kind: "index", postFiltered: true });
    expect(first.page).toHaveLength(0);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).not.toBeNull();
  });

  test("fails closed for another scope's resource IDs", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    await expect(
      t.query(api.public.getTable, {
        scopeId: "scope-b",
        tableId: created.tableId,
      }),
    ).rejects.toThrow(/SCOPE_MISMATCH|another scope/);
  });

  test("keeps the public isolation matrix synchronized with every export", async () => {
    const t = initConvexTest();
    const local = await createTransactionsTable(t);
    const foreignScope = "scope-b";
    const foreign = await createTransactionsTable(t, foreignScope);
    const localRecords = await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: local.tableId,
      records: [1, 2].map((value) => ({
        values: valuesFor(local.fieldIds, value),
      })),
    });
    const foreignRecords = await t.mutation(api.public.insertRecords, {
      scopeId: foreignScope,
      tableId: foreign.tableId,
      records: [1, 2].map((value) => ({
        values: valuesFor(foreign.fieldIds, value),
      })),
    });
    const localIndex = await t.mutation(api.public.createIndex, {
      scopeId,
      tableId: local.tableId,
      name: "localIsolation",
      fieldIds: [local.fieldIds.sourceRef!],
      unique: true,
    });
    const foreignIndex = await t.mutation(api.public.createIndex, {
      scopeId: foreignScope,
      tableId: foreign.tableId,
      name: "foreignIsolation",
      fieldIds: [foreign.fieldIds.sourceRef!],
      unique: true,
    });
    await t.mutation(api.public.createTable, {
      scopeId: foreignScope,
      slug: "foreign-cursor-second-table",
      name: "Foreign cursor second table",
      fields: [],
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const foreignTableCursor = (
      await t.query(api.public.listTables, {
        scopeId: foreignScope,
        pagination: { pageSize: 1 },
      })
    ).continueCursor!;
    const foreignRecordCursor = (
      await t.query(api.public.queryRecords, {
        scopeId: foreignScope,
        tableId: foreign.tableId,
        query: { where: [] },
        pagination: { pageSize: 1 },
      })
    ).continueCursor!;
    const foreignEntryCursor = (
      await t.query(api.public.auditIndexEntries, {
        scopeId: foreignScope,
        indexId: foreignIndex.indexId,
        pagination: { pageSize: 1 },
      })
    ).continueCursor!;

    type IsolationCase = { resource: string; invoke: () => Promise<unknown> };
    const model: Record<string, IsolationCase[]> = {
      createTable: [
        {
          resource: "referenceTableId",
          invoke: () =>
            t.mutation(api.public.createTable, {
              scopeId,
              slug: "foreign-reference-create",
              name: "Foreign reference create",
              fields: [
                {
                  key: "target",
                  name: "Target",
                  type: "reference",
                  required: true,
                  constraints: { referenceTableId: foreign.tableId },
                },
              ],
            }),
        },
      ],
      listTables: [
        {
          resource: "cursor",
          invoke: () =>
            t.query(api.public.listTables, {
              scopeId,
              pagination: { pageSize: 1, cursor: foreignTableCursor },
            }),
        },
      ],
      getTable: [
        foreignTableCase(() =>
          t.query(api.public.getTable, {
            scopeId,
            tableId: foreign.tableId,
          }),
        ),
      ],
      getRecord: [
        foreignTableCase(() =>
          t.query(api.public.getRecord, {
            scopeId,
            tableId: foreign.tableId,
            recordId: foreignRecords[0]!.recordId,
          }),
        ),
        {
          resource: "recordId",
          invoke: () =>
            t.query(api.public.getRecord, {
              scopeId,
              tableId: local.tableId,
              recordId: foreignRecords[0]!.recordId,
            }),
        },
      ],
      queryRecords: [
        foreignTableCase(() =>
          t.query(api.public.queryRecords, {
            scopeId,
            tableId: foreign.tableId,
            query: { where: [] },
            pagination: { pageSize: 1 },
          }),
        ),
        {
          resource: "fieldId",
          invoke: () =>
            t.query(api.public.queryRecords, {
              scopeId,
              tableId: local.tableId,
              query: {
                where: [
                  {
                    fieldId: foreign.fieldIds.merchant!,
                    op: "eq",
                    value: "Merchant 1",
                  },
                ],
              },
              pagination: { pageSize: 1 },
            }),
        },
        {
          resource: "cursor",
          invoke: () =>
            t.query(api.public.queryRecords, {
              scopeId,
              tableId: local.tableId,
              query: { where: [] },
              pagination: { pageSize: 1, cursor: foreignRecordCursor },
            }),
        },
      ],
      explainQuery: [
        foreignTableCase(() =>
          t.query(api.public.explainQuery, {
            scopeId,
            tableId: foreign.tableId,
            query: { where: [] },
          }),
        ),
        {
          resource: "fieldId",
          invoke: () =>
            t.query(api.public.explainQuery, {
              scopeId,
              tableId: local.tableId,
              query: {
                where: [
                  {
                    fieldId: foreign.fieldIds.merchant!,
                    op: "eq",
                    value: "Merchant 1",
                  },
                ],
              },
            }),
        },
      ],
      getJob: [
        {
          resource: "jobId",
          invoke: () =>
            t.query(api.public.getJob, {
              scopeId,
              jobId: foreignIndex.jobId,
            }),
        },
      ],
      auditIndexEntries: [
        {
          resource: "indexId",
          invoke: () =>
            t.query(api.public.auditIndexEntries, {
              scopeId,
              indexId: foreignIndex.indexId,
              pagination: { pageSize: 1 },
            }),
        },
        {
          resource: "cursor",
          invoke: () =>
            t.query(api.public.auditIndexEntries, {
              scopeId,
              indexId: localIndex.indexId,
              pagination: { pageSize: 1, cursor: foreignEntryCursor },
            }),
        },
      ],
      updateTable: [
        foreignTableCase(() =>
          t.mutation(api.public.updateTable, {
            scopeId,
            tableId: foreign.tableId,
            patch: { name: "Foreign" },
            expectedSchemaRev: 2,
          }),
        ),
      ],
      addField: [
        foreignTableCase(() =>
          t.mutation(api.public.addField, {
            scopeId,
            tableId: foreign.tableId,
            field: {
              key: "foreign",
              name: "Foreign",
              type: "text",
              required: false,
            },
            expectedSchemaRev: 2,
          }),
        ),
        {
          resource: "referenceTableId",
          invoke: () =>
            t.mutation(api.public.addField, {
              scopeId,
              tableId: local.tableId,
              field: {
                key: "foreignReference",
                name: "Foreign reference",
                type: "reference",
                required: false,
                constraints: { referenceTableId: foreign.tableId },
              },
              expectedSchemaRev: 3,
            }),
        },
      ],
      updateField: [
        {
          resource: "fieldId",
          invoke: () =>
            t.mutation(api.public.updateField, {
              scopeId,
              fieldId: foreign.fieldIds.merchant!,
              patch: { name: "Foreign" },
              expectedSchemaRev: 2,
            }),
        },
      ],
      insertRecords: [
        foreignTableCase(() =>
          t.mutation(api.public.insertRecords, {
            scopeId,
            tableId: foreign.tableId,
            records: [{ values: valuesFor(foreign.fieldIds, 3) }],
          }),
        ),
        {
          resource: "fieldId",
          invoke: () =>
            t.mutation(api.public.insertRecords, {
              scopeId,
              tableId: local.tableId,
              records: [
                {
                  values: {
                    ...valuesFor(local.fieldIds, 3),
                    [foreign.fieldIds.merchant!]: "Foreign",
                  },
                },
              ],
            }),
        },
      ],
      patchRecord: [
        foreignTableCase(() =>
          t.mutation(api.public.patchRecord, {
            scopeId,
            tableId: foreign.tableId,
            recordId: foreignRecords[0]!.recordId,
            patch: { values: {} },
            expectedRev: 1,
          }),
        ),
        {
          resource: "recordId",
          invoke: () =>
            t.mutation(api.public.patchRecord, {
              scopeId,
              tableId: local.tableId,
              recordId: foreignRecords[0]!.recordId,
              patch: { values: {} },
              expectedRev: 1,
            }),
        },
        {
          resource: "fieldId",
          invoke: () =>
            t.mutation(api.public.patchRecord, {
              scopeId,
              tableId: local.tableId,
              recordId: localRecords[0]!.recordId,
              patch: {
                values: { [foreign.fieldIds.merchant!]: "Foreign" },
              },
              expectedRev: 1,
            }),
        },
      ],
      upsertRecords: [
        foreignTableCase(() =>
          t.mutation(api.public.upsertRecords, {
            scopeId,
            tableId: foreign.tableId,
            uniqueIndexId: foreignIndex.indexId,
            records: [{ values: valuesFor(foreign.fieldIds, 3) }],
          }),
        ),
        {
          resource: "indexId",
          invoke: () =>
            t.mutation(api.public.upsertRecords, {
              scopeId,
              tableId: local.tableId,
              uniqueIndexId: foreignIndex.indexId,
              records: [{ values: valuesFor(local.fieldIds, 3) }],
            }),
        },
        {
          resource: "fieldId",
          invoke: () =>
            t.mutation(api.public.upsertRecords, {
              scopeId,
              tableId: local.tableId,
              uniqueIndexId: localIndex.indexId,
              records: [
                {
                  values: {
                    ...valuesFor(local.fieldIds, 3),
                    [foreign.fieldIds.merchant!]: "Foreign",
                  },
                },
              ],
            }),
        },
      ],
      deleteRecord: [
        foreignTableCase(() =>
          t.mutation(api.public.deleteRecord, {
            scopeId,
            tableId: foreign.tableId,
            recordId: foreignRecords[0]!.recordId,
          }),
        ),
        {
          resource: "recordId",
          invoke: () =>
            t.mutation(api.public.deleteRecord, {
              scopeId,
              tableId: local.tableId,
              recordId: foreignRecords[0]!.recordId,
            }),
        },
      ],
      createIndex: [
        foreignTableCase(() =>
          t.mutation(api.public.createIndex, {
            scopeId,
            tableId: foreign.tableId,
            name: "foreignTable",
            fieldIds: [foreign.fieldIds.sourceRef!],
            unique: false,
          }),
        ),
        {
          resource: "fieldId",
          invoke: () =>
            t.mutation(api.public.createIndex, {
              scopeId,
              tableId: local.tableId,
              name: "foreignField",
              fieldIds: [foreign.fieldIds.sourceRef!],
              unique: false,
            }),
        },
      ],
      verifyIndex: [
        foreignIndexCase(() =>
          t.mutation(api.public.verifyIndex, {
            scopeId,
            indexId: foreignIndex.indexId,
          }),
        ),
      ],
      repairIndex: [
        foreignIndexCase(() =>
          t.mutation(api.public.repairIndex, {
            scopeId,
            indexId: foreignIndex.indexId,
          }),
        ),
      ],
      retryIndexBuild: [
        foreignIndexCase(() =>
          t.mutation(api.public.retryIndexBuild, {
            scopeId,
            indexId: foreignIndex.indexId,
          }),
        ),
      ],
      deleteIndex: [
        foreignIndexCase(() =>
          t.mutation(api.public.deleteIndex, {
            scopeId,
            indexId: foreignIndex.indexId,
          }),
        ),
      ],
      deleteTable: [
        foreignTableCase(() =>
          t.mutation(api.public.deleteTable, {
            scopeId,
            tableId: foreign.tableId,
          }),
        ),
      ],
    };

    expect(Object.keys(model).sort()).toEqual(
      Object.keys(publicFunctions).sort(),
    );
    for (const [operation, cases] of Object.entries(model)) {
      expect(cases.length, operation).toBeGreaterThan(0);
      for (const testCase of cases) {
        await expect(
          testCase.invoke(),
          `${operation}:${testCase.resource}`,
        ).rejects.toThrow(
          /SCOPE_MISMATCH|VALIDATION_FAILED|INVALID_CURSOR|another scope|does not belong|not found/i,
        );
      }
    }

    const sharedKey = "same-key-in-two-scopes";
    const localWrite = await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: local.tableId,
      records: [{ values: valuesFor(local.fieldIds, 20) }],
      idempotencyKey: sharedKey,
    });
    const foreignWrite = await t.mutation(api.public.insertRecords, {
      scopeId: foreignScope,
      tableId: foreign.tableId,
      records: [{ values: valuesFor(foreign.fieldIds, 20) }],
      idempotencyKey: sharedKey,
    });
    expect(foreignWrite[0]!.recordId).not.toBe(localWrite[0]!.recordId);

    function foreignTableCase(invoke: () => Promise<unknown>): IsolationCase {
      return { resource: "tableId", invoke };
    }
    function foreignIndexCase(invoke: () => Promise<unknown>): IsolationCase {
      return { resource: "indexId", invoke };
    }
  });

  test("fails a unique build with historical duplicates", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    const duplicate = valuesFor(created.fieldIds, 1);
    await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: created.tableId,
      records: [
        { values: duplicate },
        {
          values: {
            ...valuesFor(created.fieldIds, 2),
            [created.fieldIds.sourceRef!]:
              duplicate[created.fieldIds.sourceRef!],
          },
        },
      ],
    });
    const { indexId, jobId } = await t.mutation(api.public.createIndex, {
      scopeId,
      tableId: created.tableId,
      name: "sourceRefUnique",
      fieldIds: [created.fieldIds.sourceRef!],
      unique: true,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const schema = await t.query(api.public.getTable, {
      scopeId,
      tableId: created.tableId,
    });
    const index = schema.indexes.find((candidate) => candidate._id === indexId);
    const job = await t.query(api.public.getJob, { scopeId, jobId });
    expect(index?.state).toBe("failed");
    expect(index?.failure?.code).toBe("UNIQUE_CONFLICT");
    expect(job?.state).toBe("failed");
  });

  test("requires an index after the bounded scan threshold", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    for (let batch = 0; batch < 3; batch += 1) {
      const start = batch * 100;
      const count = batch === 2 ? 1 : 100;
      await t.mutation(api.public.insertRecords, {
        scopeId,
        tableId: created.tableId,
        records: Array.from({ length: count }, (_, offset) => ({
          values: valuesFor(created.fieldIds, start + offset),
        })),
      });
    }
    await expect(
      t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: {
          where: [
            {
              fieldId: created.fieldIds.merchant!,
              op: "eq",
              value: "Merchant 1",
            },
          ],
        },
        pagination: { pageSize: 10 },
      }),
    ).rejects.toThrow(/INDEX_REQUIRED|requires a runtime index/);
    const plan = await t.query(api.public.explainQuery, {
      scopeId,
      tableId: created.tableId,
      query: {
        where: [
          {
            fieldId: created.fieldIds.merchant!,
            op: "eq",
            value: "Merchant 1",
          },
        ],
      },
    });
    expect(plan.kind).toBe("indexRequired");
  });

  test("imports 5,000 records twice with stable batch keys and stores 5,000", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    for (let pass = 0; pass < 2; pass += 1) {
      for (let batch = 0; batch < 50; batch += 1) {
        await t.mutation(api.public.insertRecords, {
          scopeId,
          tableId: created.tableId,
          records: Array.from({ length: 100 }, (_, offset) => ({
            values: valuesFor(created.fieldIds, batch * 100 + offset),
          })),
          idempotencyKey: `finance-import-${batch}`,
        });
      }
    }
    const records = await t.run(
      async (ctx) =>
        await ctx.db
          .query("records")
          .withIndex("by_scopeId_and_tableId", (q) =>
            q.eq("scopeId", scopeId).eq("tableId", created.tableId),
          )
          .take(5_001),
    );
    expect(records).toHaveLength(5_000);
  }, 120_000);

  test("paginates an unfiltered table beyond the scan threshold", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    for (let batch = 0; batch < 3; batch += 1) {
      await t.mutation(api.public.insertRecords, {
        scopeId,
        tableId: created.tableId,
        records: Array.from(
          { length: batch === 2 ? 25 : 100 },
          (_, offset) => ({
            values: valuesFor(created.fieldIds, batch * 100 + offset),
          }),
        ),
      });
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: { where: [] },
        pagination: { pageSize: 37, cursor },
      });
      expect(page.plan.kind).toBe("table");
      ids.push(...page.page.map((record) => record._id));
      cursor = page.continueCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(225);
    expect(new Set(ids).size).toBe(225);
  });

  test("rejects multi-range queries without an impossible index suggestion", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    await expect(
      t.query(api.public.explainQuery, {
        scopeId,
        tableId: created.tableId,
        query: {
          where: [
            { fieldId: created.fieldIds.bookingDate!, op: "gte", value: 1 },
            { fieldId: created.fieldIds.amountMinor!, op: "lt", value: 10 },
          ],
        },
      }),
    ).rejects.toThrow(/UNSUPPORTED_QUERY|more than one field/);
  });

  test("makes every emitted index suggestion plannable", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    for (let batch = 0; batch < 3; batch += 1) {
      await t.mutation(api.public.insertRecords, {
        scopeId,
        tableId: created.tableId,
        records: Array.from({ length: batch === 2 ? 1 : 100 }, (_, offset) => ({
          values: valuesFor(created.fieldIds, batch * 100 + offset),
        })),
      });
    }
    const queries = [
      {
        where: [
          {
            fieldId: created.fieldIds.accountId!,
            op: "eq" as const,
            value: "account-1",
          },
        ],
      },
      {
        where: [],
        orderBy: {
          fieldIds: [created.fieldIds.sourceRef!],
          direction: "asc" as const,
        },
      },
      {
        where: [
          {
            fieldId: created.fieldIds.merchant!,
            op: "eq" as const,
            value: "Merchant 1",
          },
          {
            fieldId: created.fieldIds.bookingDate!,
            op: "gte" as const,
            value: 1_700_000_000_000,
          },
        ],
        orderBy: {
          fieldIds: [created.fieldIds.bookingDate!],
          direction: "desc" as const,
        },
      },
    ];
    for (const [position, query] of queries.entries()) {
      const required = await t.query(api.public.explainQuery, {
        scopeId,
        tableId: created.tableId,
        query,
      });
      expect(required.kind).toBe("indexRequired");
      if (required.kind !== "indexRequired") continue;
      await t.mutation(api.public.createIndex, {
        scopeId,
        tableId: created.tableId,
        name: `suggestion${position}`,
        fieldIds: required.suggestedIndex,
        unique: false,
      });
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      const planned = await t.query(api.public.explainQuery, {
        scopeId,
        tableId: created.tableId,
        query,
      });
      expect(planned.kind).toBe("index");
    }
  });

  test("matches an independent scan across 192 competing-index query plans", async () => {
    const t = initConvexTest();
    const testScope = "test-planner-differential";
    const created = await createTransactionsTable(t, testScope);
    for (let start = 0; start < 500; start += 100) {
      await t.mutation(api.public.insertRecords, {
        scopeId: testScope,
        tableId: created.tableId,
        records: Array.from({ length: 100 }, (_, offset) => ({
          values: valuesFor(created.fieldIds, start + offset),
        })),
      });
    }
    for (const [name, fieldIds] of [
      [
        "accountDate",
        [created.fieldIds.accountId!, created.fieldIds.bookingDate!],
      ],
      [
        "accountAmount",
        [created.fieldIds.accountId!, created.fieldIds.amountMinor!],
      ],
      [
        "categoryDate",
        [created.fieldIds.category!, created.fieldIds.bookingDate!],
      ],
      ["sourceRef", [created.fieldIds.sourceRef!]],
    ] as const) {
      await t.mutation(api.public.createIndex, {
        scopeId: testScope,
        tableId: created.tableId,
        name,
        fieldIds: [...fieldIds],
        unique: false,
      });
    }
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const records = await t.run(async (ctx) =>
      ctx.db
        .query("records")
        .withIndex("by_scopeId_and_tableId", (q) =>
          q.eq("scopeId", testScope).eq("tableId", created.tableId),
        )
        .take(501),
    );
    expect(records).toHaveLength(500);

    const cases: QuerySpec[] = [];
    const directions = ["asc", "desc"] as const;
    const rangeOps = ["gte", "lte"] as const;
    const dateThresholds = [0, 70, 140, 210, 280, 350, 420, 490];
    for (const account of ["account-1", "account-2", "account-3"]) {
      for (const threshold of dateThresholds) {
        for (const op of rangeOps) {
          for (const direction of directions) {
            cases.push({
              where: [
                {
                  fieldId: created.fieldIds.accountId!,
                  op: "eq",
                  value: account,
                },
                {
                  fieldId: created.fieldIds.bookingDate!,
                  op,
                  value: 1_700_000_000_000 + threshold * 86_400_000,
                },
              ],
              orderBy: {
                fieldIds: [created.fieldIds.bookingDate!],
                direction,
              },
            });
          }
        }
      }
    }
    for (const account of ["account-1", "account-2", "account-3"]) {
      for (const threshold of [50, 175, 300, 425]) {
        for (const op of rangeOps) {
          for (const direction of directions) {
            cases.push({
              where: [
                {
                  fieldId: created.fieldIds.accountId!,
                  op: "eq",
                  value: account,
                },
                {
                  fieldId: created.fieldIds.amountMinor!,
                  op,
                  value: threshold * 101,
                },
              ],
              orderBy: {
                fieldIds: [created.fieldIds.amountMinor!],
                direction,
              },
            });
          }
        }
      }
    }
    for (const category of ["food", "travel"]) {
      for (const threshold of [50, 175, 300, 425]) {
        for (const op of rangeOps) {
          for (const direction of directions) {
            cases.push({
              where: [
                {
                  fieldId: created.fieldIds.category!,
                  op: "eq",
                  value: category,
                },
                {
                  fieldId: created.fieldIds.bookingDate!,
                  op,
                  value: 1_700_000_000_000 + threshold * 86_400_000,
                },
              ],
              orderBy: {
                fieldIds: [created.fieldIds.bookingDate!],
                direction,
              },
            });
          }
        }
      }
    }
    for (let source = 0; source < 16; source += 1) {
      cases.push({
        where: [
          {
            fieldId: created.fieldIds.sourceRef!,
            op: "eq",
            value: `source-${source * 31}`,
          },
        ],
      });
    }
    expect(cases).toHaveLength(192);

    for (const query of cases) {
      const expected = bruteForceQuery(records, query).map(
        (record) => record._id,
      );
      const actual: Id<"records">[] = [];
      let cursor: string | undefined;
      do {
        const page = await t.query(api.public.queryRecords, {
          scopeId: testScope,
          tableId: created.tableId,
          query,
          pagination: { pageSize: 100, cursor },
        });
        expect(page.plan.kind).toBe("index");
        actual.push(...page.page.map((record) => record._id));
        cursor = page.continueCursor ?? undefined;
      } while (cursor);
      expect(actual).toEqual(expected);
    }
  }, 120_000);

  test.each(
    ["pageSize", "maximumRowsRead", "maximumBytesRead"].flatMap((field) =>
      [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5].map(
        (value) => [field, value] as const,
      ),
    ),
  )("L1 rejects invalid pagination %s=%s", async (field, invalid) => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    await expect(
      t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: { where: [] },
        pagination: { pageSize: 10, [field]: invalid },
      }),
    ).rejects.toThrow(/positive finite integer|VALIDATION_FAILED/);
  });

  test.each([
    ["pageSize", 101],
    ["maximumRowsRead", 1_001],
    ["maximumBytesRead", 4_000_001],
  ] as const)("L1 rejects pagination cap %s=%s", async (field, invalid) => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    await expect(
      t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: { where: [] },
        pagination: { pageSize: 10, [field]: invalid },
      }),
    ).rejects.toThrow(/cannot exceed|LIMIT_EXCEEDED/);
  });

  test("invalidates cursors after a result-shaping schema change", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: created.tableId,
      records: Array.from({ length: 3 }, (_, index) => ({
        values: valuesFor(created.fieldIds, index),
      })),
    });
    const first = await t.query(api.public.queryRecords, {
      scopeId,
      tableId: created.tableId,
      query: { where: [] },
      pagination: { pageSize: 1 },
    });
    await t.mutation(api.public.updateTable, {
      scopeId,
      tableId: created.tableId,
      patch: { name: "Renamed" },
      expectedSchemaRev: 1,
    });
    await expect(
      t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: { where: [] },
        pagination: { pageSize: 1, cursor: first.continueCursor! },
      }),
    ).rejects.toThrow(/INVALID_CURSOR|does not belong/);

    const { indexId } = await t.mutation(api.public.createIndex, {
      scopeId,
      tableId: created.tableId,
      name: "cursorDrop",
      fieldIds: [created.fieldIds.sourceRef!],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const indexed = await t.query(api.public.queryRecords, {
      scopeId,
      tableId: created.tableId,
      query: {
        where: [],
        orderBy: {
          fieldIds: [created.fieldIds.sourceRef!],
          direction: "asc",
        },
      },
      pagination: { pageSize: 1 },
    });
    await t.mutation(api.public.deleteIndex, { scopeId, indexId });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    await expect(
      t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: {
          where: [],
          orderBy: {
            fieldIds: [created.fieldIds.sourceRef!],
            direction: "asc",
          },
        },
        pagination: { pageSize: 1, cursor: indexed.continueCursor! },
      }),
    ).rejects.toThrow(/INVALID_CURSOR|does not belong/);
  });

  test("rejects malformed, oversized, and query-mismatched cursors", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: created.tableId,
      records: Array.from({ length: 3 }, (_, index) => ({
        values: valuesFor(created.fieldIds, index),
      })),
    });
    const first = await t.query(api.public.queryRecords, {
      scopeId,
      tableId: created.tableId,
      query: { where: [] },
      pagination: { pageSize: 1 },
    });
    const bounded = await t.query(api.public.queryRecords, {
      scopeId,
      tableId: created.tableId,
      query: { where: [] },
      pagination: { pageSize: 100, endCursor: first.continueCursor! },
    });
    expect(bounded.page.map((record) => record._id)).toEqual(
      first.page.map((record) => record._id),
    );
    await expect(
      t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: { where: [] },
        pagination: { pageSize: 1, endCursor: "x".repeat(8_193) },
      }),
    ).rejects.toThrow(/INVALID_CURSOR|exceeds/);
    const payload = JSON.parse(
      decodeURIComponent(first.continueCursor!.slice(5)),
    ) as Record<string, unknown>;
    const wrongDirection = `crt2:${encodeURIComponent(
      JSON.stringify({ ...payload, direction: "desc" }),
    )}`;
    const wrongResource = `crt2:${encodeURIComponent(
      JSON.stringify({ ...payload, tableId: "foreign-table" }),
    )}`;
    const wrongScope = `crt2:${encodeURIComponent(
      JSON.stringify({ ...payload, scopeId: "foreign-scope" }),
    )}`;
    const wrongPlan = `crt2:${encodeURIComponent(
      JSON.stringify({ ...payload, plan: `${String(payload.plan)}-tampered` }),
    )}`;
    const wrongSchemaRev = `crt2:${encodeURIComponent(
      JSON.stringify({ ...payload, schemaRev: Number(payload.schemaRev) + 1 }),
    )}`;
    const wrongInner = `crt2:${encodeURIComponent(
      JSON.stringify({ ...payload, inner: "tampered-inner-cursor" }),
    )}`;
    for (const cursor of [
      "not-a-cursor",
      "x".repeat(8_193),
      wrongScope,
      wrongDirection,
      wrongResource,
      wrongPlan,
      wrongSchemaRev,
      wrongInner,
    ]) {
      await expect(
        t.query(api.public.queryRecords, {
          scopeId,
          tableId: created.tableId,
          query: { where: [] },
          pagination: { pageSize: 1, cursor },
        }),
      ).rejects.toThrow(/INVALID_CURSOR|malformed|exceeds/);
    }
    await expect(
      t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: {
          where: [
            {
              fieldId: created.fieldIds.merchant!,
              op: "eq",
              value: "Merchant 1",
            },
          ],
        },
        pagination: { pageSize: 1, cursor: first.continueCursor! },
      }),
    ).rejects.toThrow(/INVALID_CURSOR|does not belong/);

    const { indexId } = await t.mutation(api.public.createIndex, {
      scopeId,
      tableId: created.tableId,
      name: "cursorTamper",
      fieldIds: [created.fieldIds.sourceRef!],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const indexed = await t.query(api.public.queryRecords, {
      scopeId,
      tableId: created.tableId,
      query: {
        where: [],
        orderBy: {
          fieldIds: [created.fieldIds.sourceRef!],
          direction: "asc",
        },
      },
      pagination: { pageSize: 1 },
    });
    const indexPayload = JSON.parse(
      decodeURIComponent(indexed.continueCursor!.slice(5)),
    ) as Record<string, unknown>;
    const wrongIndex = `crt2:${encodeURIComponent(
      JSON.stringify({ ...indexPayload, indexId: `${indexId}-tampered` }),
    )}`;
    await expect(
      t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: {
          where: [],
          orderBy: {
            fieldIds: [created.fieldIds.sourceRef!],
            direction: "asc",
          },
        },
        pagination: { pageSize: 1, cursor: wrongIndex },
      }),
    ).rejects.toThrow(/INVALID_CURSOR|does not belong/);
  });

  test("reports indexed-value limit failures with a bounded record sample", async () => {
    const t = initConvexTest();
    const created = await t.mutation(api.public.createTable, {
      scopeId,
      slug: "long-values",
      name: "Long values",
      fields: [{ key: "value", name: "Value", type: "text", required: true }],
    });
    const fieldId = created.fields[0]!._id;
    const [written] = await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: created.table._id,
      records: [{ values: { [fieldId]: "x".repeat(1_025) } }],
    });
    const { jobId } = await t.mutation(api.public.createIndex, {
      scopeId,
      tableId: created.table._id,
      name: "tooLong",
      fieldIds: [fieldId],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const job = await t.query(api.public.getJob, { scopeId, jobId });
    const schema = await t.query(api.public.getTable, {
      scopeId,
      tableId: created.table._id,
    });
    const index = schema.indexes.find(
      (candidate) => candidate.name === "tooLong",
    );
    expect(job?.state).toBe("failed");
    expect(job?.lastError?.code).toBe("LIMIT_EXCEEDED");
    expect(index?.failure?.samples).toContain(written!.recordId);
  });

  test("enforces field, index, and record-size caps without partial writes", async () => {
    const t = initConvexTest();
    const wide = await t.mutation(api.public.createTable, {
      scopeId,
      slug: "wide-table",
      name: "Wide table",
      fields: Array.from({ length: 200 }, (_, index) => ({
        key: `field${index}`,
        name: `Field ${index}`,
        type: "text" as const,
        required: false,
      })),
    });
    expect(wide.fields).toHaveLength(200);
    await expect(
      t.mutation(api.public.addField, {
        scopeId,
        tableId: wide.table._id,
        field: {
          key: "overflow",
          name: "Overflow",
          type: "text",
          required: false,
        },
        expectedSchemaRev: 1,
      }),
    ).rejects.toThrow(/LIMIT_EXCEEDED|at most 200/);

    const sized = await t.mutation(api.public.createTable, {
      scopeId,
      slug: "sized-table",
      name: "Sized table",
      fields: [{ key: "value", name: "Value", type: "text", required: true }],
    });
    const valueId = sized.fields[0]!._id;
    await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: sized.table._id,
      records: [{ values: { [valueId]: "x".repeat(650_000) } }],
    });
    await expect(
      t.mutation(api.public.insertRecords, {
        scopeId,
        tableId: sized.table._id,
        records: [{ values: { [valueId]: "x".repeat(710_000) } }],
      }),
    ).rejects.toThrow(/LIMIT_EXCEEDED|safety budget/);
    const records = await t.query(api.public.queryRecords, {
      scopeId,
      tableId: sized.table._id,
      query: { where: [] },
      pagination: { pageSize: 10 },
    });
    expect(records.page).toHaveLength(1);

    for (let index = 0; index < 4; index += 1) {
      await t.mutation(api.public.createIndex, {
        scopeId,
        tableId: sized.table._id,
        name: `index${index}`,
        fieldIds: [valueId],
        unique: false,
      });
    }
    await expect(
      t.mutation(api.public.createIndex, {
        scopeId,
        tableId: sized.table._id,
        name: "overflowIndex",
        fieldIds: [valueId],
        unique: false,
      }),
    ).rejects.toThrow(/LIMIT_EXCEEDED|at most 4/);
  });

  test("defines unique null semantics as non-enforcing and rejects null upserts", async () => {
    const t = initConvexTest();
    const created = await t.mutation(api.public.createTable, {
      scopeId,
      slug: "nullable-unique",
      name: "Nullable unique",
      fields: [{ key: "key", name: "Key", type: "text", required: false }],
    });
    const fieldId = created.fields[0]!._id;
    await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: created.table._id,
      records: [{ values: {} }, { values: { [fieldId]: null } }],
    });
    const { indexId } = await t.mutation(api.public.createIndex, {
      scopeId,
      tableId: created.table._id,
      name: "nullableUnique",
      fieldIds: [fieldId],
      unique: true,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const schema = await t.query(api.public.getTable, {
      scopeId,
      tableId: created.table._id,
    });
    expect(schema.indexes.find((index) => index._id === indexId)?.state).toBe(
      "ready",
    );
    await expect(
      t.mutation(api.public.upsertRecords, {
        scopeId,
        tableId: created.table._id,
        uniqueIndexId: indexId,
        records: [{ values: {} }],
      }),
    ).rejects.toThrow(/null|missing|VALIDATION_FAILED/);
  });

  test("validates configured reference targets in scope and table", async () => {
    const t = initConvexTest();
    await expect(
      t.mutation(api.public.createTable, {
        scopeId,
        slug: "invalid-constraint",
        name: "Invalid constraint",
        fields: [
          {
            key: "text",
            name: "Text",
            type: "text",
            required: false,
            constraints: { min: 1 },
          },
        ],
      }),
    ).rejects.toThrow(/applies only|VALIDATION_FAILED/);
    const target = await t.mutation(api.public.createTable, {
      scopeId,
      slug: "reference-target",
      name: "Reference target",
      fields: [],
    });
    const [targetRecord] = await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: target.table._id,
      records: [{ values: {} }],
    });
    const source = await t.mutation(api.public.createTable, {
      scopeId,
      slug: "reference-source",
      name: "Reference source",
      fields: [
        {
          key: "target",
          name: "Target",
          type: "reference",
          required: true,
          constraints: { referenceTableId: target.table._id },
        },
      ],
    });
    const referenceId = source.fields[0]!._id;
    const foreignTarget = await t.mutation(api.public.createTable, {
      scopeId: "scope-b",
      slug: "foreign-reference-target",
      name: "Foreign reference target",
      fields: [],
    });
    await expect(
      t.mutation(api.public.createTable, {
        scopeId,
        slug: "foreign-reference-source",
        name: "Foreign reference source",
        fields: [
          {
            key: "target",
            name: "Target",
            type: "reference",
            required: true,
            constraints: { referenceTableId: foreignTarget.table._id },
          },
        ],
      }),
    ).rejects.toThrow(/SCOPE_MISMATCH|another scope/);
    await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId: source.table._id,
      records: [{ values: { [referenceId]: targetRecord!.recordId } }],
    });
    await expect(
      t.mutation(api.public.insertRecords, {
        scopeId,
        tableId: source.table._id,
        records: [{ values: { [referenceId]: source.table._id } }],
      }),
    ).rejects.toThrow(/Reference target|VALIDATION_FAILED/);
    await t.mutation(api.public.deleteTable, {
      scopeId,
      tableId: target.table._id,
    });
    await expect(
      t.mutation(api.public.insertRecords, {
        scopeId,
        tableId: source.table._id,
        records: [{ values: { [referenceId]: targetRecord!.recordId } }],
      }),
    ).rejects.toThrow(/Table is being deleted|TABLE_DELETING/);
    const records = await t.query(api.public.queryRecords, {
      scopeId,
      tableId: source.table._id,
      query: { where: [] },
      pagination: { pageSize: 10 },
    });
    expect(records.page).toHaveLength(1);
  });

  test("read-only verification detects a deliberately skipped writer update", async () => {
    const t = initConvexTest();
    const testScope = "test-fault-injection";
    const created = await createTransactionsTable(t, testScope);
    const written = await t.mutation(api.public.insertRecords, {
      scopeId: testScope,
      tableId: created.tableId,
      records: [
        { values: valuesFor(created.fieldIds, 1) },
        { values: valuesFor(created.fieldIds, 2) },
      ],
    });
    const { indexId } = await t.mutation(api.public.createIndex, {
      scopeId: testScope,
      tableId: created.tableId,
      name: "sourceRef",
      fieldIds: [created.fieldIds.sourceRef!],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const before = await t.query(api.public.queryRecords, {
      scopeId: testScope,
      tableId: created.tableId,
      query: {
        where: [
          {
            fieldId: created.fieldIds.sourceRef!,
            op: "eq",
            value: "source-1",
          },
        ],
      },
      pagination: { pageSize: 10 },
    });
    expect(before.plan).toMatchObject({ kind: "index", indexId });
    expect(before.page).toHaveLength(1);
    await t.mutation(patchRecordWithoutIndexMaintenance, {
      scopeId: testScope,
      recordId: written[0]!.recordId,
      values: {
        ...valuesFor(created.fieldIds, 1),
        [created.fieldIds.sourceRef!]: "writer-path-was-skipped",
      },
    });
    const { jobId } = await t.mutation(api.public.verifyIndex, {
      scopeId: testScope,
      indexId,
    });
    const during = await t.query(api.public.queryRecords, {
      scopeId: testScope,
      tableId: created.tableId,
      query: {
        where: [
          {
            fieldId: created.fieldIds.sourceRef!,
            op: "eq",
            value: "source-2",
          },
        ],
      },
      pagination: { pageSize: 10 },
    });
    expect(during.plan).toMatchObject({ kind: "index", indexId });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const job = await t.query(api.public.getJob, { scopeId: testScope, jobId });
    const table = await t.query(api.public.getTable, {
      scopeId: testScope,
      tableId: created.tableId,
    });
    const index = table.indexes.find((candidate) => candidate._id === indexId)!;
    expect(job?.state).toBe("failed");
    expect(job?.verification?.stale).toBeGreaterThan(0);
    expect(index.state).toBe("failed");
    expect(index.maintenanceState).toBe("failed");
    const after = await t.query(api.public.queryRecords, {
      scopeId: testScope,
      tableId: created.tableId,
      query: {
        where: [
          {
            fieldId: created.fieldIds.sourceRef!,
            op: "eq",
            value: "writer-path-was-skipped",
          },
        ],
      },
      pagination: { pageSize: 10 },
    });
    expect(after.plan.kind).toBe("scan");
    expect(after.page.map((record) => record._id)).toEqual([
      written[0]!.recordId,
    ]);
  });

  test("indexed reads fail closed on stale and orphaned sidecars", async () => {
    const t = initConvexTest();
    const testScope = "test-index-read-drift";
    const created = await createTransactionsTable(t, testScope);
    const written = await t.mutation(api.public.insertRecords, {
      scopeId: testScope,
      tableId: created.tableId,
      records: [
        { values: valuesFor(created.fieldIds, 1) },
        { values: valuesFor(created.fieldIds, 2) },
      ],
    });
    const { indexId } = await t.mutation(api.public.createIndex, {
      scopeId: testScope,
      tableId: created.tableId,
      name: "sourceRef",
      fieldIds: [created.fieldIds.sourceRef!],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    await t.mutation(patchRecordWithoutIndexMaintenance, {
      scopeId: testScope,
      recordId: written[0]!.recordId,
      values: {
        ...valuesFor(created.fieldIds, 1),
        [created.fieldIds.merchant!]: "Skipped sidecar update",
      },
    });
    await expect(
      t.query(api.public.queryRecords, {
        scopeId: testScope,
        tableId: created.tableId,
        query: {
          where: [
            {
              fieldId: created.fieldIds.sourceRef!,
              op: "eq",
              value: "source-1",
            },
          ],
        },
        pagination: { pageSize: 10 },
      }),
    ).rejects.toThrow(/INDEX_NOT_READY|stale sidecar/);

    await t.mutation(deleteRecordWithoutIndexMaintenance, {
      scopeId: testScope,
      recordId: written[1]!.recordId,
    });
    await expect(
      t.query(api.public.queryRecords, {
        scopeId: testScope,
        tableId: created.tableId,
        query: {
          where: [
            {
              fieldId: created.fieldIds.sourceRef!,
              op: "eq",
              value: "source-2",
            },
          ],
        },
        pagination: { pageSize: 10 },
      }),
    ).rejects.toThrow(/INDEX_NOT_READY|orphaned sidecar/);

    const index = await t.run(async (ctx) =>
      ctx.db.get("indexDefinitions", indexId),
    );
    expect(index?.state).toBe("ready");
  });

  test("a formerly ready unique index blocks writes until repaired", async () => {
    const t = initConvexTest();
    const testScope = "test-unique-fail-closed";
    const created = await createTransactionsTable(t, testScope);
    const [first] = await t.mutation(api.public.insertRecords, {
      scopeId: testScope,
      tableId: created.tableId,
      records: [{ values: valuesFor(created.fieldIds, 1) }],
    });
    const { indexId } = await t.mutation(api.public.createIndex, {
      scopeId: testScope,
      tableId: created.tableId,
      name: "sourceRefUnique",
      fieldIds: [created.fieldIds.sourceRef!],
      unique: true,
    });

    // A unique index that has never been ready must not block population.
    await t.mutation(api.public.insertRecords, {
      scopeId: testScope,
      tableId: created.tableId,
      records: [{ values: valuesFor(created.fieldIds, 2) }],
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(
      (
        await t.query(api.public.getTable, {
          scopeId: testScope,
          tableId: created.tableId,
        })
      ).indexes.find((index) => index._id === indexId),
    ).toMatchObject({
      state: "ready",
      uniqueEnforcementActivated: true,
    });

    await t.mutation(patchRecordWithoutIndexMaintenance, {
      scopeId: testScope,
      recordId: first!.recordId,
      values: {
        ...valuesFor(created.fieldIds, 1),
        [created.fieldIds.merchant!]: "Skipped unique sidecar update",
      },
    });
    const verification = await t.mutation(api.public.verifyIndex, {
      scopeId: testScope,
      indexId,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(
      await t.query(api.public.getJob, {
        scopeId: testScope,
        jobId: verification.jobId,
      }),
    ).toMatchObject({ state: "failed" });

    const beforeRejectedWrites = await t.run(async (ctx) => ({
      records: await ctx.db
        .query("records")
        .withIndex("by_scopeId_and_tableId", (q) =>
          q.eq("scopeId", testScope).eq("tableId", created.tableId),
        )
        .take(10),
      entries: await ctx.db
        .query("indexEntries")
        .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
          q.eq("scopeId", testScope).eq("indexId", indexId),
        )
        .take(10),
    }));
    await expect(
      t.mutation(api.public.insertRecords, {
        scopeId: testScope,
        tableId: created.tableId,
        records: [{ values: valuesFor(created.fieldIds, 3) }],
      }),
    ).rejects.toThrow(/INDEX_NOT_READY|writes are blocked/);
    await expect(
      t.mutation(api.public.insertRecords, {
        scopeId: testScope,
        tableId: created.tableId,
        records: [
          {
            values: {
              ...valuesFor(created.fieldIds, 4),
              [created.fieldIds.sourceRef!]: "source-1",
            },
          },
        ],
      }),
    ).rejects.toThrow(/INDEX_NOT_READY|writes are blocked/);
    const afterRejectedWrites = await t.run(async (ctx) => ({
      records: await ctx.db
        .query("records")
        .withIndex("by_scopeId_and_tableId", (q) =>
          q.eq("scopeId", testScope).eq("tableId", created.tableId),
        )
        .take(10),
      entries: await ctx.db
        .query("indexEntries")
        .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
          q.eq("scopeId", testScope).eq("indexId", indexId),
        )
        .take(10),
    }));
    expect(afterRejectedWrites).toEqual(beforeRejectedWrites);

    await t.mutation(api.public.repairIndex, { scopeId: testScope, indexId });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(
      (
        await t.query(api.public.getTable, {
          scopeId: testScope,
          tableId: created.tableId,
        })
      ).indexes.find((index) => index._id === indexId),
    ).toMatchObject({
      state: "ready",
      uniqueEnforcementActivated: true,
    });
    await expect(
      t.mutation(api.public.insertRecords, {
        scopeId: testScope,
        tableId: created.tableId,
        records: [{ values: valuesFor(created.fieldIds, 3) }],
      }),
    ).resolves.toHaveLength(1);
  });

  test("a failed verified index cannot remain authoritative for a large table", async () => {
    const t = initConvexTest();
    const testScope = "test-failed-index-large-table";
    const created = await createTransactionsTable(t, testScope);
    const written: Array<{ recordId: Id<"records"> }> = [];
    for (let start = 0; start < 201; start += 100) {
      written.push(
        ...(await t.mutation(api.public.insertRecords, {
          scopeId: testScope,
          tableId: created.tableId,
          records: Array.from(
            { length: Math.min(100, 201 - start) },
            (_, offset) => ({
              values: valuesFor(created.fieldIds, start + offset),
            }),
          ),
        })),
      );
    }
    const { indexId } = await t.mutation(api.public.createIndex, {
      scopeId: testScope,
      tableId: created.tableId,
      name: "sourceRef",
      fieldIds: [created.fieldIds.sourceRef!],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    await t.mutation(patchRecordWithoutIndexMaintenance, {
      scopeId: testScope,
      recordId: written[0]!.recordId,
      values: {
        ...valuesFor(created.fieldIds, 0),
        [created.fieldIds.sourceRef!]: "writer-path-was-skipped",
      },
    });
    await t.mutation(api.public.verifyIndex, { scopeId: testScope, indexId });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    await expect(
      t.query(api.public.queryRecords, {
        scopeId: testScope,
        tableId: created.tableId,
        query: {
          where: [
            {
              fieldId: created.fieldIds.sourceRef!,
              op: "eq",
              value: "writer-path-was-skipped",
            },
          ],
        },
        pagination: { pageSize: 10 },
      }),
    ).rejects.toThrow(/INDEX_NOT_READY|failed verification/);
  });

  test("deduplicates active deletes and starts a new generation after failure", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    const { indexId } = await t.mutation(api.public.createIndex, {
      scopeId,
      tableId: created.tableId,
      name: "deleteRetry",
      fieldIds: [created.fieldIds.sourceRef!],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const first = await t.mutation(api.public.deleteIndex, {
      scopeId,
      indexId,
    });
    const duplicate = await t.mutation(api.public.deleteIndex, {
      scopeId,
      indexId,
    });
    expect(duplicate.jobId).toBe(first.jobId);
    await t.run(async (ctx) => {
      await ctx.db.patch("jobs", first.jobId, {
        state: "failed",
        phase: "done",
        lastError: { code: "INJECTED", message: "test failure" },
      });
    });
    const retried = await t.mutation(api.public.deleteIndex, {
      scopeId,
      indexId,
    });
    expect(retried.jobId).not.toBe(first.jobId);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(
      await t.query(api.public.getJob, {
        scopeId,
        jobId: retried.jobId,
      }),
    ).toMatchObject({ state: "succeeded" });
  });

  test("fails a generation-fenced job that makes no progress for five minutes", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t, "test-stalled-job");
    const now = Date.now();
    const ids = await t.run(async (ctx) => {
      const jobId = await ctx.db.insert("jobs", {
        scopeId: "test-stalled-job",
        kind: "buildIndex",
        targetId: "pending",
        state: "running",
        phase: "backfill",
        cursor: null,
        progress: 0,
        generation: 1,
        batchCount: 1,
        retryCount: 0,
        lastError: null,
        createdAt: now - 600_000,
        updatedAt: now - 600_000,
      });
      const indexId = await ctx.db.insert("indexDefinitions", {
        scopeId: "test-stalled-job",
        tableId: created.tableId,
        name: "stalled",
        fieldIds: [created.fieldIds.sourceRef!],
        unique: false,
        state: "building",
        maintenanceState: "backfilling",
        generation: 1,
        activeJobId: jobId,
        failure: null,
        createdAt: now - 600_000,
        updatedAt: now - 600_000,
      });
      await ctx.db.patch("jobs", jobId, { targetId: indexId });
      return { jobId, indexId };
    });
    await t.mutation(internal.maintenance.cleanupExpired, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const job = await t.query(api.public.getJob, {
      scopeId: "test-stalled-job",
      jobId: ids.jobId,
    });
    const table = await t.query(api.public.getTable, {
      scopeId: "test-stalled-job",
      tableId: created.tableId,
    });
    expect(job).toMatchObject({
      state: "failed",
      lastError: { code: "JOB_STALLED" },
    });
    expect(
      table.indexes.find((index) => index._id === ids.indexId),
    ).toMatchObject({ state: "failed", maintenanceState: "failed" });
  });

  test("a stalled verification leaves a ready index serving and can restart", async () => {
    const t = initConvexTest();
    const testScope = "test-stalled-ready-verification";
    const created = await createTransactionsTable(t, testScope);
    await t.mutation(api.public.insertRecords, {
      scopeId: testScope,
      tableId: created.tableId,
      records: [{ values: valuesFor(created.fieldIds, 1) }],
    });
    const built = await t.mutation(api.public.createIndex, {
      scopeId: testScope,
      tableId: created.tableId,
      name: "sourceRef",
      fieldIds: [created.fieldIds.sourceRef!],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const now = Date.now();
    const stalled = await t.run(async (ctx) => {
      const index = (await ctx.db.get("indexDefinitions", built.indexId))!;
      const generation = (index.generation ?? 0) + 1;
      const jobId = await ctx.db.insert("jobs", {
        scopeId: testScope,
        kind: "verifyIndex",
        targetId: index._id,
        state: "running",
        phase: "verifyRecords",
        cursor: null,
        progress: 0,
        generation,
        batchCount: 1,
        retryCount: 0,
        lastError: null,
        createdAt: now - 600_000,
        updatedAt: now - 600_000,
      });
      await ctx.db.patch("indexDefinitions", index._id, {
        generation,
        activeJobId: jobId,
        maintenanceState: "verifying",
        updatedAt: now - 600_000,
      });
      return { jobId, generation };
    });
    await t.mutation(internal.maintenance.cleanupExpired, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(
      await t.query(api.public.getJob, {
        scopeId: testScope,
        jobId: stalled.jobId,
      }),
    ).toMatchObject({
      state: "failed",
      lastError: { code: "JOB_STALLED" },
    });
    expect(
      (
        await t.query(api.public.getTable, {
          scopeId: testScope,
          tableId: created.tableId,
        })
      ).indexes.find((index) => index._id === built.indexId),
    ).toMatchObject({ state: "ready", maintenanceState: "failed" });

    const restarted = await t.mutation(api.public.verifyIndex, {
      scopeId: testScope,
      indexId: built.indexId,
    });
    expect(restarted.jobId).not.toBe(stalled.jobId);
    const restartedJob = await t.query(api.public.getJob, {
      scopeId: testScope,
      jobId: restarted.jobId,
    });
    expect(restartedJob?.generation).toBeGreaterThan(stalled.generation);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(
      await t.query(api.public.getJob, {
        scopeId: testScope,
        jobId: restarted.jobId,
      }),
    ).toMatchObject({ state: "succeeded" });
    expect(
      (
        await t.query(api.public.getTable, {
          scopeId: testScope,
          tableId: created.tableId,
        })
      ).indexes.find((index) => index._id === built.indexId),
    ).toMatchObject({ state: "ready", maintenanceState: "idle" });
  });

  test("reschedules stalled-job cleanup when one state exceeds the sweep cap", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t, "test-stalled-cap");
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let offset = 0; offset < 101; offset += 1) {
        const jobId = await ctx.db.insert("jobs", {
          scopeId: "test-stalled-cap",
          kind: "buildIndex",
          targetId: "pending",
          state: "running",
          phase: "backfill",
          cursor: null,
          progress: 0,
          generation: 1,
          batchCount: 1,
          retryCount: 0,
          lastError: null,
          createdAt: now - 600_000,
          updatedAt: now - 600_000,
        });
        const indexId = await ctx.db.insert("indexDefinitions", {
          scopeId: "test-stalled-cap",
          tableId: created.tableId,
          name: `stalled-${offset}`,
          fieldIds: [created.fieldIds.sourceRef!],
          unique: false,
          state: "building",
          maintenanceState: "backfilling",
          generation: 1,
          activeJobId: jobId,
          failure: null,
          createdAt: now - 600_000,
          updatedAt: now - 600_000,
        });
        await ctx.db.patch("jobs", jobId, { targetId: indexId });
      }
    });
    await t.mutation(internal.maintenance.cleanupExpired, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const states = await t.run(async (ctx) => ({
      failed: await ctx.db
        .query("jobs")
        .withIndex("by_scopeId_and_state", (q) =>
          q.eq("scopeId", "test-stalled-cap").eq("state", "failed"),
        )
        .take(102),
      running: await ctx.db
        .query("jobs")
        .withIndex("by_scopeId_and_state", (q) =>
          q.eq("scopeId", "test-stalled-cap").eq("state", "running"),
        )
        .take(1),
    }));
    expect(states.failed).toHaveLength(101);
    expect(states.running).toHaveLength(0);
  });

  test("paginates listTables without silent truncation", async () => {
    const t = initConvexTest();
    for (let index = 0; index < 12; index += 1) {
      await t.mutation(api.public.createTable, {
        scopeId,
        slug: `table-${index}`,
        name: `Table ${index}`,
        fields: [],
      });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await t.query(api.public.listTables, {
        scopeId,
        pagination: { pageSize: 5, cursor },
      });
      seen.push(...result.page.map((table) => table._id));
      cursor = result.continueCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(12);
  });
});

type TestInstance = ReturnType<typeof initConvexTest>;

async function createTransactionsTable(
  t: TestInstance,
  targetScope = scopeId,
): Promise<{
  tableId: Id<"tables">;
  fieldIds: Record<string, Id<"fields">>;
}> {
  const created = await t.mutation(api.public.createTable, {
    scopeId: targetScope,
    slug: "transactions",
    name: "Transactions",
    fields: [
      { key: "accountId", name: "Account", type: "reference", required: true },
      {
        key: "bookingDate",
        name: "Booking date",
        type: "timestamp",
        required: true,
      },
      { key: "amountMinor", name: "Amount", type: "number", required: true },
      { key: "currency", name: "Currency", type: "text", required: true },
      { key: "merchant", name: "Merchant", type: "text", required: true },
      {
        key: "category",
        name: "Category",
        type: "select",
        required: true,
        constraints: {
          selectOptions: [
            { code: "food", label: "Food" },
            { code: "travel", label: "Travel" },
          ],
        },
      },
      {
        key: "sourceRef",
        name: "Source reference",
        type: "text",
        required: true,
      },
    ],
  });
  return {
    tableId: created.table._id,
    fieldIds: Object.fromEntries(
      created.fields.map((field) => [field.key, field._id]),
    ),
  };
}

function valuesFor(fieldIds: Record<string, Id<"fields">>, index: number) {
  return {
    [fieldIds.accountId!]: `account-${(index % 3) + 1}`,
    [fieldIds.bookingDate!]: 1_700_000_000_000 + index * 86_400_000,
    [fieldIds.amountMinor!]: index * 101,
    [fieldIds.currency!]: "EUR",
    [fieldIds.merchant!]: `Merchant ${index}`,
    [fieldIds.category!]: index % 2 === 0 ? "food" : "travel",
    [fieldIds.sourceRef!]: `source-${index}`,
  };
}

function bruteForceQuery(
  records: Doc<"records">[],
  query: QuerySpec,
): Doc<"records">[] {
  const matches = records.filter((record) =>
    query.where.every((predicate) => {
      const comparison = compareTestScalars(
        record.values[predicate.fieldId],
        predicate.value,
      );
      if (predicate.op === "eq") return comparison === 0;
      if (predicate.op === "lt") return comparison < 0;
      if (predicate.op === "lte") return comparison <= 0;
      if (predicate.op === "gt") return comparison > 0;
      return comparison >= 0;
    }),
  );
  if (!query.orderBy) return matches;
  const multiplier = query.orderBy.direction === "asc" ? 1 : -1;
  return matches.sort((left, right) => {
    for (const fieldId of query.orderBy!.fieldIds) {
      const comparison = compareTestScalars(
        left.values[fieldId],
        right.values[fieldId],
      );
      if (comparison !== 0) return comparison * multiplier;
    }
    return 0;
  });
}

function compareTestScalars(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  if (typeof left === "number" && typeof right === "number")
    return left < right ? -1 : 1;
  if (typeof left === "string" && typeof right === "string")
    return left < right ? -1 : 1;
  if (typeof left === "boolean" && typeof right === "boolean")
    return left ? 1 : -1;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  throw new Error("Differential test compared unlike scalar types");
}
