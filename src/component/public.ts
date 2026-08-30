import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";
import {
  deleteRecordIndexEntries,
  loadFields,
  loadIndexesForWrites,
  loadTable,
  maintainRecordIndexes,
} from "./data.js";
import { fail, invariant } from "./errors.js";
import { normalizeIndexSlots, secureRequestHash, type Scalar } from "./normalization.js";
import { explain, queryRecords as executeQuery } from "./planner.js";
import schema from "./schema.js";
import {
  fieldInputValidator,
  paginationValidator,
  querySpecValidator,
  recordValuesValidator,
} from "./validators.js";
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  MAX_BATCH_BYTES,
  MAX_BATCH_ITEMS,
  MAX_FIELDS,
  MAX_INDEXES,
  ensureActiveTable,
  ensureFieldIds,
  ensureScope,
  validateFieldInput,
  validateFields,
  validateRecordValues,
  validateScopeId,
  validateSlug,
} from "./validation.js";

const tableDoc = schema.doc("tables");
const fieldDoc = schema.doc("fields");
const recordDoc = schema.doc("records");
const indexDoc = schema.doc("indexDefinitions");
const jobDoc = schema.doc("jobs");
const writeResultValidator = v.object({ recordId: v.id("records"), rev: v.number() });
const indexPlanValidator = v.object({
  kind: v.literal("index"),
  indexId: v.id("indexDefinitions"),
  postFiltered: v.boolean(),
});
const scanPlanValidator = v.object({ kind: v.literal("scan"), postFiltered: v.boolean() });
const requiredPlanValidator = v.object({
  kind: v.literal("indexRequired"),
  suggestedIndex: v.array(v.id("fields")),
});
const tableSchemaValidator = v.object({
  table: tableDoc,
  fields: v.array(fieldDoc),
  indexes: v.array(indexDoc),
});

export const listTables = query({
  args: { scopeId: v.string() },
  returns: v.array(tableDoc),
  handler: async (ctx, args) => {
    validateScopeId(args.scopeId);
    return await ctx.db
      .query("tables")
      .withIndex("by_scopeId_and_slug", (q) => q.eq("scopeId", args.scopeId))
      .take(100);
  },
});

export const getTable = query({
  args: { scopeId: v.string(), tableId: v.id("tables") },
  returns: tableSchemaValidator,
  handler: async (ctx, args) => {
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    const fields = await loadFields(ctx, args.scopeId, args.tableId);
    const indexes = await loadAllIndexes(ctx, args.scopeId, args.tableId);
    return { table, fields, indexes };
  },
});

export const getRecord = query({
  args: {
    scopeId: v.string(),
    tableId: v.id("tables"),
    recordId: v.id("records"),
  },
  returns: v.union(v.null(), recordDoc),
  handler: async (ctx, args) => {
    await loadTable(ctx, args.scopeId, args.tableId);
    const record = await ctx.db.get("records", args.recordId);
    if (!record) return null;
    ensureScope(record, args.scopeId, "Record");
    invariant(record.tableId === args.tableId, "NOT_FOUND", "Record does not belong to this table");
    return record;
  },
});

export const queryRecords = query({
  args: {
    scopeId: v.string(),
    tableId: v.id("tables"),
    query: querySpecValidator,
    pagination: paginationValidator,
  },
  returns: v.object({
    page: v.array(recordDoc),
    isDone: v.boolean(),
    continueCursor: v.union(v.null(), v.string()),
    plan: v.union(indexPlanValidator, scanPlanValidator),
  }),
  handler: async (ctx, args) =>
    await executeQuery(ctx, args.scopeId, args.tableId, args.query, args.pagination),
});

export const explainQuery = query({
  args: { scopeId: v.string(), tableId: v.id("tables"), query: querySpecValidator },
  returns: v.union(indexPlanValidator, scanPlanValidator, requiredPlanValidator),
  handler: async (ctx, args) => await explain(ctx, args.scopeId, args.tableId, args.query),
});

export const getJob = query({
  args: { scopeId: v.string(), jobId: v.id("jobs") },
  returns: v.union(v.null(), jobDoc),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("jobs", args.jobId);
    if (!job) return null;
    return ensureScope(job, args.scopeId, "Job");
  },
});

export const createTable = mutation({
  args: {
    scopeId: v.string(),
    slug: v.string(),
    name: v.string(),
    fields: v.array(fieldInputValidator),
  },
  returns: tableSchemaValidator,
  handler: async (ctx, args) => {
    validateScopeId(args.scopeId);
    validateSlug(args.slug);
    validateName(args.name, "Table name");
    validateFields(args.fields);
    const existing = await ctx.db
      .query("tables")
      .withIndex("by_scopeId_and_slug", (q) => q.eq("scopeId", args.scopeId).eq("slug", args.slug))
      .unique();
    invariant(!existing, "VALIDATION_FAILED", `Table slug already exists: ${args.slug}`);
    const now = Date.now();
    const tableId = await ctx.db.insert("tables", {
      scopeId: args.scopeId,
      slug: args.slug,
      name: args.name,
      state: "active",
      schemaRev: 1,
      createdAt: now,
      updatedAt: now,
    });
    const fields: Doc<"fields">[] = [];
    for (const input of args.fields) {
      if (input.constraints?.referenceTableId) {
        ensureScope(
          await ctx.db.get("tables", input.constraints.referenceTableId),
          args.scopeId,
          "Reference target table",
        );
      }
      const fieldId = await ctx.db.insert("fields", {
        scopeId: args.scopeId,
        tableId,
        key: input.key,
        name: input.name,
        type: input.type,
        required: input.required,
        constraints: input.constraints ?? {},
        state: "active",
        createdAt: now,
        updatedAt: now,
      });
      const field = await ctx.db.get("fields", fieldId);
      if (field) fields.push(field);
    }
    const table = await ctx.db.get("tables", tableId);
    if (!table) fail("NOT_FOUND", "Created table could not be read back");
    return { table, fields, indexes: [] };
  },
});

export const updateTable = mutation({
  args: {
    scopeId: v.string(),
    tableId: v.id("tables"),
    patch: v.object({ name: v.optional(v.string()), slug: v.optional(v.string()) }),
    expectedSchemaRev: v.number(),
  },
  returns: tableSchemaValidator,
  handler: async (ctx, args) => {
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    ensureActiveTable(table);
    assertSchemaRev(table, args.expectedSchemaRev);
    if (args.patch.name !== undefined) validateName(args.patch.name, "Table name");
    if (args.patch.slug !== undefined) {
      validateSlug(args.patch.slug);
      const duplicate = await ctx.db
        .query("tables")
        .withIndex("by_scopeId_and_slug", (q) =>
          q.eq("scopeId", args.scopeId).eq("slug", args.patch.slug!),
        )
        .unique();
      invariant(!duplicate || duplicate._id === table._id, "VALIDATION_FAILED", "Table slug already exists");
    }
    await ctx.db.patch("tables", table._id, {
      ...args.patch,
      schemaRev: table.schemaRev + 1,
      updatedAt: Date.now(),
    });
    return {
      table: (await ctx.db.get("tables", table._id))!,
      fields: await loadFields(ctx, args.scopeId, table._id),
      indexes: await loadAllIndexes(ctx, args.scopeId, table._id),
    };
  },
});

export const addField = mutation({
  args: {
    scopeId: v.string(),
    tableId: v.id("tables"),
    field: fieldInputValidator,
    expectedSchemaRev: v.number(),
  },
  returns: fieldDoc,
  handler: async (ctx, args) => {
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    ensureActiveTable(table);
    assertSchemaRev(table, args.expectedSchemaRev);
    validateFieldInput(args.field);
    const fields = await loadFields(ctx, args.scopeId, args.tableId);
    invariant(fields.length < MAX_FIELDS, "LIMIT_EXCEEDED", `Tables allow at most ${MAX_FIELDS} fields`);
    const duplicate = await ctx.db
      .query("fields")
      .withIndex("by_scopeId_and_tableId_and_key", (q) =>
        q.eq("scopeId", args.scopeId).eq("tableId", args.tableId).eq("key", args.field.key),
      )
      .unique();
    invariant(!duplicate, "VALIDATION_FAILED", `Field key already exists: ${args.field.key}`);
    if (args.field.required) {
      const existingRecord = await ctx.db
        .query("records")
        .withIndex("by_scopeId_and_tableId", (q) =>
          q.eq("scopeId", args.scopeId).eq("tableId", args.tableId),
        )
        .first();
      invariant(!existingRecord, "VALIDATION_FAILED", "Required fields cannot be added to a non-empty table");
    }
    if (args.field.constraints?.referenceTableId) {
      ensureScope(
        await ctx.db.get("tables", args.field.constraints.referenceTableId),
        args.scopeId,
        "Reference target table",
      );
    }
    const now = Date.now();
    const fieldId = await ctx.db.insert("fields", {
      scopeId: args.scopeId,
      tableId: args.tableId,
      key: args.field.key,
      name: args.field.name,
      type: args.field.type,
      required: args.field.required,
      constraints: args.field.constraints ?? {},
      state: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch("tables", table._id, { schemaRev: table.schemaRev + 1, updatedAt: now });
    const field = await ctx.db.get("fields", fieldId);
    if (!field) fail("NOT_FOUND", "Created field could not be read back");
    return field;
  },
});

export const updateField = mutation({
  args: {
    scopeId: v.string(),
    fieldId: v.id("fields"),
    patch: v.object({ name: v.string() }),
    expectedSchemaRev: v.number(),
  },
  returns: fieldDoc,
  handler: async (ctx, args) => {
    const field = ensureScope(await ctx.db.get("fields", args.fieldId), args.scopeId, "Field");
    const table = await loadTable(ctx, args.scopeId, field.tableId);
    ensureActiveTable(table);
    assertSchemaRev(table, args.expectedSchemaRev);
    validateName(args.patch.name, "Field name");
    const now = Date.now();
    await ctx.db.patch("fields", field._id, { name: args.patch.name, updatedAt: now });
    await ctx.db.patch("tables", table._id, { schemaRev: table.schemaRev + 1, updatedAt: now });
    return (await ctx.db.get("fields", field._id))!;
  },
});

export const insertRecords = mutation({
  args: {
    scopeId: v.string(),
    tableId: v.id("tables"),
    records: v.array(v.object({ values: recordValuesValidator })),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.array(writeResultValidator),
  handler: async (ctx, args) => {
    validateBatch(args.records);
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    ensureActiveTable(table);
    const fields = await loadFields(ctx, args.scopeId, args.tableId);
    const normalizedRecords = args.records.map((input) => ({
      values: validateRecordValues(fields, input.values as Record<string, Scalar>),
    }));
    const hash = await secureRequestHash(normalizedRecords);
    const cached = await readIdempotency(ctx, args, "insert", hash);
    if (cached) return cached;
    const results: Array<{ recordId: Id<"records">; rev: number }> = [];
    const now = Date.now();
    for (const input of normalizedRecords) {
      const values = input.values;
      const recordId = await ctx.db.insert("records", {
        scopeId: args.scopeId,
        tableId: args.tableId,
        values,
        rev: 1,
        createdAt: now,
        updatedAt: now,
      });
      const record = await ctx.db.get("records", recordId);
      if (!record) fail("NOT_FOUND", "Inserted record could not be read back");
      await maintainRecordIndexes(ctx, record);
      results.push({ recordId, rev: 1 });
    }
    await storeIdempotency(ctx, args, "insert", hash, results);
    return results;
  },
});

export const patchRecord = mutation({
  args: {
    scopeId: v.string(),
    tableId: v.id("tables"),
    recordId: v.id("records"),
    patch: v.object({
      values: recordValuesValidator,
      unsetFieldIds: v.optional(v.array(v.id("fields"))),
    }),
    expectedRev: v.number(),
  },
  returns: writeResultValidator,
  handler: async (ctx, args) => {
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    ensureActiveTable(table);
    const current = ensureScope(await ctx.db.get("records", args.recordId), args.scopeId, "Record");
    invariant(current.tableId === args.tableId, "NOT_FOUND", "Record does not belong to this table");
    assertRecordRev(current, args.expectedRev);
    const nextValues: Record<string, Scalar> = {
      ...(current.values as Record<string, Scalar>),
      ...(args.patch.values as Record<string, Scalar>),
    };
    for (const fieldId of args.patch.unsetFieldIds ?? []) delete nextValues[fieldId];
    const values = validateRecordValues(await loadFields(ctx, args.scopeId, args.tableId), nextValues);
    await ctx.db.patch("records", current._id, {
      values,
      rev: current.rev + 1,
      updatedAt: Date.now(),
    });
    const record = (await ctx.db.get("records", current._id))!;
    await maintainRecordIndexes(ctx, record);
    return { recordId: record._id, rev: record.rev };
  },
});

export const upsertRecords = mutation({
  args: {
    scopeId: v.string(),
    tableId: v.id("tables"),
    uniqueIndexId: v.id("indexDefinitions"),
    records: v.array(v.object({ values: recordValuesValidator })),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.array(writeResultValidator),
  handler: async (ctx, args) => {
    validateBatch(args.records);
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    ensureActiveTable(table);
    const index = ensureScope(
      await ctx.db.get("indexDefinitions", args.uniqueIndexId),
      args.scopeId,
      "Index",
    );
    invariant(index.tableId === args.tableId, "NOT_FOUND", "Index does not belong to this table");
    invariant(index.unique && index.state === "ready", "INDEX_NOT_READY", "Upsert requires a ready unique index");
    const fields = await loadFields(ctx, args.scopeId, args.tableId);
    const normalizedRecords = args.records.map((input) => ({
      values: validateRecordValues(fields, input.values as Record<string, Scalar>),
    }));
    const hash = await secureRequestHash({
      indexId: args.uniqueIndexId,
      records: normalizedRecords,
    });
    const cached = await readIdempotency(ctx, args, "upsert", hash);
    if (cached) return cached;
    const results: Array<{ recordId: Id<"records">; rev: number }> = [];
    for (const input of normalizedRecords) {
      const values = input.values;
      const [k0, k1, k2] = normalizeIndexSlots(index.fieldIds, values);
      const matches = await ctx.db
        .query("indexEntries")
        .withIndex(
          "by_scopeId_and_indexId_and_k0_and_k1_and_k2_and_recordId",
          (q) =>
            q
              .eq("scopeId", args.scopeId)
              .eq("indexId", index._id)
              .eq("k0", k0)
              .eq("k1", k1)
              .eq("k2", k2),
        )
        .take(2);
      invariant(matches.length <= 1, "UNIQUE_CONFLICT", "Unique index contains duplicate entries");
      const existing = matches[0] ? await ctx.db.get("records", matches[0].recordId) : null;
      if (existing) {
        ensureScope(existing, args.scopeId, "Record");
        await ctx.db.patch("records", existing._id, {
          values,
          rev: existing.rev + 1,
          updatedAt: Date.now(),
        });
        const updated = (await ctx.db.get("records", existing._id))!;
        await maintainRecordIndexes(ctx, updated);
        results.push({ recordId: updated._id, rev: updated.rev });
      } else {
        const now = Date.now();
        const recordId = await ctx.db.insert("records", {
          scopeId: args.scopeId,
          tableId: args.tableId,
          values,
          rev: 1,
          createdAt: now,
          updatedAt: now,
        });
        const record = (await ctx.db.get("records", recordId))!;
        await maintainRecordIndexes(ctx, record);
        results.push({ recordId, rev: 1 });
      }
    }
    await storeIdempotency(ctx, args, "upsert", hash, results);
    return results;
  },
});

export const deleteRecord = mutation({
  args: {
    scopeId: v.string(),
    tableId: v.id("tables"),
    recordId: v.id("records"),
    expectedRev: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    ensureActiveTable(table);
    const record = ensureScope(await ctx.db.get("records", args.recordId), args.scopeId, "Record");
    invariant(record.tableId === args.tableId, "NOT_FOUND", "Record does not belong to this table");
    if (args.expectedRev !== undefined) assertRecordRev(record, args.expectedRev);
    await deleteRecordIndexEntries(ctx, args.scopeId, record._id);
    await ctx.db.delete("records", record._id);
    return null;
  },
});

export const createIndex = mutation({
  args: {
    scopeId: v.string(),
    tableId: v.id("tables"),
    name: v.string(),
    fieldIds: v.array(v.id("fields")),
    unique: v.boolean(),
  },
  returns: v.object({ indexId: v.id("indexDefinitions"), jobId: v.id("jobs") }),
  handler: async (ctx, args) => {
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    ensureActiveTable(table);
    validateIndexName(args.name);
    const fields = await loadFields(ctx, args.scopeId, args.tableId);
    ensureFieldIds(fields, args.fieldIds);
    const indexes = await loadAllIndexes(ctx, args.scopeId, args.tableId);
    invariant(indexes.length < MAX_INDEXES, "LIMIT_EXCEEDED", `Tables allow at most ${MAX_INDEXES} indexes`);
    invariant(!indexes.some((index) => index.name === args.name), "VALIDATION_FAILED", "Index name already exists");
    const now = Date.now();
    const indexId = await ctx.db.insert("indexDefinitions", {
      scopeId: args.scopeId,
      tableId: args.tableId,
      name: args.name,
      fieldIds: args.fieldIds,
      unique: args.unique,
      state: "building",
      failure: null,
      createdAt: now,
      updatedAt: now,
    });
    const jobId = await createJob(ctx, args.scopeId, "buildIndex", indexId, "backfill");
    await ctx.scheduler.runAfter(0, internal.indexJobs.processIndexJob, { jobId });
    return { indexId, jobId };
  },
});

export const verifyIndex = mutation({
  args: { scopeId: v.string(), indexId: v.id("indexDefinitions") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, args) => {
    const index = ensureScope(await ctx.db.get("indexDefinitions", args.indexId), args.scopeId, "Index");
    invariant(index.state !== "deleting", "INDEX_NOT_READY", "Index is being deleted");
    await ctx.db.patch("indexDefinitions", index._id, { state: "verifying", failure: null, updatedAt: Date.now() });
    const jobId = await createJob(ctx, args.scopeId, "buildIndex", index._id, "verifyRecords");
    await ctx.scheduler.runAfter(0, internal.indexJobs.processIndexJob, { jobId });
    return { jobId };
  },
});

export const retryIndexBuild = mutation({
  args: { scopeId: v.string(), indexId: v.id("indexDefinitions") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, args) => {
    const index = ensureScope(await ctx.db.get("indexDefinitions", args.indexId), args.scopeId, "Index");
    invariant(index.state === "failed", "INDEX_NOT_READY", "Only failed indexes can be retried");
    await ctx.db.patch("indexDefinitions", index._id, { state: "verifying", failure: null, updatedAt: Date.now() });
    const jobId = await createJob(ctx, args.scopeId, "buildIndex", index._id, "verifyRecords");
    await ctx.scheduler.runAfter(0, internal.indexJobs.processIndexJob, { jobId });
    return { jobId };
  },
});

export const deleteIndex = mutation({
  args: { scopeId: v.string(), indexId: v.id("indexDefinitions") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, args) => {
    const index = ensureScope(await ctx.db.get("indexDefinitions", args.indexId), args.scopeId, "Index");
    await ctx.db.patch("indexDefinitions", index._id, { state: "deleting", updatedAt: Date.now() });
    const jobId = await createJob(ctx, args.scopeId, "deleteIndex", index._id, "deleteEntries");
    await ctx.scheduler.runAfter(0, internal.indexJobs.processDeleteIndexJob, { jobId });
    return { jobId };
  },
});

export const deleteTable = mutation({
  args: { scopeId: v.string(), tableId: v.id("tables") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, args) => {
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    await ctx.db.patch("tables", table._id, { state: "deleting", updatedAt: Date.now() });
    const jobId = await createJob(ctx, args.scopeId, "deleteTable", table._id, "deleteEntries");
    await ctx.scheduler.runAfter(0, internal.indexJobs.processDeleteTableJob, { jobId });
    return { jobId };
  },
});

async function loadAllIndexes(
  ctx: Parameters<typeof loadIndexesForWrites>[0],
  scopeId: string,
  tableId: Id<"tables">,
): Promise<Doc<"indexDefinitions">[]> {
  const states = ["building", "verifying", "ready", "failed", "deleting"] as const;
  const groups = await Promise.all(
    states.map((state) =>
      ctx.db
        .query("indexDefinitions")
        .withIndex("by_scopeId_and_tableId_and_state", (q) =>
          q.eq("scopeId", scopeId).eq("tableId", tableId).eq("state", state),
        )
        .take(5),
    ),
  );
  return groups.flat();
}

async function createJob(
  ctx: MutationCtx,
  scopeId: string,
  kind: Doc<"jobs">["kind"],
  targetId: string,
  phase: Doc<"jobs">["phase"],
): Promise<Id<"jobs">> {
  const now = Date.now();
  return await ctx.db.insert("jobs", {
    scopeId,
    kind,
    targetId,
    state: "queued",
    phase,
    cursor: null,
    progress: 0,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function readIdempotency(
  ctx: MutationCtx,
  args: { scopeId: string; tableId: Id<"tables">; idempotencyKey?: string },
  operation: "insert" | "upsert",
  hash: string,
): Promise<Array<{ recordId: Id<"records">; rev: number }> | null> {
  if (!args.idempotencyKey) return null;
  invariant(args.idempotencyKey.length <= 200, "VALIDATION_FAILED", "idempotencyKey is too long");
  const existing = await ctx.db
    .query("idempotencyKeys")
    .withIndex("by_scopeId_and_tableId_and_operation_and_key", (q) =>
      q
        .eq("scopeId", args.scopeId)
        .eq("tableId", args.tableId)
        .eq("operation", operation)
        .eq("key", args.idempotencyKey!),
    )
    .unique();
  if (!existing) return null;
  if (existing.expiresAt <= Date.now()) {
    await ctx.db.delete("idempotencyKeys", existing._id);
    return null;
  }
  invariant(
    existing.requestHash === hash,
    "IDEMPOTENCY_KEY_REUSED",
    "Idempotency key was reused with a different request",
  );
  return existing.resultSummary;
}

async function storeIdempotency(
  ctx: MutationCtx,
  args: { scopeId: string; tableId: Id<"tables">; idempotencyKey?: string },
  operation: "insert" | "upsert",
  hash: string,
  resultSummary: Array<{ recordId: Id<"records">; rev: number }>,
): Promise<void> {
  if (!args.idempotencyKey) return;
  const now = Date.now();
  await ctx.db.insert("idempotencyKeys", {
    scopeId: args.scopeId,
    tableId: args.tableId,
    operation,
    key: args.idempotencyKey,
    requestHash: hash,
    resultSummary,
    expiresAt: now + DEFAULT_IDEMPOTENCY_TTL_MS,
    createdAt: now,
  });
  await ctx.scheduler.runAfter(
    DEFAULT_IDEMPOTENCY_TTL_MS,
    internal.maintenance.cleanupIdempotency,
    { scopeId: args.scopeId },
  );
}

function validateBatch(records: readonly unknown[]): void {
  invariant(
    records.length >= 1 && records.length <= MAX_BATCH_ITEMS,
    "LIMIT_EXCEEDED",
    `Batches require 1 to ${MAX_BATCH_ITEMS} records`,
  );
  const bytes = new TextEncoder().encode(JSON.stringify(records)).byteLength;
  invariant(bytes <= MAX_BATCH_BYTES, "LIMIT_EXCEEDED", "Batch exceeds the byte safety budget", { bytes });
}

function assertSchemaRev(table: Doc<"tables">, expected: number): void {
  if (table.schemaRev !== expected) {
    fail("CONFLICT", "Table schema revision changed", { currentRev: table.schemaRev });
  }
}

function assertRecordRev(record: Doc<"records">, expected: number): void {
  if (record.rev !== expected) {
    fail("CONFLICT", "Record revision changed", {
      currentRev: record.rev,
      currentRecord: JSON.stringify(record),
    });
  }
}

function validateName(value: string, label: string): void {
  invariant(value.length >= 1 && value.length <= 200, "VALIDATION_FAILED", `${label} must contain 1 to 200 characters`);
}

function validateIndexName(value: string): void {
  invariant(
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value),
    "VALIDATION_FAILED",
    "Index names must start with a letter and contain only letters, digits, underscores, and hyphens",
  );
}
