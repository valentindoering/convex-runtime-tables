import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  fieldStateValidator,
  fieldTypeValidator,
  indexStateValidator,
  jobKindValidator,
  jobPhaseValidator,
  jobStateValidator,
  maintenanceStateValidator,
  scalarValidator,
  storedFieldConstraintsValidator,
} from "./validators.js";

export default defineSchema({
  tables: defineTable({
    scopeId: v.string(),
    slug: v.string(),
    name: v.string(),
    state: v.union(v.literal("active"), v.literal("deleting")),
    schemaRev: v.number(),
    generation: v.optional(v.number()),
    activeJobId: v.optional(v.id("jobs")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_scopeId_and_slug", ["scopeId", "slug"]),

  fields: defineTable({
    scopeId: v.string(),
    tableId: v.id("tables"),
    key: v.string(),
    name: v.string(),
    type: fieldTypeValidator,
    required: v.boolean(),
    constraints: storedFieldConstraintsValidator,
    state: fieldStateValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scopeId_and_tableId_and_key", ["scopeId", "tableId", "key"])
    .index("by_scopeId_and_tableId_and_state", ["scopeId", "tableId", "state"]),

  records: defineTable({
    scopeId: v.string(),
    tableId: v.id("tables"),
    values: v.record(v.string(), scalarValidator),
    rev: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_scopeId_and_tableId", ["scopeId", "tableId"]),

  indexDefinitions: defineTable({
    scopeId: v.string(),
    tableId: v.id("tables"),
    name: v.string(),
    fieldIds: v.array(v.id("fields")),
    unique: v.boolean(),
    state: indexStateValidator,
    maintenanceState: v.optional(maintenanceStateValidator),
    generation: v.optional(v.number()),
    activeJobId: v.optional(v.id("jobs")),
    verification: v.optional(
      v.object({
        missing: v.number(),
        orphaned: v.number(),
        stale: v.number(),
        duplicate: v.number(),
        missingSamples: v.array(v.string()),
        orphanedSamples: v.array(v.string()),
        staleSamples: v.array(v.string()),
        duplicateSamples: v.array(v.string()),
        checkedAt: v.number(),
      }),
    ),
    failure: v.union(
      v.null(),
      v.object({
        code: v.string(),
        message: v.string(),
        samples: v.array(v.string()),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scopeId_and_tableId_and_name", ["scopeId", "tableId", "name"])
    .index("by_scopeId_and_tableId_and_state", ["scopeId", "tableId", "state"]),

  indexEntries: defineTable({
    scopeId: v.string(),
    indexId: v.id("indexDefinitions"),
    recordId: v.id("records"),
    k0: scalarValidator,
    k1: scalarValidator,
    k2: scalarValidator,
    recordRev: v.number(),
  })
    .index("by_scopeId_and_indexId_and_k0_and_k1_and_k2_and_recordId", [
      "scopeId",
      "indexId",
      "k0",
      "k1",
      "k2",
      "recordId",
    ])
    .index("by_scopeId_and_indexId_and_recordId", [
      "scopeId",
      "indexId",
      "recordId",
    ])
    .index("by_scopeId_and_recordId_and_indexId", [
      "scopeId",
      "recordId",
      "indexId",
    ]),

  idempotencyKeys: defineTable({
    scopeId: v.string(),
    tableId: v.id("tables"),
    operation: v.union(v.literal("insert"), v.literal("upsert")),
    key: v.string(),
    requestHash: v.string(),
    resultSummary: v.array(
      v.object({ recordId: v.id("records"), rev: v.number() }),
    ),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_scopeId_and_tableId_and_operation_and_key", [
      "scopeId",
      "tableId",
      "operation",
      "key",
    ])
    .index("by_scopeId_and_expiresAt", ["scopeId", "expiresAt"])
    .index("by_expiresAt", ["expiresAt"]),

  jobs: defineTable({
    scopeId: v.string(),
    kind: jobKindValidator,
    targetId: v.string(),
    state: jobStateValidator,
    phase: jobPhaseValidator,
    cursor: v.union(v.null(), v.string()),
    progress: v.number(),
    generation: v.optional(v.number()),
    batchCount: v.optional(v.number()),
    retryCount: v.optional(v.number()),
    // Kept for alpha-schema migration. New jobs use batchCount/retryCount.
    attempts: v.optional(v.number()),
    verification: v.optional(
      v.object({
        missing: v.number(),
        orphaned: v.number(),
        stale: v.number(),
        duplicate: v.number(),
        missingSamples: v.array(v.string()),
        orphanedSamples: v.array(v.string()),
        staleSamples: v.array(v.string()),
        duplicateSamples: v.array(v.string()),
      }),
    ),
    lastError: v.union(
      v.null(),
      v.object({ code: v.string(), message: v.string() }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    retentionExpiresAt: v.optional(v.number()),
  })
    .index("by_scopeId_and_state", ["scopeId", "state"])
    .index("by_scopeId_and_targetId", ["scopeId", "targetId"])
    .index("by_scopeId_and_retentionExpiresAt", [
      "scopeId",
      "retentionExpiresAt",
    ])
    .index("by_retentionExpiresAt", ["retentionExpiresAt"]),
});
