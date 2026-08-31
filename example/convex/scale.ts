import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

const scope = (runId: string) => `scale-100k-${runId}`;
const scalar = v.union(v.null(), v.boolean(), v.number(), v.string());

export const initialize = mutation({
  args: { runId: v.string() },
  returns: v.object({
    tableId: v.string(),
    seqId: v.string(),
    groupId: v.string(),
    payloadId: v.string(),
  }),
  handler: async (ctx, args) => {
    const scopeId = scope(args.runId);
    const existing = await ctx.runQuery(
      components.runtimeTables.public.listTables,
      {
        scopeId,
        pagination: { pageSize: 100 },
      },
    );
    const table = existing.page.find(
      (candidate) => candidate.slug === "scale-records",
    );
    if (table) {
      const schema = await ctx.runQuery(
        components.runtimeTables.public.getTable,
        {
          scopeId,
          tableId: table._id,
        },
      );
      return ids(schema.table._id, schema.fields);
    }
    const created = await ctx.runMutation(
      components.runtimeTables.public.createTable,
      {
        scopeId,
        slug: "scale-records",
        name: "Scale records",
        fields: [
          { key: "seq", name: "Sequence", type: "number", required: true },
          { key: "group", name: "Group", type: "text", required: true },
          { key: "payload", name: "Payload", type: "text", required: true },
        ],
      },
    );
    return ids(created.table._id, created.fields);
  },
});

export const insertBatch = mutation({
  args: {
    runId: v.string(),
    tableId: v.string(),
    seqId: v.string(),
    groupId: v.string(),
    payloadId: v.string(),
    start: v.number(),
    count: v.number(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const scopeId = scope(args.runId);
    const result = await ctx.runMutation(
      components.runtimeTables.public.insertRecords,
      {
        scopeId,
        tableId: args.tableId,
        records: Array.from({ length: args.count }, (_, offset) => {
          const seq = args.start + offset;
          return {
            values: {
              [args.seqId]: seq,
              [args.groupId]: `group-${seq % 100}`,
              [args.payloadId]: `payload-${seq}-${"x".repeat(40)}`,
            },
          };
        }),
        idempotencyKey: `scale-${args.start}-${args.count}`,
      },
    );
    return result.map((item) => item.recordId);
  },
});

export const createIndex = mutation({
  args: {
    runId: v.string(),
    tableId: v.string(),
    name: v.string(),
    fieldIds: v.array(v.string()),
  },
  returns: v.object({ indexId: v.string(), jobId: v.string() }),
  handler: async (ctx, args) =>
    await ctx.runMutation(components.runtimeTables.public.createIndex, {
      scopeId: scope(args.runId),
      tableId: args.tableId,
      name: args.name,
      fieldIds: args.fieldIds,
      unique: false,
    }),
});

export const verifyIndex = mutation({
  args: { runId: v.string(), indexId: v.string() },
  returns: v.object({ jobId: v.string() }),
  handler: async (ctx, args) =>
    await ctx.runMutation(components.runtimeTables.public.verifyIndex, {
      scopeId: scope(args.runId),
      indexId: args.indexId,
    }),
});

export const patchOne = mutation({
  args: {
    runId: v.string(),
    tableId: v.string(),
    recordId: v.string(),
    payloadId: v.string(),
    expectedRev: v.number(),
    value: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const result = await ctx.runMutation(
      components.runtimeTables.public.patchRecord,
      {
        scopeId: scope(args.runId),
        tableId: args.tableId,
        recordId: args.recordId,
        patch: { values: { [args.payloadId]: args.value } },
        expectedRev: args.expectedRev,
      },
    );
    return result.rev;
  },
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

export const tableCount = query({
  args: { runId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const result = await ctx.runQuery(
      components.runtimeTables.public.listTables,
      {
        scopeId: scope(args.runId),
        pagination: { pageSize: 100 },
      },
    );
    return result.page.length;
  },
});

export const getJob = query({
  args: { runId: v.string(), jobId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      state: v.string(),
      batchCount: v.number(),
      retryCount: v.number(),
      progress: v.number(),
      verificationMismatchCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(components.runtimeTables.public.getJob, {
      scopeId: scope(args.runId),
      jobId: args.jobId,
    });
    if (!job) return null;
    const verification = job.verification;
    return {
      state: job.state,
      batchCount: job.batchCount ?? 0,
      retryCount: job.retryCount ?? 0,
      progress: job.progress,
      verificationMismatchCount: verification
        ? verification.missing +
          verification.orphaned +
          verification.stale +
          verification.duplicate
        : 0,
    };
  },
});

export const page = query({
  args: {
    runId: v.string(),
    tableId: v.string(),
    indexId: v.string(),
    orderFieldIds: v.array(v.string()),
    direction: v.union(v.literal("asc"), v.literal("desc")),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    ids: v.array(v.string()),
    seq: v.array(v.number()),
    revs: v.array(v.number()),
    values: v.array(v.record(v.string(), scalar)),
    isDone: v.boolean(),
    continueCursor: v.union(v.null(), v.string()),
    planIndexId: v.string(),
    bytesRead: v.number(),
    documentsRead: v.number(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.runQuery(
      components.runtimeTables.public.queryRecords,
      {
        scopeId: scope(args.runId),
        tableId: args.tableId,
        query: {
          where: [],
          orderBy: { fieldIds: args.orderFieldIds, direction: args.direction },
        },
        pagination: { pageSize: 100, cursor: args.cursor },
      },
    );
    const metrics = await ctx.meta.getTransactionMetrics();
    if (result.plan.kind !== "index") {
      throw new Error(`Expected an index plan, got ${result.plan.kind}`);
    }
    return {
      ids: result.page.map((record) => record._id),
      seq: result.page.map((record) =>
        Number(record.values[args.orderFieldIds.at(-1)!]),
      ),
      revs: result.page.map((record) => record.rev),
      values: result.page.map((record) => record.values),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      planIndexId: result.plan.indexId,
      bytesRead: metrics.bytesRead.used,
      documentsRead: metrics.documentsRead.used,
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
    page: v.array(
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
  handler: async (ctx, args) =>
    await ctx.runQuery(components.runtimeTables.public.auditIndexEntries, {
      scopeId: scope(args.runId),
      indexId: args.indexId,
      pagination: { pageSize: 100, cursor: args.cursor },
    }),
});

export const recordsPage = query({
  args: {
    runId: v.string(),
    tableId: v.string(),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(
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
      page: result.page.map((record) => ({
        recordId: record._id,
        rev: record.rev,
        values: record.values,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

function ids(tableId: string, fields: Array<{ _id: string; key: string }>) {
  return {
    tableId,
    seqId: fields.find((field) => field.key === "seq")!._id,
    groupId: fields.find((field) => field.key === "group")!._id,
    payloadId: fields.find((field) => field.key === "payload")!._id,
  };
}
