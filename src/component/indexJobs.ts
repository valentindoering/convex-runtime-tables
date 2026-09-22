import { paginator } from "convex-helpers/server/pagination";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./_generated/server.js";
import { upsertIndexEntry } from "./data.js";
import { normalizeIndexSlots, type Scalar } from "./normalization.js";
import schema from "./schema.js";
import { JOB_RETENTION_MS, MAX_BYTES_READ } from "./validation.js";
import { hydrateRecordPage } from "./recordHydration.js";
import { jobKindValidator, jobPhaseValidator } from "./validators.js";

const BATCH_SIZE = 200;
const SAMPLE_LIMIT = 10;
type Verification = NonNullable<Doc<"jobs">["verification"]>;
type IndexJob = Doc<"jobs"> & {
  generation: number;
  kind: "buildIndex" | "repairIndex" | "verifyIndex";
};
const invocationArgs = {
  jobId: v.id("jobs"),
  generation: v.number(),
  phase: jobPhaseValidator,
};

export const runIndexBatch = internalMutation({
  args: invocationArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await currentIndexJob(ctx, args);
    if (!current) return null;
    const { job, index } = current;
    await ctx.db.patch("jobs", job._id, {
      state: "running",
      batchCount: (job.batchCount ?? 0) + 1,
      updatedAt: Date.now(),
    });
    switch (job.phase) {
      case "backfill":
        await backfill(ctx, job, index);
        break;
      case "repairRecords":
        await repairRecords(ctx, job, index);
        break;
      case "repairEntries":
        await repairEntries(ctx, job, index);
        break;
      case "verifyRecords":
        await verifyRecords(ctx, job, index);
        break;
      case "verifyEntries":
        await verifyEntries(ctx, job, index);
        break;
      default:
        await failCurrentIndexJob(
          ctx,
          job,
          index,
          "ILLEGAL_PHASE",
          `Illegal index job phase: ${job.phase}`,
        );
    }
    return null;
  },
});

export const runDeleteIndexBatch = internalMutation({
  args: invocationArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await currentDeleteIndexJob(ctx, args);
    if (!current) return null;
    const { job, index } = current;
    const entries = await ctx.db
      .query("indexEntries")
      .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
        q.eq("scopeId", job.scopeId).eq("indexId", index._id),
      )
      .take(BATCH_SIZE);
    for (const entry of entries) await ctx.db.delete("indexEntries", entry._id);
    if (!(await requireCurrentIndex(ctx, job, "deleting"))) return null;
    await ctx.db.patch("jobs", job._id, {
      state: "running",
      batchCount: (job.batchCount ?? 0) + 1,
      progress: job.progress + entries.length,
      updatedAt: Date.now(),
    });
    if (entries.length > 0) {
      await schedule(ctx, job, "deleteEntries");
      return null;
    }
    const table = await ctx.db.get("tables", index.tableId);
    if (table && table.scopeId === job.scopeId) {
      await ctx.db.patch("tables", table._id, {
        schemaRev: table.schemaRev + 1,
        updatedAt: Date.now(),
      });
    }
    await ctx.db.delete("indexDefinitions", index._id);
    await succeedJob(ctx, job);
    return null;
  },
});

export const runDeleteTableBatch = internalMutation({
  args: invocationArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await currentDeleteTableJob(ctx, args);
    if (!current) return null;
    const { job, table } = current;
    await ctx.db.patch("jobs", job._id, {
      state: "running",
      batchCount: (job.batchCount ?? 0) + 1,
      updatedAt: Date.now(),
    });
    if (await deleteIndexBatchForTable(ctx, job, table._id)) {
      await schedule(ctx, job, "deleteEntries");
      return null;
    }
    const records = (
      await paginator(ctx.db, schema)
        .query("records")
        .withIndex("by_scopeId_and_tableId", (q) =>
          q.eq("scopeId", job.scopeId).eq("tableId", table._id),
        )
        .paginate({
          numItems: BATCH_SIZE,
          cursor: null,
          maximumBytesRead: MAX_BYTES_READ,
        })
    ).page;
    if (records.length > 0) {
      for (const record of records) await ctx.db.delete("records", record._id);
      await continueDelete(ctx, job, "deleteRecords", records.length);
      return null;
    }
    for (const state of ["active", "deleting"] as const) {
      const fields = await ctx.db
        .query("fields")
        .withIndex("by_scopeId_and_tableId_and_state", (q) =>
          q
            .eq("scopeId", job.scopeId)
            .eq("tableId", table._id)
            .eq("state", state),
        )
        .take(BATCH_SIZE);
      if (fields.length > 0) {
        for (const field of fields) await ctx.db.delete("fields", field._id);
        await continueDelete(ctx, job, "deleteFields", fields.length);
        return null;
      }
    }
    for (const operation of ["insert", "upsert"] as const) {
      const keys = await ctx.db
        .query("idempotencyKeys")
        .withIndex("by_scopeId_and_tableId_and_operation_and_key", (q) =>
          q
            .eq("scopeId", job.scopeId)
            .eq("tableId", table._id)
            .eq("operation", operation),
        )
        .take(BATCH_SIZE);
      if (keys.length > 0) {
        for (const key of keys) await ctx.db.delete("idempotencyKeys", key._id);
        await continueDelete(ctx, job, "deleteMetadata", keys.length);
        return null;
      }
    }
    if (!(await requireCurrentTable(ctx, job))) return null;
    await ctx.db.delete("tables", table._id);
    await succeedJob(ctx, job);
    return null;
  },
});

export const markUnexpectedFailure = internalMutation({
  args: {
    jobId: v.id("jobs"),
    generation: v.number(),
    kind: jobKindValidator,
    code: v.string(),
    message: v.string(),
    samples: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("jobs", args.jobId);
    if (
      !job ||
      job.generation !== args.generation ||
      job.kind !== args.kind ||
      isTerminal(job)
    )
      return null;
    const code = args.code.slice(0, 100);
    const message = args.message.slice(0, 500);
    const samples = [...new Set(args.samples)].slice(0, SAMPLE_LIMIT);
    if (job.kind !== "deleteTable") {
      const indexId = ctx.db.normalizeId("indexDefinitions", job.targetId);
      const index = indexId
        ? await ctx.db.get("indexDefinitions", indexId)
        : null;
      if (
        !index ||
        index.generation !== job.generation ||
        index.activeJobId !== job._id
      ) {
        await supersedeJob(ctx, job);
        return null;
      }
      await ctx.db.patch("indexDefinitions", index._id, {
        state: index.state === "ready" ? "ready" : "failed",
        maintenanceState: "failed",
        failure: { code, message, samples },
        updatedAt: Date.now(),
      });
    } else if (!(await requireCurrentTable(ctx, job))) {
      return null;
    }
    await failJob(ctx, job, code, message);
    return null;
  },
});

async function backfill(
  ctx: MutationCtx,
  job: IndexJob,
  index: Doc<"indexDefinitions">,
) {
  const result = await paginator(ctx.db, schema)
    .query("records")
    .withIndex("by_scopeId_and_tableId", (q) =>
      q.eq("scopeId", job.scopeId).eq("tableId", index.tableId),
    )
    .paginate({
      numItems: BATCH_SIZE,
      cursor: job.cursor,
      maximumBytesRead: MAX_BYTES_READ,
    });
  for (const record of result.page)
    await upsertIndexEntry(ctx, index, record, false, true);
  if (!(await requireCurrentIndex(ctx, job, "backfilling"))) return;
  if (!result.isDone) {
    await continueIndex(
      ctx,
      job,
      "backfill",
      result.continueCursor,
      result.page.length,
    );
    return;
  }
  await transitionIndex(
    ctx,
    job,
    index,
    "repairRecords",
    "repairing",
    result.page.length,
  );
}

async function repairRecords(
  ctx: MutationCtx,
  job: IndexJob,
  index: Doc<"indexDefinitions">,
) {
  const result = await paginator(ctx.db, schema)
    .query("records")
    .withIndex("by_scopeId_and_tableId", (q) =>
      q.eq("scopeId", job.scopeId).eq("tableId", index.tableId),
    )
    .paginate({
      numItems: BATCH_SIZE,
      cursor: job.cursor,
      maximumBytesRead: MAX_BYTES_READ,
    });
  for (const record of result.page)
    await upsertIndexEntry(ctx, index, record, false, true);
  if (!(await requireCurrentIndex(ctx, job, "repairing"))) return;
  if (!result.isDone) {
    await continueIndex(
      ctx,
      job,
      "repairRecords",
      result.continueCursor,
      result.page.length,
    );
    return;
  }
  await transitionIndex(
    ctx,
    job,
    index,
    "repairEntries",
    "repairing",
    result.page.length,
  );
}

async function repairEntries(
  ctx: MutationCtx,
  job: IndexJob,
  index: Doc<"indexDefinitions">,
) {
  const stream = paginator(ctx.db, schema)
    .query("indexEntries")
    .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
      q.eq("scopeId", job.scopeId).eq("indexId", index._id),
    );
  const initial = await stream.paginate({
    numItems: BATCH_SIZE,
    cursor: job.cursor,
    maximumBytesRead: MAX_BYTES_READ,
  });
  const { result, records } = await hydrateRecordPage(
    ctx,
    initial,
    (count) =>
      stream.paginate({
        numItems: count,
        cursor: job.cursor,
        maximumRowsRead: count,
        maximumBytesRead: MAX_BYTES_READ,
      }),
    MAX_BYTES_READ,
  );
  for (const [position, entry] of result.page.entries()) {
    const record = records[position];
    if (
      !record ||
      record.scopeId !== job.scopeId ||
      record.tableId !== index.tableId
    ) {
      await ctx.db.delete("indexEntries", entry._id);
      continue;
    }
    const expected = normalizeIndexSlots(
      index.fieldIds,
      record.values as Record<string, Scalar>,
    );
    if (!entryMatches(entry, expected, record.rev)) {
      await ctx.db.patch("indexEntries", entry._id, {
        k0: expected[0],
        k1: expected[1],
        k2: expected[2],
        recordRev: record.rev,
      });
    }
  }
  if (!(await requireCurrentIndex(ctx, job, "repairing"))) return;
  if (!result.isDone) {
    await continueIndex(
      ctx,
      job,
      "repairEntries",
      result.continueCursor,
      result.page.length,
    );
    return;
  }
  await ctx.db.patch("jobs", job._id, { verification: emptyVerification() });
  await transitionIndex(
    ctx,
    job,
    index,
    "verifyRecords",
    "verifying",
    result.page.length,
  );
}

async function verifyRecords(
  ctx: MutationCtx,
  job: IndexJob,
  index: Doc<"indexDefinitions">,
) {
  const result = await paginator(ctx.db, schema)
    .query("records")
    .withIndex("by_scopeId_and_tableId", (q) =>
      q.eq("scopeId", job.scopeId).eq("tableId", index.tableId),
    )
    .paginate({
      numItems: BATCH_SIZE,
      cursor: job.cursor,
      maximumBytesRead: MAX_BYTES_READ,
    });
  const delta = emptyVerification();
  for (const record of result.page) {
    const entries = await ctx.db
      .query("indexEntries")
      .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
        q
          .eq("scopeId", job.scopeId)
          .eq("indexId", index._id)
          .eq("recordId", record._id),
      )
      .take(3);
    if (entries.length === 0) addFinding(delta, "missing", record._id);
    if (entries.length > 1)
      addFinding(delta, "duplicate", record._id, entries.length - 1);
    if (!entries[0]) continue;
    const expected = normalizeIndexSlots(
      index.fieldIds,
      record.values as Record<string, Scalar>,
    );
    if (!entryMatches(entries[0], expected, record.rev))
      addFinding(delta, "stale", record._id);
    if (
      index.unique &&
      !expected.slice(0, index.fieldIds.length).includes(null)
    ) {
      const duplicates = await ctx.db
        .query("indexEntries")
        .withIndex(
          "by_scopeId_and_indexId_and_k0_and_k1_and_k2_and_recordId",
          (q) =>
            q
              .eq("scopeId", job.scopeId)
              .eq("indexId", index._id)
              .eq("k0", expected[0])
              .eq("k1", expected[1])
              .eq("k2", expected[2]),
        )
        .take(3);
      if (duplicates.length > 1) addFinding(delta, "duplicate", record._id);
    }
  }
  if (!(await requireCurrentIndex(ctx, job, "verifying"))) return;
  await mergeVerification(ctx, job, delta);
  if (!result.isDone) {
    await continueIndex(
      ctx,
      job,
      "verifyRecords",
      result.continueCursor,
      result.page.length,
    );
    return;
  }
  await transitionIndex(
    ctx,
    job,
    index,
    "verifyEntries",
    "verifying",
    result.page.length,
  );
}

async function verifyEntries(
  ctx: MutationCtx,
  job: IndexJob,
  index: Doc<"indexDefinitions">,
) {
  const stream = paginator(ctx.db, schema)
    .query("indexEntries")
    .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
      q.eq("scopeId", job.scopeId).eq("indexId", index._id),
    );
  const initial = await stream.paginate({
    numItems: BATCH_SIZE,
    cursor: job.cursor,
    maximumBytesRead: MAX_BYTES_READ,
  });
  const { result, records } = await hydrateRecordPage(
    ctx,
    initial,
    (count) =>
      stream.paginate({
        numItems: count,
        cursor: job.cursor,
        maximumRowsRead: count,
        maximumBytesRead: MAX_BYTES_READ,
      }),
    MAX_BYTES_READ,
  );
  const delta = emptyVerification();
  for (const [position, entry] of result.page.entries()) {
    const record = records[position];
    if (
      !record ||
      record.scopeId !== job.scopeId ||
      record.tableId !== index.tableId
    ) {
      addFinding(delta, "orphaned", entry.recordId);
    }
  }
  if (!(await requireCurrentIndex(ctx, job, "verifying"))) return;
  const totals = await mergeVerification(ctx, job, delta);
  if (!result.isDone) {
    await continueIndex(
      ctx,
      job,
      "verifyEntries",
      result.continueCursor,
      result.page.length,
    );
    return;
  }
  const checkedAt = Date.now();
  const verification = { ...totals, checkedAt };
  const mismatch =
    totals.missing + totals.orphaned + totals.stale + totals.duplicate;
  if (mismatch > 0) {
    const code =
      index.unique && totals.duplicate > 0
        ? "UNIQUE_CONFLICT"
        : "VERIFY_MISMATCH";
    const message =
      code === "UNIQUE_CONFLICT"
        ? `Read-only verification found ${totals.duplicate} duplicate unique keys`
        : `Read-only verification found ${mismatch} mismatches`;
    const samples = [
      ...totals.missingSamples,
      ...totals.orphanedSamples,
      ...totals.staleSamples,
      ...totals.duplicateSamples,
    ].slice(0, SAMPLE_LIMIT);
    const table = await ctx.db.get("tables", index.tableId);
    if (index.state === "ready" && table && table.scopeId === index.scopeId) {
      await ctx.db.patch("tables", table._id, {
        schemaRev: table.schemaRev + 1,
        updatedAt: checkedAt,
      });
    }
    await ctx.db.patch("indexDefinitions", index._id, {
      state: "failed",
      maintenanceState: "failed",
      activeJobId: undefined,
      uniqueEnforcementActivated:
        index.unique &&
        (index.uniqueEnforcementActivated === true || index.state === "ready")
          ? true
          : index.uniqueEnforcementActivated,
      verification,
      failure: {
        code,
        message,
        samples,
      },
      updatedAt: checkedAt,
    });
    await failJob(ctx, job, code, message);
    return;
  }
  const table = await ctx.db.get("tables", index.tableId);
  if (table && table.scopeId === index.scopeId && index.state !== "ready") {
    await ctx.db.patch("tables", table._id, {
      schemaRev: table.schemaRev + 1,
      updatedAt: checkedAt,
    });
  }
  await ctx.db.patch("indexDefinitions", index._id, {
    state: "ready",
    maintenanceState: "idle",
    activeJobId: undefined,
    uniqueEnforcementActivated: index.unique
      ? true
      : index.uniqueEnforcementActivated,
    verification,
    failure: null,
    updatedAt: checkedAt,
  });
  await succeedJob(ctx, job);
}

async function currentIndexJob(
  ctx: MutationCtx,
  args: { jobId: Id<"jobs">; generation: number; phase: Doc<"jobs">["phase"] },
): Promise<{ job: IndexJob; index: Doc<"indexDefinitions"> } | null> {
  const job = await ctx.db.get("jobs", args.jobId);
  if (
    !job ||
    !["buildIndex", "repairIndex", "verifyIndex"].includes(job.kind) ||
    job.generation !== args.generation ||
    job.phase !== args.phase ||
    isTerminal(job)
  )
    return null;
  const index = await requireCurrentIndex(
    ctx,
    job,
    maintenanceForPhase(job.phase),
  );
  return index ? { job: job as IndexJob, index } : null;
}

async function currentDeleteIndexJob(
  ctx: MutationCtx,
  args: { jobId: Id<"jobs">; generation: number; phase: Doc<"jobs">["phase"] },
) {
  const job = await ctx.db.get("jobs", args.jobId);
  if (
    !job ||
    job.kind !== "deleteIndex" ||
    job.generation !== args.generation ||
    job.phase !== args.phase ||
    isTerminal(job)
  )
    return null;
  const index = await requireCurrentIndex(ctx, job, "deleting");
  return index ? { job, index } : null;
}

async function currentDeleteTableJob(
  ctx: MutationCtx,
  args: { jobId: Id<"jobs">; generation: number; phase: Doc<"jobs">["phase"] },
) {
  const job = await ctx.db.get("jobs", args.jobId);
  if (
    !job ||
    job.kind !== "deleteTable" ||
    job.generation !== args.generation ||
    job.phase !== args.phase ||
    isTerminal(job)
  )
    return null;
  const table = await requireCurrentTable(ctx, job);
  return table ? { job, table } : null;
}

async function requireCurrentIndex(
  ctx: MutationCtx,
  job: Doc<"jobs">,
  maintenanceState: Doc<"indexDefinitions">["maintenanceState"],
) {
  const indexId = ctx.db.normalizeId("indexDefinitions", job.targetId);
  const index = indexId ? await ctx.db.get("indexDefinitions", indexId) : null;
  if (
    !index ||
    index.scopeId !== job.scopeId ||
    index.generation !== job.generation ||
    index.activeJobId !== job._id ||
    index.maintenanceState !== maintenanceState
  ) {
    await supersedeJob(ctx, job);
    return null;
  }
  return index;
}

async function requireCurrentTable(ctx: MutationCtx, job: Doc<"jobs">) {
  const tableId = ctx.db.normalizeId("tables", job.targetId);
  const table = tableId ? await ctx.db.get("tables", tableId) : null;
  if (
    !table ||
    table.scopeId !== job.scopeId ||
    table.state !== "deleting" ||
    table.generation !== job.generation ||
    table.activeJobId !== job._id
  ) {
    await supersedeJob(ctx, job);
    return null;
  }
  return table;
}

async function transitionIndex(
  ctx: MutationCtx,
  job: IndexJob,
  index: Doc<"indexDefinitions">,
  phase: Doc<"jobs">["phase"],
  maintenanceState: NonNullable<Doc<"indexDefinitions">["maintenanceState"]>,
  completed: number,
) {
  if (!(await requireCurrentIndex(ctx, job, maintenanceForPhase(job.phase))))
    return;
  await ctx.db.patch("indexDefinitions", index._id, {
    maintenanceState,
    updatedAt: Date.now(),
  });
  await ctx.db.patch("jobs", job._id, {
    phase,
    cursor: null,
    progress: job.progress + completed,
    updatedAt: Date.now(),
  });
  await schedule(ctx, job, phase);
}

async function continueIndex(
  ctx: MutationCtx,
  job: IndexJob,
  phase: Doc<"jobs">["phase"],
  cursor: string,
  completed: number,
) {
  await ctx.db.patch("jobs", job._id, {
    phase,
    cursor,
    progress: job.progress + completed,
    updatedAt: Date.now(),
  });
  await schedule(ctx, job, phase);
}

async function schedule(
  ctx: MutationCtx,
  job: Pick<Doc<"jobs">, "_id" | "kind" | "generation">,
  phase: Doc<"jobs">["phase"],
) {
  await ctx.scheduler.runAfter(0, internal.jobRunner.process, {
    jobId: job._id,
    generation: job.generation ?? 0,
    kind: job.kind,
    phase,
  });
}

async function mergeVerification(
  ctx: MutationCtx,
  job: Doc<"jobs">,
  delta: Verification,
) {
  const current =
    (await ctx.db.get("jobs", job._id))?.verification ?? emptyVerification();
  const merged: Verification = {
    missing: current.missing + delta.missing,
    orphaned: current.orphaned + delta.orphaned,
    stale: current.stale + delta.stale,
    duplicate: current.duplicate + delta.duplicate,
    missingSamples: mergeSamples(current.missingSamples, delta.missingSamples),
    orphanedSamples: mergeSamples(
      current.orphanedSamples,
      delta.orphanedSamples,
    ),
    staleSamples: mergeSamples(current.staleSamples, delta.staleSamples),
    duplicateSamples: mergeSamples(
      current.duplicateSamples,
      delta.duplicateSamples,
    ),
  };
  await ctx.db.patch("jobs", job._id, { verification: merged });
  return merged;
}

function emptyVerification(): Verification {
  return {
    missing: 0,
    orphaned: 0,
    stale: 0,
    duplicate: 0,
    missingSamples: [],
    orphanedSamples: [],
    staleSamples: [],
    duplicateSamples: [],
  };
}

function addFinding(
  result: Verification,
  kind: "missing" | "orphaned" | "stale" | "duplicate",
  id: string,
  count = 1,
) {
  result[kind] += count;
  const samples = result[`${kind}Samples`];
  if (samples.length < SAMPLE_LIMIT && !samples.includes(id)) samples.push(id);
}

function mergeSamples(left: string[], right: string[]) {
  return [...new Set([...left, ...right])].slice(0, SAMPLE_LIMIT);
}

function entryMatches(
  entry: Doc<"indexEntries">,
  expected: [Scalar, Scalar, Scalar],
  rev: number,
) {
  return (
    Object.is(entry.k0, expected[0]) &&
    Object.is(entry.k1, expected[1]) &&
    Object.is(entry.k2, expected[2]) &&
    entry.recordRev === rev
  );
}

function maintenanceForPhase(
  phase: Doc<"jobs">["phase"],
): NonNullable<Doc<"indexDefinitions">["maintenanceState"]> {
  if (phase === "backfill") return "backfilling";
  if (phase === "repairRecords" || phase === "repairEntries")
    return "repairing";
  if (phase === "verifyRecords" || phase === "verifyEntries")
    return "verifying";
  return "deleting";
}

async function deleteIndexBatchForTable(
  ctx: MutationCtx,
  job: Doc<"jobs">,
  tableId: Id<"tables">,
) {
  for (const state of [
    "building",
    "verifying",
    "ready",
    "failed",
    "deleting",
  ] as const) {
    const definition = (
      await ctx.db
        .query("indexDefinitions")
        .withIndex("by_scopeId_and_tableId_and_state", (q) =>
          q
            .eq("scopeId", job.scopeId)
            .eq("tableId", tableId)
            .eq("state", state),
        )
        .take(1)
    )[0];
    if (!definition) continue;
    const entries = await ctx.db
      .query("indexEntries")
      .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
        q.eq("scopeId", job.scopeId).eq("indexId", definition._id),
      )
      .take(BATCH_SIZE);
    for (const entry of entries) await ctx.db.delete("indexEntries", entry._id);
    if (entries.length === 0)
      await ctx.db.delete("indexDefinitions", definition._id);
    await ctx.db.patch("jobs", job._id, {
      progress: job.progress + entries.length,
      phase: "deleteEntries",
      updatedAt: Date.now(),
    });
    return true;
  }
  return false;
}

async function continueDelete(
  ctx: MutationCtx,
  job: Doc<"jobs">,
  phase: Doc<"jobs">["phase"],
  completed: number,
) {
  if (!(await requireCurrentTable(ctx, job))) return;
  await ctx.db.patch("jobs", job._id, {
    phase,
    progress: job.progress + completed,
    updatedAt: Date.now(),
  });
  await schedule(ctx, job, phase);
}

async function succeedJob(ctx: MutationCtx, job: Doc<"jobs">) {
  const now = Date.now();
  await ctx.db.patch("jobs", job._id, {
    state: "succeeded",
    phase: "done",
    cursor: null,
    lastError: null,
    completedAt: now,
    retentionExpiresAt: now + JOB_RETENTION_MS,
    updatedAt: now,
  });
}

async function failCurrentIndexJob(
  ctx: MutationCtx,
  job: IndexJob,
  index: Doc<"indexDefinitions">,
  code: string,
  message: string,
) {
  await ctx.db.patch("indexDefinitions", index._id, {
    state: index.state === "ready" ? "ready" : "failed",
    maintenanceState: "failed",
    failure: { code, message: message.slice(0, 500), samples: [] },
    updatedAt: Date.now(),
  });
  await failJob(ctx, job, code, message);
}

async function failJob(
  ctx: MutationCtx,
  job: Doc<"jobs">,
  code: string,
  message: string,
) {
  const now = Date.now();
  await ctx.db.patch("jobs", job._id, {
    state: "failed",
    phase: "done",
    cursor: null,
    lastError: { code: code.slice(0, 100), message: message.slice(0, 500) },
    completedAt: now,
    retentionExpiresAt: now + JOB_RETENTION_MS,
    updatedAt: now,
  });
}

async function supersedeJob(ctx: MutationCtx, job: Doc<"jobs">) {
  if (isTerminal(job)) return;
  const now = Date.now();
  await ctx.db.patch("jobs", job._id, {
    state: "superseded",
    phase: "done",
    cursor: null,
    completedAt: now,
    retentionExpiresAt: now + JOB_RETENTION_MS,
    updatedAt: now,
  });
}

function isTerminal(job: Doc<"jobs">) {
  return (
    job.state === "succeeded" ||
    job.state === "failed" ||
    job.state === "superseded"
  );
}
