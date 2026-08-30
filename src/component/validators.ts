import { v } from "convex/values";

export const scalarValidator = v.union(v.null(), v.boolean(), v.number(), v.string());
export const fieldTypeValidator = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("boolean"),
  v.literal("timestamp"),
  v.literal("select"),
  v.literal("reference"),
);
export const fieldStateValidator = v.union(v.literal("active"), v.literal("deleting"));
export const indexStateValidator = v.union(
  v.literal("building"),
  v.literal("verifying"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("deleting"),
);
export const jobKindValidator = v.union(
  v.literal("buildIndex"),
  v.literal("deleteIndex"),
  v.literal("deleteTable"),
);
export const jobStateValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
);
export const jobPhaseValidator = v.union(
  v.literal("backfill"),
  v.literal("verifyRecords"),
  v.literal("verifyEntries"),
  v.literal("deleteEntries"),
  v.literal("deleteRecords"),
  v.literal("deleteFields"),
  v.literal("deleteMetadata"),
  v.literal("done"),
);
export const selectOptionValidator = v.object({ code: v.string(), label: v.string() });
export const fieldConstraintsValidator = v.object({
  min: v.optional(v.number()),
  max: v.optional(v.number()),
  maxLength: v.optional(v.number()),
  selectOptions: v.optional(v.array(selectOptionValidator)),
  referenceTableId: v.optional(v.id("tables")),
});
export const fieldInputValidator = v.object({
  key: v.string(),
  name: v.string(),
  type: fieldTypeValidator,
  required: v.boolean(),
  constraints: v.optional(fieldConstraintsValidator),
});
export const recordValuesValidator = v.record(v.string(), scalarValidator);
export const predicateValidator = v.object({
  fieldId: v.id("fields"),
  op: v.union(
    v.literal("eq"),
    v.literal("lt"),
    v.literal("lte"),
    v.literal("gt"),
    v.literal("gte"),
  ),
  value: scalarValidator,
});
export const querySpecValidator = v.object({
  where: v.array(predicateValidator),
  orderBy: v.optional(
    v.object({
      fieldIds: v.array(v.id("fields")),
      direction: v.union(v.literal("asc"), v.literal("desc")),
    }),
  ),
});
export const paginationValidator = v.object({
  pageSize: v.number(),
  cursor: v.optional(v.string()),
  endCursor: v.optional(v.string()),
  maximumRowsRead: v.optional(v.number()),
  maximumBytesRead: v.optional(v.number()),
});
