/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { initConvexTest } from "./setup.test.js";

const scopeId = "scope-a";

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
    ).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED|different request/);
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
    const schema = await t.query(api.public.getTable, { scopeId, tableId: created.tableId });
    expect(schema.indexes.find((index) => index._id === indexId)?.state).toBe("ready");

    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await t.query(api.public.queryRecords, {
        scopeId,
        tableId: created.tableId,
        query: {
          where: [
            { fieldId: created.fieldIds.accountId!, op: "eq", value: "account-1" },
            { fieldId: created.fieldIds.bookingDate!, op: "gte", value: 1_700_000_000_000 },
          ],
          orderBy: { fieldIds: [created.fieldIds.bookingDate!], direction: "asc" },
        },
        pagination: { pageSize: 4, cursor },
      });
      expect(page.plan.kind).toBe("index");
      seen.push(...page.page.map((record) => Number(record.values[created.fieldIds.bookingDate!]!)));
      cursor = page.continueCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([...seen].sort((left, right) => left - right));
    expect(seen).toHaveLength(10);
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

  test("fails closed for another scope's resource IDs", async () => {
    const t = initConvexTest();
    const created = await createTransactionsTable(t);
    await expect(
      t.query(api.public.getTable, { scopeId: "scope-b", tableId: created.tableId }),
    ).rejects.toThrow(/SCOPE_MISMATCH|another scope/);
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
            [created.fieldIds.sourceRef!]: duplicate[created.fieldIds.sourceRef!],
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
    const schema = await t.query(api.public.getTable, { scopeId, tableId: created.tableId });
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
            { fieldId: created.fieldIds.merchant!, op: "eq", value: "Merchant 1" },
          ],
        },
        pagination: { pageSize: 10 },
      }),
    ).rejects.toThrow(/INDEX_REQUIRED|requires a runtime index/);
    const plan = await t.query(api.public.explainQuery, {
      scopeId,
      tableId: created.tableId,
      query: {
        where: [{ fieldId: created.fieldIds.merchant!, op: "eq", value: "Merchant 1" }],
      },
    });
    expect(plan.kind).toBe("indexRequired");
  });

  test(
    "imports 5,000 records twice with stable batch keys and stores 5,000",
    async () => {
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
      const records = await t.run(async (ctx) =>
        await ctx.db
          .query("records")
          .withIndex("by_scopeId_and_tableId", (q) =>
            q.eq("scopeId", scopeId).eq("tableId", created.tableId),
          )
          .take(5_001),
      );
      expect(records).toHaveLength(5_000);
    },
    120_000,
  );
});

type TestInstance = ReturnType<typeof initConvexTest>;

async function createTransactionsTable(t: TestInstance): Promise<{
  tableId: Id<"tables">;
  fieldIds: Record<string, Id<"fields">>;
}> {
  const created = await t.mutation(api.public.createTable, {
    scopeId,
    slug: "transactions",
    name: "Transactions",
    fields: [
      { key: "accountId", name: "Account", type: "reference", required: true },
      { key: "bookingDate", name: "Booking date", type: "timestamp", required: true },
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
      { key: "sourceRef", name: "Source reference", type: "text", required: true },
    ],
  });
  return {
    tableId: created.table._id,
    fieldIds: Object.fromEntries(created.fields.map((field) => [field.key, field._id])),
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
