import { paginator } from "convex-helpers/server/pagination";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation } from "./_generated/server.js";
import { upsertIndexEntry } from "./data.js";
import { normalizeIndexSlots, type Scalar } from "./normalization.js";
import schema from "./schema.js";

const BATCH_SIZE = 50;

export const processIndexJob = internalMutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("jobs", args.jobId);
    if (!job || job.kind !== "buildIndex" || job.state === "succeeded" || job.state === "failed") {
      return null;
    }
    const indexId = ctx.db.normalizeId("indexDefinitions", job.targetId);
    const index = indexId ? await ctx.db.get("indexDefinitions", indexId) : null;
    if (!index || index.scopeId !== job.scopeId) {
      await failJob(ctx, job, "NOT_FOUND", "Index definition no longer exists");
      return null;
    }
    await ctx.db.patch("jobs", job._id, {
      state: "running",
      attempts: job.attempts + 1,
      updatedAt: Date.now(),
    });
    if (job.phase === "backfill") {
      await backfill(ctx, job, index);
      return null;
    }
    if (job.phase === "verifyRecords") {
      await verifyRecords(ctx, job, index);
      return null;
    }
    if (job.phase === "verifyEntries") {
      await verifyEntries(ctx, job, index);
      return null;
    }
    return null;
  },
});

export const processDeleteIndexJob = internalMutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("jobs", args.jobId);
    if (!job || job.kind !== "deleteIndex" || job.state === "succeeded") return null;
    const indexId = ctx.db.normalizeId("indexDefinitions", job.targetId);
    if (!indexId) {
      await succeedJob(ctx, job);
      return null;
    }
    const result = await paginator(ctx.db, schema)
      .query("indexEntries")
      .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
        q.eq("scopeId", job.scopeId).eq("indexId", indexId),
      )
      .paginate({ numItems: BATCH_SIZE, cursor: job.cursor });
    for (const entry of result.page) await ctx.db.delete("indexEntries", entry._id);
    if (!result.isDone) {
      await continueJob(ctx, job, result.continueCursor, result.page.length);
      await ctx.scheduler.runAfter(0, internal.indexJobs.processDeleteIndexJob, { jobId: job._id });
      return null;
    }
    const definition = await ctx.db.get("indexDefinitions", indexId);
    if (definition && definition.scopeId === job.scopeId) {
      await ctx.db.delete("indexDefinitions", indexId);
    }
    await succeedJob(ctx, job);
    return null;
  },
});

export const processDeleteTableJob = internalMutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("jobs", args.jobId);
    if (!job || job.kind !== "deleteTable" || job.state === "succeeded") return null;
    const tableId = ctx.db.normalizeId("tables", job.targetId);
    if (!tableId) {
      await succeedJob(ctx, job);
      return null;
    }
    if (await deleteOneIndexBatch(ctx, job, tableId)) {
      await rescheduleDeleteTable(ctx, job);
      return null;
    }
    const records = await ctx.db
      .query("records")
      .withIndex("by_scopeId_and_tableId", (q) =>
        q.eq("scopeId", job.scopeId).eq("tableId", tableId),
      )
      .take(BATCH_SIZE);
    if (records.length > 0) {
      for (const record of records) await ctx.db.delete("records", record._id);
      await ctx.db.patch("jobs", job._id, {
        state: "running",
        phase: "deleteRecords",
        progress: job.progress + records.length,
        attempts: job.attempts + 1,
        updatedAt: Date.now(),
      });
      await rescheduleDeleteTable(ctx, job);
      return null;
    }
    const activeFields = await ctx.db
      .query("fields")
      .withIndex("by_scopeId_and_tableId_and_state", (q) =>
        q.eq("scopeId", job.scopeId).eq("tableId", tableId).eq("state", "active"),
      )
      .take(BATCH_SIZE);
    const deletingFields = await ctx.db
      .query("fields")
      .withIndex("by_scopeId_and_tableId_and_state", (q) =>
        q.eq("scopeId", job.scopeId).eq("tableId", tableId).eq("state", "deleting"),
      )
      .take(BATCH_SIZE);
    const fields = [...activeFields, ...deletingFields].slice(0, BATCH_SIZE);
    if (fields.length > 0) {
      for (const field of fields) await ctx.db.delete("fields", field._id);
      await ctx.db.patch("jobs", job._id, {
        phase: "deleteFields",
        progress: job.progress + fields.length,
        updatedAt: Date.now(),
      });
      await rescheduleDeleteTable(ctx, job);
      return null;
    }
    for (const operation of ["insert", "upsert"] as const) {
      const keys = await ctx.db
        .query("idempotencyKeys")
        .withIndex("by_scopeId_and_tableId_and_operation_and_key", (q) =>
          q.eq("scopeId", job.scopeId).eq("tableId", tableId).eq("operation", operation),
        )
        .take(BATCH_SIZE);
      if (keys.length > 0) {
        for (const key of keys) await ctx.db.delete("idempotencyKeys", key._id);
        await rescheduleDeleteTable(ctx, job);
        return null;
      }
    }
    const table = await ctx.db.get("tables", tableId);
    if (table && table.scopeId === job.scopeId) await ctx.db.delete("tables", tableId);
    await succeedJob(ctx, job);
    return null;
  },
});

async function backfill(
  ctx: Parameters<typeof upsertIndexEntry>[0],
  job: Doc<"jobs">,
  index: Doc<"indexDefinitions">,
): Promise<void> {
  const result = await paginator(ctx.db, schema)
    .query("records")
    .withIndex("by_scopeId_and_tableId", (q) =>
      q.eq("scopeId", job.scopeId).eq("tableId", index.tableId),
    )
    .paginate({ numItems: BATCH_SIZE, cursor: job.cursor });
  for (const record of result.page) await upsertIndexEntry(ctx, index, record, false);
  if (!result.isDone) {
    await continueJob(ctx, job, result.continueCursor, result.page.length);
    await ctx.scheduler.runAfter(0, internal.indexJobs.processIndexJob, { jobId: job._id });
    return;
  }
  await ctx.db.patch("indexDefinitions", index._id, {
    state: "verifying",
    failure: null,
    updatedAt: Date.now(),
  });
  await ctx.db.patch("jobs", job._id, {
    phase: "verifyRecords",
    cursor: null,
    progress: job.progress + result.page.length,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.indexJobs.processIndexJob, { jobId: job._id });
}

async function verifyRecords(
  ctx: Parameters<typeof upsertIndexEntry>[0],
  job: Doc<"jobs">,
  index: Doc<"indexDefinitions">,
): Promise<void> {
  const result = await paginator(ctx.db, schema)
    .query("records")
    .withIndex("by_scopeId_and_tableId", (q) =>
      q.eq("scopeId", job.scopeId).eq("tableId", index.tableId),
    )
    .paginate({ numItems: BATCH_SIZE, cursor: job.cursor });
  const conflicts: string[] = [];
  for (const record of result.page) {
    await upsertIndexEntry(ctx, index, record, false);
    if (index.unique) {
      const [k0, k1, k2] = normalizeIndexSlots(index.fieldIds, record.values as Record<string, Scalar>);
      const duplicates = await ctx.db
        .query("indexEntries")
        .withIndex(
          "by_scopeId_and_indexId_and_k0_and_k1_and_k2_and_recordId",
          (q) =>
            q
              .eq("scopeId", index.scopeId)
              .eq("indexId", index._id)
              .eq("k0", k0)
              .eq("k1", k1)
              .eq("k2", k2),
        )
        .take(3);
      if (duplicates.length > 1) conflicts.push(...duplicates.map((entry) => entry.recordId));
    }
  }
  if (conflicts.length > 0) {
    await ctx.db.patch("indexDefinitions", index._id, {
      state: "failed",
      failure: {
        code: "UNIQUE_CONFLICT",
        message: "Historical records contain duplicate keys",
        samples: [...new Set(conflicts)].slice(0, 10),
      },
      updatedAt: Date.now(),
    });
    await failJob(ctx, job, "UNIQUE_CONFLICT", "Historical records contain duplicate keys");
    return;
  }
  if (!result.isDone) {
    await continueJob(ctx, job, result.continueCursor, result.page.length);
    await ctx.scheduler.runAfter(0, internal.indexJobs.processIndexJob, { jobId: job._id });
    return;
  }
  await ctx.db.patch("jobs", job._id, {
    phase: "verifyEntries",
    cursor: null,
    progress: job.progress + result.page.length,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.indexJobs.processIndexJob, { jobId: job._id });
}

async function verifyEntries(
  ctx: Parameters<typeof upsertIndexEntry>[0],
  job: Doc<"jobs">,
  index: Doc<"indexDefinitions">,
): Promise<void> {
  const result = await paginator(ctx.db, schema)
    .query("indexEntries")
    .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
      q.eq("scopeId", job.scopeId).eq("indexId", index._id),
    )
    .paginate({ numItems: BATCH_SIZE, cursor: job.cursor });
  for (const entry of result.page) {
    const record = await ctx.db.get("records", entry.recordId);
    if (!record || record.scopeId !== job.scopeId || record.tableId !== index.tableId) {
      await ctx.db.delete("indexEntries", entry._id);
      continue;
    }
    const [k0, k1, k2] = normalizeIndexSlots(index.fieldIds, record.values as Record<string, Scalar>);
    if (
      !Object.is(entry.k0, k0) ||
      !Object.is(entry.k1, k1) ||
      !Object.is(entry.k2, k2) ||
      entry.recordRev !== record.rev
    ) {
      await ctx.db.patch("indexEntries", entry._id, { k0, k1, k2, recordRev: record.rev });
    }
  }
  if (!result.isDone) {
    await continueJob(ctx, job, result.continueCursor, result.page.length);
    await ctx.scheduler.runAfter(0, internal.indexJobs.processIndexJob, { jobId: job._id });
    return;
  }
  await ctx.db.patch("indexDefinitions", index._id, {
    state: "ready",
    failure: null,
    updatedAt: Date.now(),
  });
  await succeedJob(ctx, job);
}

async function deleteOneIndexBatch(
  ctx: Parameters<typeof upsertIndexEntry>[0],
  job: Doc<"jobs">,
  tableId: Id<"tables">,
): Promise<boolean> {
  for (const state of ["building", "verifying", "ready", "failed", "deleting"] as const) {
    const definitions = await ctx.db
      .query("indexDefinitions")
      .withIndex("by_scopeId_and_tableId_and_state", (q) =>
        q.eq("scopeId", job.scopeId).eq("tableId", tableId).eq("state", state),
      )
      .take(1);
    const definition = definitions[0];
    if (!definition) continue;
    const entries = await ctx.db
      .query("indexEntries")
      .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
        q.eq("scopeId", job.scopeId).eq("indexId", definition._id),
      )
      .take(BATCH_SIZE);
    for (const entry of entries) await ctx.db.delete("indexEntries", entry._id);
    if (entries.length === 0) await ctx.db.delete("indexDefinitions", definition._id);
    await ctx.db.patch("jobs", job._id, {
      state: "running",
      phase: "deleteEntries",
      progress: job.progress + entries.length,
      attempts: job.attempts + 1,
      updatedAt: Date.now(),
    });
    return true;
  }
  return false;
}

async function continueJob(
  ctx: Parameters<typeof upsertIndexEntry>[0],
  job: Doc<"jobs">,
  cursor: string,
  completed: number,
): Promise<void> {
  await ctx.db.patch("jobs", job._id, {
    state: "running",
    cursor,
    progress: job.progress + completed,
    updatedAt: Date.now(),
  });
}

async function succeedJob(
  ctx: Parameters<typeof upsertIndexEntry>[0],
  job: Doc<"jobs">,
): Promise<void> {
  await ctx.db.patch("jobs", job._id, {
    state: "succeeded",
    phase: "done",
    cursor: null,
    lastError: null,
    updatedAt: Date.now(),
  });
}

async function failJob(
  ctx: Parameters<typeof upsertIndexEntry>[0],
  job: Doc<"jobs">,
  code: string,
  message: string,
): Promise<void> {
  await ctx.db.patch("jobs", job._id, {
    state: "failed",
    phase: "done",
    cursor: null,
    lastError: { code, message },
    updatedAt: Date.now(),
  });
}

async function rescheduleDeleteTable(
  ctx: Parameters<typeof upsertIndexEntry>[0],
  job: Doc<"jobs">,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.indexJobs.processDeleteTableJob, { jobId: job._id });
}
