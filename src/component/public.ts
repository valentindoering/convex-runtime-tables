import { paginator } from "convex-helpers/server/pagination";
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
import {
  normalizeIndexSlots,
  secureRequestHash,
  type Scalar,
} from "./normalization.js";
import {
  explain,
  paginateWithCursorGuard,
  validateInnerCursor,
  queryRecords as executeQuery,
} from "./planner.js";
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
  MAX_CURSOR_BYTES,
  MAX_FIELDS,
  MAX_INDEXES,
  ensureActiveTable,
  ensureFieldIds,
  ensureScope,
  validateFieldInput,
  validateFields,
  validateRecordValues,
  validatePositiveInteger,
  validateStoredDocumentSize,
  validateScopeId,
  validateSlug,
} from "./validation.js";

const tableDoc = schema.doc("tables");
const fieldDoc = schema.doc("fields");
const recordDoc = schema.doc("records");
const indexDoc = schema.doc("indexDefinitions");
const jobDoc = schema.doc("jobs");
const writeResultValidator = v.object({
  recordId: v.id("records"),
  rev: v.number(),
});
const indexPlanValidator = v.object({
  kind: v.literal("index"),
  indexId: v.id("indexDefinitions"),
  postFiltered: v.boolean(),
});
const scanPlanValidator = v.object({
  kind: v.literal("scan"),
  postFiltered: v.boolean(),
});
const tablePlanValidator = v.object({
  kind: v.literal("table"),
  postFiltered: v.literal(false),
});
const requiredPlanValidator = v.object({
  kind: v.literal("indexRequired"),
  suggestedIndex: v.array(v.id("fields")),
});
const tableSchemaValidator = v.object({
  table: tableDoc,
  fields: v.array(fieldDoc),
  indexes: v.array(indexDoc),
});
const auditEntryValidator = v.object({
  recordId: v.id("records"),
  recordRev: v.number(),
  k0: v.union(v.null(), v.boolean(), v.number(), v.string()),
  k1: v.union(v.null(), v.boolean(), v.number(), v.string()),
  k2: v.union(v.null(), v.boolean(), v.number(), v.string()),
});

export const listTables = query({
  args: { scopeId: v.string(), pagination: paginationValidator },
  returns: v.object({
    page: v.array(tableDoc),
    isDone: v.boolean(),
    continueCursor: v.union(v.null(), v.string()),
  }),
  handler: async (ctx, args) => {
    validateScopeId(args.scopeId);
    const cursor = decodeOperatorCursor(
      args.pagination.cursor,
      "listTables",
      args.scopeId,
      args.scopeId,
    );
    const endCursor = decodeOperatorCursor(
      args.pagination.endCursor,
      "listTables",
      args.scopeId,
      args.scopeId,
    );
    validatePositiveInteger(args.pagination.pageSize, "pageSize", 100, 50);
    const result = await paginateWithCursorGuard(
      () =>
        paginator(ctx.db, schema)
          .query("tables")
          .withIndex("by_scopeId_and_slug", (q) =>
            q.eq("scopeId", args.scopeId),
          )
          .paginate({
            numItems: args.pagination.pageSize,
            cursor: cursor?.inner ?? null,
            ...(endCursor ? { endCursor: endCursor.inner } : {}),
            maximumRowsRead: validatePositiveInteger(
              args.pagination.maximumRowsRead,
              "maximumRowsRead",
              1_000,
              500,
            ),
            maximumBytesRead: validatePositiveInteger(
              args.pagination.maximumBytesRead,
              "maximumBytesRead",
              4_000_000,
              4_000_000,
            ),
          }),
      Boolean(cursor || endCursor),
    );
    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.isDone
        ? null
        : encodeOperatorCursor(
            "listTables",
            args.scopeId,
            args.scopeId,
            result.continueCursor,
          ),
    };
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
    invariant(
      record.tableId === args.tableId,
      "NOT_FOUND",
      "Record does not belong to this table",
    );
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
    plan: v.union(indexPlanValidator, tablePlanValidator, scanPlanValidator),
  }),
  handler: async (ctx, args) =>
    await executeQuery(
      ctx,
      args.scopeId,
      args.tableId,
      args.query,
      args.pagination,
    ),
});

export const explainQuery = query({
  args: {
    scopeId: v.string(),
    tableId: v.id("tables"),
    query: querySpecValidator,
  },
  returns: v.union(
    indexPlanValidator,
    tablePlanValidator,
    scanPlanValidator,
    requiredPlanValidator,
  ),
  handler: async (ctx, args) =>
    await explain(ctx, args.scopeId, args.tableId, args.query),
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

/** Bounded raw sidecar access for an independent host-owned consistency oracle. */
export const auditIndexEntries = query({
  args: {
    scopeId: v.string(),
    indexId: v.id("indexDefinitions"),
    pagination: paginationValidator,
  },
  returns: v.object({
    page: v.array(auditEntryValidator),
    isDone: v.boolean(),
    continueCursor: v.union(v.null(), v.string()),
  }),
  handler: async (ctx, args) => {
    validateScopeId(args.scopeId);
    const index = ensureScope(
      await ctx.db.get("indexDefinitions", args.indexId),
      args.scopeId,
      "Index",
    );
    const cursor = decodeOperatorCursor(
      args.pagination.cursor,
      "auditIndexEntries",
      args.scopeId,
      index._id,
    );
    const endCursor = decodeOperatorCursor(
      args.pagination.endCursor,
      "auditIndexEntries",
      args.scopeId,
      index._id,
    );
    const result = await paginateWithCursorGuard(
      () =>
        paginator(ctx.db, schema)
          .query("indexEntries")
          .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
            q.eq("scopeId", args.scopeId).eq("indexId", index._id),
          )
          .paginate({
            numItems: validatePositiveInteger(
              args.pagination.pageSize,
              "pageSize",
              100,
              50,
            ),
            cursor: cursor?.inner ?? null,
            ...(endCursor ? { endCursor: endCursor.inner } : {}),
            maximumRowsRead: validatePositiveInteger(
              args.pagination.maximumRowsRead,
              "maximumRowsRead",
              1_000,
              500,
            ),
            maximumBytesRead: validatePositiveInteger(
              args.pagination.maximumBytesRead,
              "maximumBytesRead",
              4_000_000,
              4_000_000,
            ),
          }),
      Boolean(cursor || endCursor),
    );
    return {
      page: result.page.map((entry) => ({
        recordId: entry.recordId,
        recordRev: entry.recordRev,
        k0: entry.k0,
        k1: entry.k1,
        k2: entry.k2,
      })),
      isDone: result.isDone,
      continueCursor: result.isDone
        ? null
        : encodeOperatorCursor(
            "auditIndexEntries",
            args.scopeId,
            index._id,
            result.continueCursor,
          ),
    };
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
      .withIndex("by_scopeId_and_slug", (q) =>
        q.eq("scopeId", args.scopeId).eq("slug", args.slug),
      )
      .unique();
    invariant(
      !existing,
      "VALIDATION_FAILED",
      `Table slug already exists: ${args.slug}`,
    );
    const now = Date.now();
    const tableId = await ctx.db.insert("tables", {
      scopeId: args.scopeId,
      slug: args.slug,
      name: args.name,
      state: "active",
      schemaRev: 1,
      generation: 0,
      createdAt: now,
      updatedAt: now,
    });
    const fields: Doc<"fields">[] = [];
    for (const input of args.fields) {
      if (input.constraints?.referenceTableId) {
        ensureActiveTable(
          ensureScope(
            await ctx.db.get("tables", input.constraints.referenceTableId),
            args.scopeId,
            "Reference target table",
          ),
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
    patch: v.object({
      name: v.optional(v.string()),
      slug: v.optional(v.string()),
    }),
    expectedSchemaRev: v.number(),
  },
  returns: tableSchemaValidator,
  handler: async (ctx, args) => {
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    ensureActiveTable(table);
    assertSchemaRev(table, args.expectedSchemaRev);
    if (args.patch.name !== undefined)
      validateName(args.patch.name, "Table name");
    if (args.patch.slug !== undefined) {
      validateSlug(args.patch.slug);
      const duplicate = await ctx.db
        .query("tables")
        .withIndex("by_scopeId_and_slug", (q) =>
          q.eq("scopeId", args.scopeId).eq("slug", args.patch.slug!),
        )
        .unique();
      invariant(
        !duplicate || duplicate._id === table._id,
        "VALIDATION_FAILED",
        "Table slug already exists",
      );
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
    invariant(
      fields.length < MAX_FIELDS,
      "LIMIT_EXCEEDED",
      `Tables allow at most ${MAX_FIELDS} fields`,
    );
    const duplicate = await ctx.db
      .query("fields")
      .withIndex("by_scopeId_and_tableId_and_key", (q) =>
        q
          .eq("scopeId", args.scopeId)
          .eq("tableId", args.tableId)
          .eq("key", args.field.key),
      )
      .unique();
    invariant(
      !duplicate,
      "VALIDATION_FAILED",
      `Field key already exists: ${args.field.key}`,
    );
    if (args.field.required) {
      const existingRecord = await ctx.db
        .query("records")
        .withIndex("by_scopeId_and_tableId", (q) =>
          q.eq("scopeId", args.scopeId).eq("tableId", args.tableId),
        )
        .first();
      invariant(
        !existingRecord,
        "VALIDATION_FAILED",
        "Required fields cannot be added to a non-empty table",
      );
    }
    if (args.field.constraints?.referenceTableId) {
      ensureActiveTable(
        ensureScope(
          await ctx.db.get("tables", args.field.constraints.referenceTableId),
          args.scopeId,
          "Reference target table",
        ),
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
    await ctx.db.patch("tables", table._id, {
      schemaRev: table.schemaRev + 1,
      updatedAt: now,
    });
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
    const field = ensureScope(
      await ctx.db.get("fields", args.fieldId),
      args.scopeId,
      "Field",
    );
    const table = await loadTable(ctx, args.scopeId, field.tableId);
    ensureActiveTable(table);
    assertSchemaRev(table, args.expectedSchemaRev);
    validateName(args.patch.name, "Field name");
    const now = Date.now();
    await ctx.db.patch("fields", field._id, {
      name: args.patch.name,
      updatedAt: now,
    });
    await ctx.db.patch("tables", table._id, {
      schemaRev: table.schemaRev + 1,
      updatedAt: now,
    });
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
      values: validateRecordValues(
        fields,
        input.values as Record<string, Scalar>,
      ),
    }));
    await validateReferenceValues(
      ctx,
      args.scopeId,
      fields,
      normalizedRecords.map((record) => record.values),
    );
    const hash = await secureRequestHash(normalizedRecords);
    const cached = await readIdempotency(ctx, args, "insert", hash);
    if (cached) return cached;
    const results: Array<{ recordId: Id<"records">; rev: number }> = [];
    const now = Date.now();
    for (const input of normalizedRecords) {
      const values = input.values;
      validateRecordDocument(args.scopeId, args.tableId, values, 1, now, now);
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
    const current = ensureScope(
      await ctx.db.get("records", args.recordId),
      args.scopeId,
      "Record",
    );
    invariant(
      current.tableId === args.tableId,
      "NOT_FOUND",
      "Record does not belong to this table",
    );
    assertRecordRev(current, args.expectedRev);
    const nextValues: Record<string, Scalar> = {
      ...(current.values as Record<string, Scalar>),
      ...(args.patch.values as Record<string, Scalar>),
    };
    for (const fieldId of args.patch.unsetFieldIds ?? [])
      delete nextValues[fieldId];
    const fields = await loadFields(ctx, args.scopeId, args.tableId);
    const values = validateRecordValues(fields, nextValues);
    await validateReferenceValues(ctx, args.scopeId, fields, [values]);
    validateRecordDocument(
      args.scopeId,
      args.tableId,
      values,
      current.rev + 1,
      current.createdAt,
      Date.now(),
    );
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
    invariant(
      index.tableId === args.tableId,
      "NOT_FOUND",
      "Index does not belong to this table",
    );
    invariant(
      index.unique && index.state === "ready",
      "INDEX_NOT_READY",
      "Upsert requires a ready unique index",
    );
    const fields = await loadFields(ctx, args.scopeId, args.tableId);
    const normalizedRecords = args.records.map((input) => ({
      values: validateRecordValues(
        fields,
        input.values as Record<string, Scalar>,
      ),
    }));
    await validateReferenceValues(
      ctx,
      args.scopeId,
      fields,
      normalizedRecords.map((record) => record.values),
    );
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
      invariant(
        ![k0, k1, k2].slice(0, index.fieldIds.length).includes(null),
        "VALIDATION_FAILED",
        "Upsert unique keys cannot contain null or missing values",
      );
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
      invariant(
        matches.length <= 1,
        "UNIQUE_CONFLICT",
        "Unique index contains duplicate entries",
      );
      const existing = matches[0]
        ? await ctx.db.get("records", matches[0].recordId)
        : null;
      if (existing) {
        ensureScope(existing, args.scopeId, "Record");
        validateRecordDocument(
          args.scopeId,
          args.tableId,
          values,
          existing.rev + 1,
          existing.createdAt,
          Date.now(),
        );
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
        validateRecordDocument(args.scopeId, args.tableId, values, 1, now, now);
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
    const record = ensureScope(
      await ctx.db.get("records", args.recordId),
      args.scopeId,
      "Record",
    );
    invariant(
      record.tableId === args.tableId,
      "NOT_FOUND",
      "Record does not belong to this table",
    );
    if (args.expectedRev !== undefined)
      assertRecordRev(record, args.expectedRev);
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
    invariant(
      indexes.length < MAX_INDEXES,
      "LIMIT_EXCEEDED",
      `Tables allow at most ${MAX_INDEXES} indexes`,
    );
    invariant(
      !indexes.some((index) => index.name === args.name),
      "VALIDATION_FAILED",
      "Index name already exists",
    );
    const now = Date.now();
    const indexId = await ctx.db.insert("indexDefinitions", {
      scopeId: args.scopeId,
      tableId: args.tableId,
      name: args.name,
      fieldIds: args.fieldIds,
      unique: args.unique,
      uniqueEnforcementActivated: false,
      state: "building",
      maintenanceState: "backfilling",
      generation: 1,
      failure: null,
      createdAt: now,
      updatedAt: now,
    });
    const jobId = await createJob(
      ctx,
      args.scopeId,
      "buildIndex",
      indexId,
      "backfill",
      1,
    );
    await ctx.db.patch("indexDefinitions", indexId, { activeJobId: jobId });
    await ctx.db.patch("tables", table._id, {
      schemaRev: table.schemaRev + 1,
      updatedAt: now,
    });
    await scheduleJob(ctx, jobId, "buildIndex", 1, "backfill");
    return { indexId, jobId };
  },
});

export const verifyIndex = mutation({
  args: { scopeId: v.string(), indexId: v.id("indexDefinitions") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, args) => {
    const index = ensureScope(
      await ctx.db.get("indexDefinitions", args.indexId),
      args.scopeId,
      "Index",
    );
    invariant(
      index.state !== "deleting",
      "INDEX_NOT_READY",
      "Index is being deleted",
    );
    return await startIndexMaintenance(
      ctx,
      index,
      "verifyIndex",
      "verifyRecords",
    );
  },
});

export const repairIndex = mutation({
  args: { scopeId: v.string(), indexId: v.id("indexDefinitions") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, args) => {
    const index = ensureScope(
      await ctx.db.get("indexDefinitions", args.indexId),
      args.scopeId,
      "Index",
    );
    invariant(
      index.state !== "deleting",
      "INDEX_NOT_READY",
      "Index is being deleted",
    );
    return await startIndexMaintenance(
      ctx,
      index,
      "repairIndex",
      "repairRecords",
    );
  },
});

export const retryIndexBuild = mutation({
  args: { scopeId: v.string(), indexId: v.id("indexDefinitions") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, args) => {
    const index = ensureScope(
      await ctx.db.get("indexDefinitions", args.indexId),
      args.scopeId,
      "Index",
    );
    invariant(
      index.state === "failed",
      "INDEX_NOT_READY",
      "Only failed indexes can be retried",
    );
    return await startIndexMaintenance(
      ctx,
      index,
      "repairIndex",
      "repairRecords",
    );
  },
});

export const deleteIndex = mutation({
  args: { scopeId: v.string(), indexId: v.id("indexDefinitions") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, args) => {
    const index = ensureScope(
      await ctx.db.get("indexDefinitions", args.indexId),
      args.scopeId,
      "Index",
    );
    if (index.state === "deleting" && index.activeJobId) {
      const activeJob = await ctx.db.get("jobs", index.activeJobId);
      if (activeJob && !isTerminalJob(activeJob.state)) {
        return { jobId: index.activeJobId };
      }
    }
    const generation = (index.generation ?? 0) + 1;
    const jobId = await createJob(
      ctx,
      args.scopeId,
      "deleteIndex",
      index._id,
      "deleteEntries",
      generation,
    );
    await ctx.db.patch("indexDefinitions", index._id, {
      state: "deleting",
      maintenanceState: "deleting",
      generation,
      activeJobId: jobId,
      updatedAt: Date.now(),
    });
    const table = await ctx.db.get("tables", index.tableId);
    if (table && table.scopeId === args.scopeId) {
      await ctx.db.patch("tables", table._id, {
        schemaRev: table.schemaRev + 1,
        updatedAt: Date.now(),
      });
    }
    await scheduleJob(ctx, jobId, "deleteIndex", generation, "deleteEntries");
    return { jobId };
  },
});

export const deleteTable = mutation({
  args: { scopeId: v.string(), tableId: v.id("tables") },
  returns: v.object({ jobId: v.id("jobs") }),
  handler: async (ctx, args) => {
    const table = await loadTable(ctx, args.scopeId, args.tableId);
    if (table.state === "deleting" && table.activeJobId) {
      const activeJob = await ctx.db.get("jobs", table.activeJobId);
      if (activeJob && !isTerminalJob(activeJob.state)) {
        return { jobId: table.activeJobId };
      }
    }
    const generation = (table.generation ?? 0) + 1;
    const jobId = await createJob(
      ctx,
      args.scopeId,
      "deleteTable",
      table._id,
      "deleteEntries",
      generation,
    );
    await ctx.db.patch("tables", table._id, {
      state: "deleting",
      generation,
      activeJobId: jobId,
      schemaRev: table.schemaRev + 1,
      updatedAt: Date.now(),
    });
    const indexes = await loadAllIndexes(ctx, args.scopeId, table._id);
    for (const index of indexes) {
      await ctx.db.patch("indexDefinitions", index._id, {
        state: "deleting",
        maintenanceState: "deleting",
        generation: (index.generation ?? 0) + 1,
        activeJobId: undefined,
        updatedAt: Date.now(),
      });
    }
    await scheduleJob(ctx, jobId, "deleteTable", generation, "deleteEntries");
    return { jobId };
  },
});

type OperatorCursorKind = "listTables" | "auditIndexEntries";
type OperatorCursor = {
  version: 1;
  kind: OperatorCursorKind;
  scopeId: string;
  resourceId: string;
  inner: string;
};

function encodeOperatorCursor(
  kind: OperatorCursorKind,
  scopeId: string,
  resourceId: string,
  inner: string,
): string {
  const encoded = `crt-op1:${encodeURIComponent(
    JSON.stringify({ version: 1, kind, scopeId, resourceId, inner }),
  )}`;
  invariant(
    new TextEncoder().encode(encoded).byteLength <= MAX_CURSOR_BYTES,
    "LIMIT_EXCEEDED",
    `Cursor exceeds ${MAX_CURSOR_BYTES} bytes`,
  );
  return encoded;
}

function decodeOperatorCursor(
  encoded: string | undefined,
  kind: OperatorCursorKind,
  scopeId: string,
  resourceId: string,
): OperatorCursor | null {
  if (encoded === undefined) return null;
  try {
    invariant(
      new TextEncoder().encode(encoded).byteLength <= MAX_CURSOR_BYTES,
      "INVALID_CURSOR",
      `Cursor exceeds ${MAX_CURSOR_BYTES} bytes`,
    );
    invariant(
      encoded.startsWith("crt-op1:"),
      "INVALID_CURSOR",
      "Unsupported operator cursor version",
    );
    const payload = JSON.parse(
      decodeURIComponent(encoded.slice(8)),
    ) as OperatorCursor;
    invariant(
      payload.version === 1 &&
        payload.kind === kind &&
        payload.scopeId === scopeId &&
        payload.resourceId === resourceId &&
        typeof payload.inner === "string",
      "INVALID_CURSOR",
      "Cursor does not belong to this scope or resource",
    );
    validateInnerCursor(payload.inner);
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "ConvexError") throw error;
    fail("INVALID_CURSOR", "Cursor is malformed");
  }
}

function isTerminalJob(state: Doc<"jobs">["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "superseded";
}

async function loadAllIndexes(
  ctx: Parameters<typeof loadIndexesForWrites>[0],
  scopeId: string,
  tableId: Id<"tables">,
): Promise<Doc<"indexDefinitions">[]> {
  const states = [
    "building",
    "verifying",
    "ready",
    "failed",
    "deleting",
  ] as const;
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
  generation: number,
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
    generation,
    batchCount: 0,
    retryCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function startIndexMaintenance(
  ctx: MutationCtx,
  index: Doc<"indexDefinitions">,
  kind: "repairIndex" | "verifyIndex",
  phase: "repairRecords" | "verifyRecords",
): Promise<{ jobId: Id<"jobs"> }> {
  if (
    index.activeJobId &&
    index.maintenanceState !== undefined &&
    index.maintenanceState !== "idle" &&
    index.maintenanceState !== "failed"
  ) {
    const active = await ctx.db.get("jobs", index.activeJobId);
    if (
      active &&
      active.kind === kind &&
      active.state !== "succeeded" &&
      active.state !== "failed" &&
      active.state !== "superseded"
    ) {
      return { jobId: index.activeJobId };
    }
  }
  invariant(
    index.state === "ready" ||
      index.state === "failed" ||
      index.state === "building",
    "INDEX_NOT_READY",
    "Index lifecycle state does not allow maintenance",
  );
  const generation = (index.generation ?? 0) + 1;
  const jobId = await createJob(
    ctx,
    index.scopeId,
    kind,
    index._id,
    phase,
    generation,
  );
  await ctx.db.patch("indexDefinitions", index._id, {
    generation,
    activeJobId: jobId,
    maintenanceState: kind === "repairIndex" ? "repairing" : "verifying",
    failure: null,
    updatedAt: Date.now(),
  });
  await scheduleJob(ctx, jobId, kind, generation, phase);
  return { jobId };
}

async function scheduleJob(
  ctx: MutationCtx,
  jobId: Id<"jobs">,
  kind: Doc<"jobs">["kind"],
  generation: number,
  phase: Doc<"jobs">["phase"],
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.jobRunner.process, {
    jobId,
    kind,
    generation,
    phase,
  });
}

async function readIdempotency(
  ctx: MutationCtx,
  args: { scopeId: string; tableId: Id<"tables">; idempotencyKey?: string },
  operation: "insert" | "upsert",
  hash: string,
): Promise<Array<{ recordId: Id<"records">; rev: number }> | null> {
  if (!args.idempotencyKey) return null;
  invariant(
    args.idempotencyKey.length <= 200,
    "VALIDATION_FAILED",
    "idempotencyKey is too long",
  );
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
    "IDEMPOTENCY_MISMATCH",
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
}

async function validateReferenceValues(
  ctx: MutationCtx,
  scopeId: string,
  fields: Doc<"fields">[],
  records: Array<Record<string, Scalar>>,
): Promise<void> {
  const references = new Map<
    string,
    { fieldId: Id<"fields">; targetTableId: Id<"tables">; value: string }
  >();
  for (const field of fields) {
    const targetTableId = field.constraints.referenceTableId;
    if (field.type !== "reference" || !targetTableId) continue;
    ensureActiveTable(
      ensureScope(
        await ctx.db.get("tables", targetTableId),
        scopeId,
        "Reference target table",
      ),
    );
    for (const record of records) {
      const value = record[field._id];
      if (typeof value === "string") {
        references.set(`${targetTableId}:${value}`, {
          fieldId: field._id,
          targetTableId,
          value,
        });
      }
    }
  }
  invariant(
    references.size <= 1_000,
    "LIMIT_EXCEEDED",
    "A batch may validate at most 1,000 distinct references",
  );
  for (const reference of references.values()) {
    const recordId = ctx.db.normalizeId("records", reference.value);
    const target = recordId ? await ctx.db.get("records", recordId) : null;
    invariant(
      target &&
        target.scopeId === scopeId &&
        target.tableId === reference.targetTableId,
      "VALIDATION_FAILED",
      "Reference target does not exist in the configured table",
      { fieldId: reference.fieldId },
    );
  }
}

function validateBatch(records: readonly unknown[]): void {
  invariant(
    records.length >= 1 && records.length <= MAX_BATCH_ITEMS,
    "LIMIT_EXCEEDED",
    `Batches require 1 to ${MAX_BATCH_ITEMS} records`,
  );
  const bytes = new TextEncoder().encode(JSON.stringify(records)).byteLength;
  invariant(
    bytes <= MAX_BATCH_BYTES,
    "LIMIT_EXCEEDED",
    "Batch exceeds the byte safety budget",
    { bytes },
  );
}

function assertSchemaRev(table: Doc<"tables">, expected: number): void {
  if (table.schemaRev !== expected) {
    fail("CONFLICT", "Table schema revision changed", {
      currentRev: table.schemaRev,
    });
  }
}

function assertRecordRev(record: Doc<"records">, expected: number): void {
  if (record.rev !== expected) {
    fail("CONFLICT", "Record revision changed", {
      currentRev: record.rev,
      recordId: record._id,
    });
  }
}

function validateRecordDocument(
  scopeId: string,
  tableId: Id<"tables">,
  values: Record<string, Scalar>,
  rev: number,
  createdAt: number,
  updatedAt: number,
): void {
  validateStoredDocumentSize(
    { scopeId, tableId, values, rev, createdAt, updatedAt },
    "Record",
  );
}

function validateName(value: string, label: string): void {
  invariant(
    value.length >= 1 && value.length <= 200,
    "VALIDATION_FAILED",
    `${label} must contain 1 to 200 characters`,
  );
}

function validateIndexName(value: string): void {
  invariant(
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value),
    "VALIDATION_FAILED",
    "Index names must start with a letter and contain only letters, digits, underscores, and hyphens",
  );
}
