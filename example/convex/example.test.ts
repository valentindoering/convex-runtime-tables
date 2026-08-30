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

  test("the host wrapper observes a component mutation on its next reactive read", async () => {
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
    await t.mutation(api.example.addTransaction, {
      tableId,
      fieldIds: {
        accountId: fields.accountId!,
        bookingDate: fields.bookingDate!,
        amountMinor: fields.amountMinor!,
        currency: fields.currency!,
        merchant: fields.merchant!,
        category: fields.category!,
        sourceRef: fields.sourceRef!,
      },
      merchant: "Reactive Merchant",
      amountMinor: 1234,
      category: "food",
    });
    const after = await t.query(api.example.listTransactions, { tableId });
    expect(after.page).toHaveLength(1);
    expect(after.page[0]!.values[fields.merchant!]).toBe("Reactive Merchant");
  });
});
