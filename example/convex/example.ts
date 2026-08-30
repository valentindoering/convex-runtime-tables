import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { mutation, query } from "./_generated/server.js";

const DEMO_SCOPE = "finance-demo";
const DEMO_SLUG = "transactions";
const scalar = v.union(v.null(), v.boolean(), v.number(), v.string());
const fieldSummary = v.object({
  fieldId: v.string(),
  key: v.string(),
  name: v.string(),
  type: v.string(),
});
const schemaSummary = v.object({
  tableId: v.string(),
  schemaRev: v.number(),
  fields: v.array(fieldSummary),
  indexes: v.array(
    v.object({
      indexId: v.string(),
      name: v.string(),
      state: v.string(),
      unique: v.boolean(),
    }),
  ),
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
    if (existing) return { tableId: existing._id, jobIds: [] };

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
    const ids = Object.fromEntries(
      created.fields.map((field) => [field.key, field._id]),
    );
    const indexRequests = [
      { name: "sourceRefUnique", fieldIds: [ids.sourceRef!], unique: true },
      {
        name: "accountBookingDate",
        fieldIds: [ids.accountId!, ids.bookingDate!],
        unique: false,
      },
      {
        name: "categoryBookingDate",
        fieldIds: [ids.category!, ids.bookingDate!],
        unique: false,
      },
    ];
    const jobIds: string[] = [];
    for (const request of indexRequests) {
      const result = await ctx.runMutation(
        components.runtimeTables.public.createIndex,
        {
          scopeId: DEMO_SCOPE,
          tableId: created.table._id,
          ...request,
        },
      );
      jobIds.push(result.jobId);
    }
    return { tableId: created.table._id, jobIds };
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
      })),
      indexes: schema.indexes.map((index) => ({
        indexId: index._id,
        name: index.name,
        state: index.state,
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
    const categories = ["food", "travel", "software", "other"];
    const records = Array.from({ length: 24 }, (_, index) => ({
      values: {
        [fieldIds.accountId!]: `account-${(index % 3) + 1}`,
        [fieldIds.bookingDate!]: Date.UTC(2026, 7, 1 + index),
        [fieldIds.amountMinor!]:
          (index % 2 === 0 ? -1 : 1) * (950 + index * 137),
        [fieldIds.currency!]: "EUR",
        [fieldIds.merchant!]: [
          "North Star Market",
          "Rail Europe",
          "Linear",
          "City Bakery",
        ][index % 4]!,
        [fieldIds.category!]: categories[index % categories.length]!,
        [fieldIds.sourceRef!]: `demo-${String(index + 1).padStart(3, "0")}`,
      },
    }));
    const result = await ctx.runMutation(
      components.runtimeTables.public.insertRecords,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
        records,
        idempotencyKey: "finance-demo-seed-v1",
      },
    );
    return result.length;
  },
});

export const addTransaction = mutation({
  args: {
    tableId: v.string(),
    fieldIds: v.object({
      accountId: v.string(),
      bookingDate: v.string(),
      amountMinor: v.string(),
      currency: v.string(),
      merchant: v.string(),
      category: v.string(),
      sourceRef: v.string(),
    }),
    merchant: v.string(),
    amountMinor: v.number(),
    category: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const result = await ctx.runMutation(
      components.runtimeTables.public.insertRecords,
      {
        scopeId: DEMO_SCOPE,
        tableId: args.tableId,
        records: [
          {
            values: {
              [args.fieldIds.accountId]: "account-1",
              [args.fieldIds.bookingDate]: Date.now(),
              [args.fieldIds.amountMinor]: args.amountMinor,
              [args.fieldIds.currency]: "EUR",
              [args.fieldIds.merchant]: args.merchant,
              [args.fieldIds.category]: args.category,
              [args.fieldIds.sourceRef]: `manual-${crypto.randomUUID()}`,
            },
          },
        ],
      },
    );
    return result[0]!.recordId;
  },
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
