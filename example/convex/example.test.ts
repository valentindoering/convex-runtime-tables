import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

describe("host integration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("host and component writes roll back atomically", async () => {
    const t = initConvexTest();
    const { tableId } = await t.mutation(api.example.initializeDemo, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    await expect(
      t.mutation(api.example.forceAtomicRollback, { tableId }),
    ).rejects.toThrow("forced rollback");
    const auditRows = await t.run(
      async (ctx) => await ctx.db.query("hostAudit").take(10),
    );
    const result = await t.query(api.example.listTransactions, { tableId });
    expect(auditRows).toHaveLength(0);
    expect(result.page).toHaveLength(0);
  });

  test("New inserts an Untitled row that the host wrapper observes", async () => {
    const t = initConvexTest();
    const { tableId } = await t.mutation(api.example.initializeDemo, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const schema = await t.query(api.example.getDemoSchema, {});
    expect(schema).not.toBeNull();
    const fields = Object.fromEntries(
      schema!.fields.map((field) => [field.key, field.fieldId]),
    );
    expect(
      (await t.query(api.example.listTransactions, { tableId })).page,
    ).toHaveLength(0);
    const created = await t.mutation(api.example.addTransaction, {
      tableId,
      accountId: "account-2",
      category: "travel",
    });
    expect(created.rev).toBe(1);
    const after = await t.query(api.example.listTransactions, { tableId });
    expect(after.page).toHaveLength(1);
    expect(after.page[0]!.values[fields.merchant!]).toBe("Untitled");
    expect(after.page[0]!.values[fields.accountId!]).toBe("account-2");
    expect(after.page[0]!.values[fields.category!]).toBe("travel");
    expect(after.page[0]!.values[fields.amountMinor!]).toBe(0);
  });

  test("inline visible-field patches advance revisions and reject stale writes", async () => {
    const t = initConvexTest();
    const { tableId } = await t.mutation(api.example.initializeDemo, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const schema = await t.query(api.example.getDemoSchema, {});
    const fields = Object.fromEntries(
      schema!.fields.map((field) => [field.key, field.fieldId]),
    );
    const created = await t.mutation(api.example.addTransaction, {
      tableId,
      accountId: "account-1",
      category: "other",
    });
    const bookingDate = Date.UTC(2026, 8, 1);
    const updated = await t.mutation(api.example.updateTransaction, {
      tableId,
      recordId: created.recordId,
      expectedRev: created.rev,
      patch: {
        merchant: "Edited inline",
        category: "software",
        accountId: "account-3",
        bookingDate,
        amountMinor: 4250,
      },
    });
    expect(updated.rev).toBe(created.rev + 1);

    const after = await t.query(api.example.listTransactions, { tableId });
    const record = after.page.find((item) => item._id === created.recordId)!;
    expect(record.values[fields.merchant!]).toBe("Edited inline");
    expect(record.values[fields.category!]).toBe("software");
    expect(record.values[fields.accountId!]).toBe("account-3");
    expect(record.values[fields.bookingDate!]).toBe(bookingDate);
    expect(record.values[fields.amountMinor!]).toBe(4250);

    await expect(
      t.mutation(api.example.updateTransaction, {
        tableId,
        recordId: created.recordId,
        expectedRev: created.rev,
        patch: { merchant: "Stale edit" },
      }),
    ).rejects.toThrow(/CONFLICT/);
    const afterConflict = await t.query(api.example.listTransactions, {
      tableId,
    });
    expect(
      afterConflict.page.find((item) => item._id === created.recordId)!.values[
        fields.merchant!
      ],
    ).toBe("Edited inline");
  });

  test("the showcase selects runtime indexes and maintains revisions", async () => {
    const t = initConvexTest();
    const { tableId } = await t.mutation(api.example.initializeDemo, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const schema = await t.query(api.example.getDemoSchema, {});
    expect(schema?.indexes).toHaveLength(4);
    expect(schema?.indexes.every((index) => index.state === "ready")).toBe(
      true,
    );
    await t.mutation(api.example.seedTransactions, { tableId });

    const newest = await t.query(api.example.browseTransactions, {
      tableId,
      direction: "desc",
    });
    expect(newest.plan).toMatchObject({
      kind: "index",
      indexName: "byBookingDate",
      postFiltered: false,
    });
    expect(newest.page).toHaveLength(6);

    const account = await t.query(api.example.browseTransactions, {
      tableId,
      accountId: "account-1",
      direction: "desc",
    });
    expect(account.plan).toMatchObject({
      kind: "index",
      indexName: "accountBookingDate",
      postFiltered: false,
    });

    const residual = await t.query(api.example.browseTransactions, {
      tableId,
      accountId: "account-1",
      category: "food",
      direction: "desc",
    });
    expect(residual.plan.kind).toBe("index");
    expect(residual.plan.postFiltered).toBe(true);

    const amountFieldId = schema!.fields.find(
      (field) => field.key === "amountMinor",
    )!.fieldId;
    const record = newest.page[0]!;
    const adjusted = await t.mutation(api.example.adjustTransaction, {
      tableId,
      recordId: record._id,
      amountFieldId,
      amountMinor: Number(record.values[amountFieldId]) + 100,
      expectedRev: record.rev,
    });
    expect(adjusted.rev).toBe(record.rev + 1);

    await t.mutation(api.example.deleteTransaction, {
      tableId,
      recordId: record._id,
      expectedRev: adjusted.rev,
    });
    const afterDelete = await t.query(api.example.listTransactions, {
      tableId,
    });
    expect(afterDelete.page.some((item) => item._id === record._id)).toBe(
      false,
    );
  });
});
