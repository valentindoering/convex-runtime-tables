import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

const scope = (runId: string) => `real-concurrency-${runId}`;
const scalar = v.union(v.null(), v.boolean(), v.number(), v.string());

export const initialize = mutation({
  args: { runId: v.string() },
  returns: v.object({
    tableId: v.string(),
    keyId: v.string(),
    valueId: v.string(),
    indexId: v.string(),
    jobId: v.string(),
  }),
  handler: async (ctx, args) => {
    const created = await ctx.runMutation(
      components.runtimeTables.public.createTable,
      {
        scopeId: scope(args.runId),
        slug: "items",
        name: "Items",
        fields: [
          { key: "key", name: "Key", type: "text", required: true },
          { key: "value", name: "Value", type: "text", required: true },
        ],
      },
    );
    const keyId = created.fields.find((field) => field.key === "key")!._id;
    const valueId = created.fields.find((field) => field.key === "value")!._id;
    const index = await ctx.runMutation(
      components.runtimeTables.public.createIndex,
      {
        scopeId: scope(args.runId),
        tableId: created.table._id,
        name: "byKey",
        fieldIds: [keyId],
        unique: true,
      },
    );
    return { tableId: created.table._id, keyId, valueId, ...index };
  },
});

export const getJob = query({
  args: { runId: v.string(), jobId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(components.runtimeTables.public.getJob, {
      scopeId: scope(args.runId),
      jobId: args.jobId,
    });
    return job?.state ?? null;
  },
});

export const initializeDeleteBackfillRace = mutation({
  args: { runId: v.string(), iteration: v.number() },
  returns: v.object({
    tableId: v.string(),
    keyId: v.string(),
    valueId: v.string(),
    deleteRecordId: v.string(),
  }),
  handler: async (ctx, args) => {
    const created = await ctx.runMutation(
      components.runtimeTables.public.createTable,
      {
        scopeId: scope(args.runId),
        slug: `delete-backfill-${args.iteration}`,
        name: `Delete backfill ${args.iteration}`,
        fields: [
          { key: "key", name: "Key", type: "text", required: true },
          { key: "value", name: "Value", type: "text", required: true },
        ],
      },
    );
    const keyId = created.fields.find((field) => field.key === "key")!._id;
    const valueId = created.fields.find((field) => field.key === "value")!._id;
    const ids: string[] = [];
    for (let start = 0; start < 1_000; start += 100) {
      const records = await ctx.runMutation(
        components.runtimeTables.public.insertRecords,
        {
          scopeId: scope(args.runId),
          tableId: created.table._id,
          records: Array.from(
            { length: Math.min(100, 1_000 - start) },
            (_, offset) => ({
              values: {
                [keyId]: `r1-${args.iteration}-${start + offset}`,
                [valueId]: `value-${start + offset}`,
              },
            }),
          ),
        },
      );
      ids.push(...records.map((record) => record.recordId));
    }
    return {
      tableId: created.table._id,
      keyId,
      valueId,
      deleteRecordId: ids[199]!,
    };
  },
});

export const startDeleteBackfillRace = mutation({
  args: {
    runId: v.string(),
    iteration: v.number(),
    tableId: v.string(),
    keyId: v.string(),
  },
  returns: v.object({ indexId: v.string(), jobId: v.string() }),
  handler: async (ctx, args) =>
    await ctx.runMutation(components.runtimeTables.public.createIndex, {
      scopeId: scope(args.runId),
      tableId: args.tableId,
      name: `r1-${args.iteration}`,
      fieldIds: [args.keyId],
      unique: false,
    }),
});

export const deleteOne = mutation({
  args: { runId: v.string(), tableId: v.string(), recordId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) =>
    await ctx.runMutation(components.runtimeTables.public.deleteRecord, {
      scopeId: scope(args.runId),
      tableId: args.tableId,
      recordId: args.recordId,
    }),
});

export const deleteTable = mutation({
  args: { runId: v.string(), tableId: v.string() },
  returns: v.object({ jobId: v.string() }),
  handler: async (ctx, args) =>
    await ctx.runMutation(components.runtimeTables.public.deleteTable, {
      scopeId: scope(args.runId),
      tableId: args.tableId,
    }),
});

export const insertOne = mutation({
  args: {
    runId: v.string(),
    tableId: v.string(),
    keyId: v.string(),
    valueId: v.string(),
    key: v.string(),
    value: v.string(),
  },
  returns: v.object({ recordId: v.string(), rev: v.number() }),
  handler: async (ctx, args) => {
    const [result] = await ctx.runMutation(
      components.runtimeTables.public.insertRecords,
      {
        scopeId: scope(args.runId),
        tableId: args.tableId,
        records: [
          {
            values: {
              [args.keyId]: args.key,
              [args.valueId]: args.value,
            },
          },
        ],
      },
    );
    return result!;
  },
});

export const insertBatch = mutation({
  args: {
    runId: v.string(),
    tableId: v.string(),
    keyId: v.string(),
    valueId: v.string(),
    start: v.number(),
    count: v.number(),
    idempotencyKey: v.string(),
    payloadTag: v.string(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const result = await ctx.runMutation(
      components.runtimeTables.public.insertRecords,
      {
        scopeId: scope(args.runId),
        tableId: args.tableId,
        records: Array.from({ length: args.count }, (_, offset) => ({
          values: {
            [args.keyId]: `batch-${args.start + offset}`,
            [args.valueId]: `${args.payloadTag}-${args.start + offset}`,
          },
        })),
        idempotencyKey: args.idempotencyKey,
      },
    );
    return result.map((item) => item.recordId);
  },
});

export const patchOne = mutation({
  args: {
    runId: v.string(),
    tableId: v.string(),
    recordId: v.string(),
    valueId: v.string(),
    expectedRev: v.number(),
    value: v.string(),
  },
  returns: v.object({ recordId: v.string(), rev: v.number() }),
  handler: async (ctx, args) =>
    await ctx.runMutation(components.runtimeTables.public.patchRecord, {
      scopeId: scope(args.runId),
      tableId: args.tableId,
      recordId: args.recordId,
      patch: { values: { [args.valueId]: args.value } },
      expectedRev: args.expectedRev,
    }),
});

export const page = query({
  args: {
    runId: v.string(),
    tableId: v.string(),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    records: v.array(
      v.object({
        recordId: v.string(),
        rev: v.number(),
        values: v.record(v.string(), scalar),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.union(v.null(), v.string()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.runQuery(
      components.runtimeTables.public.queryRecords,
      {
        scopeId: scope(args.runId),
        tableId: args.tableId,
        query: { where: [] },
        pagination: { pageSize: 100, cursor: args.cursor },
      },
    );
    return {
      records: result.page.map((record) => ({
        recordId: record._id,
        rev: record.rev,
        values: record.values,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const auditEntries = query({
  args: {
    runId: v.string(),
    indexId: v.string(),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    entries: v.array(
      v.object({
        recordId: v.string(),
        recordRev: v.number(),
        k0: scalar,
        k1: scalar,
        k2: scalar,
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.union(v.null(), v.string()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.runQuery(
      components.runtimeTables.public.auditIndexEntries,
      {
        scopeId: scope(args.runId),
        indexId: args.indexId,
        pagination: { pageSize: 100, cursor: args.cursor },
      },
    );
    return {
      entries: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
