import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { mutation, query } from "./_generated/server.js";

const DEMO_SCOPE = "finance-demo";
const DEMO_SLUG = "transactions";
const scalar = v.union(v.null(), v.boolean(), v.number(), v.string());
const category = v.union(
  v.literal("food"),
  v.literal("travel"),
  v.literal("software"),
  v.literal("other"),
);
const accountId = v.union(
  v.literal("account-1"),
  v.literal("account-2"),
  v.literal("account-3"),
);
const direction = v.union(v.literal("asc"), v.literal("desc"));
const planKind = v.union(
  v.literal("index"),
  v.literal("table"),
  v.literal("scan"),
);
const fieldSummary = v.object({
  fieldId: v.string(),
  key: v.string(),
  name: v.string(),
  type: v.string(),
  required: v.boolean(),
});
const indexSummary = v.object({
  indexId: v.string(),
  name: v.string(),
  fieldIds: v.array(v.string()),
  state: v.string(),
  maintenanceState: v.string(),
  unique: v.boolean(),
});
const schemaSummary = v.object({
  tableId: v.string(),
  schemaRev: v.number(),
  fields: v.array(fieldSummary),
  indexes: v.array(indexSummary),
});
const recordEnvelope = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  scopeId: v.string(),
  tableId: v.string(),
  values: v.record(v.string(), scalar),
  rev: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function desiredIndexes(fieldIds: Record<string, string>) {
  return [
    {
      name: "sourceRefUnique",
      fieldIds: [fieldIds.sourceRef!],
      unique: true,
    },
    {
      name: "byBookingDate",
      fieldIds: [fieldIds.bookingDate!],
      unique: false,
    },
    {
      name: "accountBookingDate",
      fieldIds: [fieldIds.accountId!, fieldIds.bookingDate!],
      unique: false,
    },
    {
      name: "categoryBookingDate",
      fieldIds: [fieldIds.category!, fieldIds.bookingDate!],
      unique: false,
    },
  ];
}

export const initializeDemo = mutation({
  args: {},
  returns: v.object({ tableId: v.string(), jobIds: v.array(v.string()) }),
  handler: async (ctx) => {
    const tables = await ctx.runQuery(
      components.runtimeTables.public.listTables,
      {
        scopeId: DEMO_SCOPE,
        pagination: { pageSize: 100 },
      },
    );
    const existing = tables.page.find((table) => table.slug === DEMO_SLUG);
    let tableId: string;
    let fieldIds: Record<string, string>;
    let existingIndexNames: Set<string>;

    if (existing) {
      const schema = await ctx.runQuery(
        components.runtimeTables.public.getTable,
        {
          scopeId: DEMO_SCOPE,
          tableId: existing._id,
        },
      );
      tableId = schema.table._id;
      fieldIds = Object.fromEntries(
        schema.fields.map((field) => [field.key, field._id]),
      );
      existingIndexNames = new Set(schema.indexes.map((index) => index.name));
    } else {
      const created = await ctx.runMutation(
        components.runtimeTables.public.createTable,
        {
          scopeId: DEMO_SCOPE,
          slug: DEMO_SLUG,
          name: "Transactions",
          fields: [
            {
              key: "accountId",
              name: "Account",
              type: "reference",
              required: true,
            },
            {
              key: "bookingDate",
              name: "Booking date",
              type: "timestamp",
              required: true,
            },
            {
              key: "amountMinor",
              name: "Amount",
              type: "number",
              required: true,
            },
            {
              key: "currency",
              name: "Currency",
              type: "text",
              required: true,
              constraints: { maxBytes: 3 },
            },
            {
              key: "merchant",
              name: "Merchant",
              type: "text",
              required: true,
              constraints: { maxBytes: 200 },
            },
            {
              key: "category",
              name: "Category",
              type: "select",
              required: true,
              constraints: {
                selectOptions: [
                  { code: "food", label: "Food" },
                  { code: "travel", label: "Travel" },
                  { code: "software", label: "Software" },
                  { code: "other", label: "Other" },
                ],
              },
            },
            {
              key: "sourceRef",
              name: "Source reference",
              type: "text",
              required: true,
              constraints: { maxBytes: 100 },
            },
          ],
        },
      );
      tableId = created.table._id;
      fieldIds = Object.fromEntries(
        created.fields.map((field) => [field.key, field._id]),
      );
      existingIndexNames = new Set();
    }

    const jobIds: string[] = [];
    for (const request of desiredIndexes(fieldIds)) {
      if (existingIndexNames.has(request.name)) continue;
      const result = await ctx.runMutation(
        components.runtimeTables.public.createIndex,
        {
          scopeId: DEMO_SCOPE,
          tableId,
          ...request,
        },
      );
      jobIds.push(result.jobId);
    }
    return { tableId, jobIds };
  },
});

export const getDemoSchema = query({
  args: {},
  returns: v.union(v.null(), schemaSummary),
  handler: async (ctx) => {
    const tables = await ctx.runQuery(
      components.runtimeTables.public.listTables,
      {
        scopeId: DEMO_SCOPE,
        pagination: { pageSize: 100 },
      },
    );
    const table = tables.page.find((candidate) => candidate.slug === DEMO_SLUG);
    if (!table) return null;
    const schema = await ctx.runQuery(
      components.runtimeTables.public.getTable,
      {
        scopeId: DEMO_SCOPE,
        tableId: table._id,
      },
    );
    return {
      tableId: schema.table._id,
      schemaRev: schema.table.schemaRev,
      fields: schema.fields.map((field) => ({
        fieldId: field._id,
        key: field.key,
        name: field.name,
        type: field.type,
        required: field.required,
      })),
      indexes: schema.indexes.map((index) => ({
        indexId: index._id,
        name: index.name,
        fieldIds: index.fieldIds,
        state: index.state,
        maintenanceState: index.maintenanceState ?? "idle",
        unique: index.unique,
      })),
    };
  },
});

export const listTransactions = query({
  args: { tableId: v.string(), cursor: v.optional(v.string()) },
  returns: v.object({
    page: v.array(recordEnvelope),
    isDone: v.boolean(),
    continueCursor: v.union(v.null(), v.string()),
    planKind: v.string(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.runQuery(
      components.runtimeTables.public.queryRecords,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
        query: { where: [] },
        pagination: { pageSize: 100, cursor: args.cursor },
      },
    );
    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      planKind: result.plan.kind,
    };
  },
});

export const browseTransactions = query({
  args: {
    tableId: v.string(),
    accountId: v.optional(v.string()),
    category: v.optional(category),
    direction,
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(recordEnvelope),
    isDone: v.boolean(),
    continueCursor: v.union(v.null(), v.string()),
    plan: v.object({
      kind: planKind,
      indexId: v.union(v.null(), v.string()),
      indexName: v.union(v.null(), v.string()),
      postFiltered: v.boolean(),
    }),
  }),
  handler: async (ctx, args) => {
    const schema = await ctx.runQuery(
      components.runtimeTables.public.getTable,
      { scopeId: DEMO_SCOPE, tableId: args.tableId },
    );
    const fieldIds = Object.fromEntries(
      schema.fields.map((field) => [field.key, field._id]),
    );
    const where = [];
    if (args.accountId) {
      where.push({
        fieldId: fieldIds.accountId!,
        op: "eq" as const,
        value: args.accountId,
      });
    }
    if (args.category) {
      where.push({
        fieldId: fieldIds.category!,
        op: "eq" as const,
        value: args.category,
      });
    }
    const result = await ctx.runQuery(
      components.runtimeTables.public.queryRecords,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
        query: {
          where,
          orderBy: {
            fieldIds: [fieldIds.bookingDate!],
            direction: args.direction,
          },
        },
        pagination: {
          pageSize: 8,
          ...(args.cursor ? { cursor: args.cursor } : {}),
        },
      },
    );
    const selectedIndexId =
      result.plan.kind === "index" ? result.plan.indexId : null;
    const selectedIndex = selectedIndexId
      ? schema.indexes.find((index) => index._id === selectedIndexId)
      : null;
    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      plan: {
        kind: result.plan.kind,
        indexId: selectedIndexId,
        indexName: selectedIndex?.name ?? null,
        postFiltered: result.plan.postFiltered,
      },
    };
  },
});

export const getDemoSummary = query({
  args: { tableId: v.string() },
  returns: v.object({
    recordCount: v.number(),
    countIsExact: v.boolean(),
    netAmountMinor: v.number(),
    accountCount: v.number(),
    lastUpdatedAt: v.union(v.null(), v.number()),
  }),
  handler: async (ctx, args) => {
    const schema = await ctx.runQuery(
      components.runtimeTables.public.getTable,
      { scopeId: DEMO_SCOPE, tableId: args.tableId },
    );
    const fieldIds = Object.fromEntries(
      schema.fields.map((field) => [field.key, field._id]),
    );
    const result = await ctx.runQuery(
      components.runtimeTables.public.queryRecords,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
        query: { where: [] },
        pagination: { pageSize: 100 },
      },
    );
    return {
      recordCount: result.page.length,
      countIsExact: result.isDone,
      netAmountMinor: result.page.reduce(
        (total, record) =>
          total + Number(record.values[fieldIds.amountMinor!] ?? 0),
        0,
      ),
      accountCount: new Set(
        result.page.map((record) =>
          String(record.values[fieldIds.accountId!] ?? ""),
        ),
      ).size,
      lastUpdatedAt:
        result.page.reduce(
          (latest, record) => Math.max(latest, record.updatedAt),
          0,
        ) || null,
    };
  },
});

export const seedTransactions = mutation({
  args: { tableId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const schema = await ctx.runQuery(
      components.runtimeTables.public.getTable,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
      },
    );
    const fieldIds = Object.fromEntries(
      schema.fields.map((field) => [field.key, field._id]),
    );
    const uniqueIndex = schema.indexes.find(
      (index) => index.name === "sourceRefUnique",
    );
    if (!uniqueIndex || uniqueIndex.state !== "ready") {
      throw new Error("The unique runtime index is still being built");
    }
    const samples = [
      {
        accountId: "account-1",
        bookingDate: Date.UTC(2026, 7, 22),
        amountMinor: -4820,
        merchant: "North Star Market",
        category: "food",
        sourceRef: "demo-001",
      },
      {
        accountId: "account-2",
        bookingDate: Date.UTC(2026, 7, 20),
        amountMinor: -12900,
        merchant: "Rail Europe",
        category: "travel",
        sourceRef: "demo-002",
      },
      {
        accountId: "account-1",
        bookingDate: Date.UTC(2026, 7, 18),
        amountMinor: -1900,
        merchant: "Linear",
        category: "software",
        sourceRef: "demo-003",
      },
      {
        accountId: "account-3",
        bookingDate: Date.UTC(2026, 7, 15),
        amountMinor: -850,
        merchant: "Corner Office Coffee",
        category: "food",
        sourceRef: "demo-004",
      },
      {
        accountId: "account-2",
        bookingDate: Date.UTC(2026, 7, 12),
        amountMinor: -2460,
        merchant: "City Taxi",
        category: "travel",
        sourceRef: "demo-005",
      },
      {
        accountId: "account-1",
        bookingDate: Date.UTC(2026, 7, 1),
        amountMinor: 320000,
        merchant: "ACME Payroll",
        category: "other",
        sourceRef: "demo-006",
      },
    ] as const;
    const desiredSourceRefs = new Set<string>(
      samples.map((sample) => sample.sourceRef),
    );
    const existing = await ctx.runQuery(
      components.runtimeTables.public.queryRecords,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
        query: { where: [] },
        pagination: { pageSize: 100 },
      },
    );
    if (!existing.isDone) {
      throw new Error("The local sample reset exceeded its bounded page");
    }
    for (const record of existing.page) {
      const sourceRef = String(record.values[fieldIds.sourceRef!] ?? "");
      if (!desiredSourceRefs.has(sourceRef)) {
        await ctx.runMutation(components.runtimeTables.public.deleteRecord, {
          scopeId: DEMO_SCOPE,
          tableId: args.tableId,
          recordId: record._id,
          expectedRev: record.rev,
        });
      }
    }
    const records = samples.map((sample) => ({
      values: {
        [fieldIds.accountId!]: sample.accountId,
        [fieldIds.bookingDate!]: sample.bookingDate,
        [fieldIds.amountMinor!]: sample.amountMinor,
        [fieldIds.currency!]: "EUR",
        [fieldIds.merchant!]: sample.merchant,
        [fieldIds.category!]: sample.category,
        [fieldIds.sourceRef!]: sample.sourceRef,
      },
    }));
    const result = await ctx.runMutation(
      components.runtimeTables.public.upsertRecords,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
        uniqueIndexId: uniqueIndex._id,
        records,
      },
    );
    return result.length;
  },
});

export const addTransaction = mutation({
  args: {
    tableId: v.string(),
    accountId,
    category,
  },
  returns: v.object({ recordId: v.string(), rev: v.number() }),
  handler: async (ctx, args) => {
    const schema = await ctx.runQuery(
      components.runtimeTables.public.getTable,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
      },
    );
    const fieldIds = Object.fromEntries(
      schema.fields.map((field) => [field.key, field._id]),
    );
    const result = await ctx.runMutation(
      components.runtimeTables.public.insertRecords,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
        records: [
          {
            values: {
              [fieldIds.accountId!]: args.accountId,
              [fieldIds.bookingDate!]: Date.now(),
              [fieldIds.amountMinor!]: 0,
              [fieldIds.currency!]: "EUR",
              [fieldIds.merchant!]: "Untitled",
              [fieldIds.category!]: args.category,
              [fieldIds.sourceRef!]: `manual-${crypto.randomUUID()}`,
            },
          },
        ],
      },
    );
    return result[0]!;
  },
});

export const updateTransaction = mutation({
  args: {
    tableId: v.string(),
    recordId: v.string(),
    expectedRev: v.number(),
    patch: v.object({
      merchant: v.optional(v.string()),
      category: v.optional(category),
      accountId: v.optional(accountId),
      bookingDate: v.optional(v.number()),
      amountMinor: v.optional(v.number()),
    }),
  },
  returns: v.object({ recordId: v.string(), rev: v.number() }),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.expectedRev) || args.expectedRev < 1) {
      throw new Error("expectedRev must be a positive integer");
    }
    const schema = await ctx.runQuery(
      components.runtimeTables.public.getTable,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
      },
    );
    const fieldIds = Object.fromEntries(
      schema.fields.map((field) => [field.key, field._id]),
    );
    const values: Record<string, string | number> = {};
    if (args.patch.merchant !== undefined) {
      const merchant = args.patch.merchant.trim();
      if (
        merchant.length === 0 ||
        new TextEncoder().encode(merchant).byteLength > 200
      ) {
        throw new Error("Name must be between 1 and 200 UTF-8 bytes");
      }
      values[fieldIds.merchant!] = merchant;
    }
    if (args.patch.category !== undefined) {
      values[fieldIds.category!] = args.patch.category;
    }
    if (args.patch.accountId !== undefined) {
      values[fieldIds.accountId!] = args.patch.accountId;
    }
    if (args.patch.bookingDate !== undefined) {
      if (!Number.isFinite(args.patch.bookingDate)) {
        throw new Error("Date must be finite");
      }
      values[fieldIds.bookingDate!] = args.patch.bookingDate;
    }
    if (args.patch.amountMinor !== undefined) {
      if (!Number.isFinite(args.patch.amountMinor)) {
        throw new Error("Amount must be finite");
      }
      values[fieldIds.amountMinor!] = args.patch.amountMinor;
    }
    if (Object.keys(values).length === 0) {
      throw new Error("At least one visible field must be provided");
    }
    return await ctx.runMutation(components.runtimeTables.public.patchRecord, {
      scopeId: DEMO_SCOPE,
      tableId: args.tableId,
      recordId: args.recordId,
      patch: { values },
      expectedRev: args.expectedRev,
    });
  },
});

export const adjustTransaction = mutation({
  args: {
    tableId: v.string(),
    recordId: v.string(),
    amountFieldId: v.string(),
    amountMinor: v.number(),
    expectedRev: v.number(),
  },
  returns: v.object({ recordId: v.string(), rev: v.number() }),
  handler: async (ctx, args) =>
    await ctx.runMutation(components.runtimeTables.public.patchRecord, {
      scopeId: DEMO_SCOPE,
      tableId: args.tableId,
      recordId: args.recordId,
      patch: { values: { [args.amountFieldId]: args.amountMinor } },
      expectedRev: args.expectedRev,
    }),
});

export const deleteTransaction = mutation({
  args: {
    tableId: v.string(),
    recordId: v.string(),
    expectedRev: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) =>
    await ctx.runMutation(components.runtimeTables.public.deleteRecord, {
      scopeId: DEMO_SCOPE,
      tableId: args.tableId,
      recordId: args.recordId,
      expectedRev: args.expectedRev,
    }),
});

export const forceAtomicRollback = mutation({
  args: { tableId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const schema = await ctx.runQuery(
      components.runtimeTables.public.getTable,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
      },
    );
    const fieldIds = Object.fromEntries(
      schema.fields.map((field) => [field.key, field._id]),
    );
    await ctx.db.insert("hostAudit", {
      operation: "forced-rollback",
      createdAt: Date.now(),
    });
    await ctx.runMutation(components.runtimeTables.public.insertRecords, {
      scopeId: DEMO_SCOPE,
      tableId: args.tableId,
      records: [
        {
          values: {
            [fieldIds.accountId!]: "rollback-account",
            [fieldIds.bookingDate!]: Date.now(),
            [fieldIds.amountMinor!]: 100,
            [fieldIds.currency!]: "EUR",
            [fieldIds.merchant!]: "Rollback Merchant",
            [fieldIds.category!]: "other",
            [fieldIds.sourceRef!]: "rollback-source",
          },
        },
      ],
    });
    throw new Error("forced rollback");
  },
});
