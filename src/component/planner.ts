import { paginator } from "convex-helpers/server/pagination";
import type {
  GenericDocument,
  GenericIndexFields,
  IndexRangeBuilder,
  IndexRange,
} from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import { loadFields, loadTable } from "./data.js";
import { fail, invariant } from "./errors.js";
import {
  compareScalar,
  normalizeScalar,
  requestHash,
  type Scalar,
} from "./normalization.js";
import schema from "./schema.js";
import { SCAN_LIMIT, ensureActiveTable, validateValue } from "./validation.js";

export type Predicate = {
  fieldId: Id<"fields">;
  op: "eq" | "lt" | "lte" | "gt" | "gte";
  value: Scalar;
};

export type QuerySpec = {
  where: Predicate[];
  orderBy?: {
    fieldIds: Id<"fields">[];
    direction: "asc" | "desc";
  };
};

export type Pagination = {
  pageSize: number;
  cursor?: string;
  endCursor?: string;
  maximumRowsRead?: number;
  maximumBytesRead?: number;
};

export type QueryPlan =
  | { kind: "index"; indexId: Id<"indexDefinitions">; postFiltered: boolean }
  | { kind: "scan"; postFiltered: boolean }
  | { kind: "indexRequired"; suggestedIndex: Id<"fields">[] };

type SelectedIndex = {
  definition: Doc<"indexDefinitions">;
  equalityValues: Scalar[];
  range?: RangeBounds;
  postFiltered: boolean;
};

type RangeBound = { value: Scalar; inclusive: boolean };
type RangeBounds = { lower?: RangeBound; upper?: RangeBound };

type IndexCursor = {
  version: 1;
  kind: "index";
  scopeId: string;
  indexId: string;
  queryHash: string;
  direction: "asc" | "desc";
  inner: string | null;
};

type ScanCursor = {
  version: 1;
  kind: "scan";
  scopeId: string;
  tableId: string;
  queryHash: string;
  direction: "asc" | "desc";
  boundaryValues: Scalar[];
  recordId: string;
};

type CursorPayload = IndexCursor | ScanCursor;

export async function explain(
  ctx: QueryCtx,
  scopeId: string,
  tableId: Id<"tables">,
  query: QuerySpec,
): Promise<QueryPlan> {
  const table = await loadTable(ctx, scopeId, tableId);
  ensureActiveTable(table);
  const fields = await validateQuery(ctx, scopeId, tableId, query);
  const selected = await selectIndex(ctx, scopeId, tableId, query);
  if (selected) {
    return {
      kind: "index",
      indexId: selected.definition._id,
      postFiltered: selected.postFiltered,
    };
  }
  const rows = await ctx.db
    .query("records")
    .withIndex("by_scopeId_and_tableId", (q) =>
      q.eq("scopeId", scopeId).eq("tableId", tableId),
    )
    .take(SCAN_LIMIT + 1);
  if (rows.length <= SCAN_LIMIT) return { kind: "scan", postFiltered: false };
  return { kind: "indexRequired", suggestedIndex: suggestIndex(query, fields) };
}

export async function queryRecords(
  ctx: QueryCtx,
  scopeId: string,
  tableId: Id<"tables">,
  query: QuerySpec,
  pagination: Pagination,
): Promise<{
  page: Doc<"records">[];
  isDone: boolean;
  continueCursor: string | null;
  plan: Exclude<QueryPlan, { kind: "indexRequired" }>;
}> {
  invariant(
    Number.isInteger(pagination.pageSize) &&
      pagination.pageSize >= 1 &&
      pagination.pageSize <= 100,
    "VALIDATION_FAILED",
    "pageSize must be an integer between 1 and 100",
  );
  const table = await loadTable(ctx, scopeId, tableId);
  ensureActiveTable(table);
  const fields = await validateQuery(ctx, scopeId, tableId, query);
  const selected = await selectIndex(ctx, scopeId, tableId, query);
  if (selected)
    return await indexedPage(
      ctx,
      scopeId,
      tableId,
      query,
      pagination,
      selected,
    );
  return await scannedPage(ctx, scopeId, tableId, query, pagination, fields);
}

async function validateQuery(
  ctx: QueryCtx,
  scopeId: string,
  tableId: Id<"tables">,
  query: QuerySpec,
): Promise<Doc<"fields">[]> {
  invariant(
    query.where.length <= 16,
    "LIMIT_EXCEEDED",
    "Queries allow at most 16 predicates",
  );
  const fields = (await loadFields(ctx, scopeId, tableId)).filter(
    (field) => field.state === "active",
  );
  const byId = new Map(fields.map((field) => [field._id as string, field]));
  for (const predicate of query.where) {
    const field = byId.get(predicate.fieldId as string);
    invariant(
      field,
      "VALIDATION_FAILED",
      `Unknown field: ${predicate.fieldId}`,
    );
    validateValue(field, normalizeScalar(predicate.value));
  }
  if (query.orderBy) {
    invariant(
      query.orderBy.fieldIds.length >= 1 && query.orderBy.fieldIds.length <= 3,
      "VALIDATION_FAILED",
      "orderBy requires one to three fields",
    );
    const seen = new Set<string>();
    for (const fieldId of query.orderBy.fieldIds) {
      invariant(
        byId.has(fieldId as string),
        "VALIDATION_FAILED",
        `Unknown order field: ${fieldId}`,
      );
      invariant(
        !seen.has(fieldId),
        "VALIDATION_FAILED",
        "Order fields must be unique",
      );
      seen.add(fieldId);
    }
  }
  return fields;
}

async function selectIndex(
  ctx: QueryCtx,
  scopeId: string,
  tableId: Id<"tables">,
  query: QuerySpec,
): Promise<SelectedIndex | null> {
  const indexes = await ctx.db
    .query("indexDefinitions")
    .withIndex("by_scopeId_and_tableId_and_state", (q) =>
      q.eq("scopeId", scopeId).eq("tableId", tableId).eq("state", "ready"),
    )
    .take(5);
  const equality = new Map<string, Scalar>();
  const rangeFields = new Set<string>();
  for (const predicate of query.where) {
    if (predicate.op === "eq")
      equality.set(predicate.fieldId, normalizeScalar(predicate.value));
    else rangeFields.add(predicate.fieldId);
  }
  if (rangeFields.size > 1) return null;

  const candidates: Array<SelectedIndex & { score: number }> = [];
  for (const index of indexes) {
    const equalityValues: Scalar[] = [];
    for (const fieldId of index.fieldIds) {
      if (!equality.has(fieldId)) break;
      equalityValues.push(equality.get(fieldId) ?? null);
    }
    const rangeField = [...rangeFields][0];
    const nextField = index.fieldIds[equalityValues.length] as
      string | undefined;
    if (rangeField && nextField !== rangeField) continue;
    if (query.orderBy) {
      const remaining = index.fieldIds.slice(equalityValues.length);
      const fullMatch = sameIds(query.orderBy.fieldIds, index.fieldIds);
      const remainingMatch = sameIds(query.orderBy.fieldIds, remaining);
      if (!fullMatch && !remainingMatch) continue;
    }
    if (!query.orderBy && equalityValues.length === 0 && !rangeField) continue;
    const range = rangeField ? boundsFor(query.where, rangeField) : undefined;
    const covered = new Set<string>(
      index.fieldIds.slice(0, equalityValues.length),
    );
    if (rangeField) covered.add(rangeField);
    const postFiltered = query.where.some(
      (predicate) => !covered.has(predicate.fieldId),
    );
    candidates.push({
      definition: index,
      equalityValues,
      range,
      postFiltered,
      score:
        equalityValues.length * 10 + (range ? 5 : 0) - (postFiltered ? 1 : 0),
    });
  }
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.definition.name.localeCompare(right.definition.name),
  );
  return candidates[0] ?? null;
}

function boundsFor(predicates: Predicate[], fieldId: string): RangeBounds {
  const result: RangeBounds = {};
  for (const predicate of predicates) {
    if (predicate.fieldId !== fieldId || predicate.op === "eq") continue;
    const value = normalizeScalar(predicate.value);
    if (predicate.op === "gt" || predicate.op === "gte") {
      const candidate = { value, inclusive: predicate.op === "gte" };
      if (
        !result.lower ||
        compareScalar(candidate.value, result.lower.value) > 0
      )
        result.lower = candidate;
    } else {
      const candidate = { value, inclusive: predicate.op === "lte" };
      if (
        !result.upper ||
        compareScalar(candidate.value, result.upper.value) < 0
      )
        result.upper = candidate;
    }
  }
  return result;
}

async function indexedPage(
  ctx: QueryCtx,
  scopeId: string,
  tableId: Id<"tables">,
  query: QuerySpec,
  pagination: Pagination,
  selected: SelectedIndex,
) {
  const direction = query.orderBy?.direction ?? "asc";
  const hash = requestHash(query);
  const cursor = pagination.cursor
    ? decodeCursor(
        pagination.cursor,
        "index",
        scopeId,
        selected.definition._id,
        hash,
        direction,
      )
    : null;
  const endCursor = pagination.endCursor
    ? decodeCursor(
        pagination.endCursor,
        "index",
        scopeId,
        selected.definition._id,
        hash,
        direction,
      )
    : null;
  const stream = buildEntryQuery(ctx, selected).order(direction);
  const result = await stream.paginate({
    numItems: pagination.pageSize,
    cursor: cursor?.inner ?? null,
    ...(endCursor ? { endCursor: endCursor.inner } : {}),
    maximumRowsRead: Math.min(pagination.maximumRowsRead ?? 500, 1_000),
    maximumBytesRead: Math.min(
      pagination.maximumBytesRead ?? 4_000_000,
      4_000_000,
    ),
  });
  const hydrated = await Promise.all(
    result.page.map((entry) => ctx.db.get("records", entry.recordId)),
  );
  const page = hydrated.filter(
    (record): record is Doc<"records"> =>
      record !== null &&
      record.scopeId === scopeId &&
      record.tableId === tableId &&
      matchesAll(record, query.where),
  );
  return {
    page,
    isDone: result.isDone,
    continueCursor: result.isDone
      ? null
      : encodeCursor({
          version: 1,
          kind: "index",
          scopeId,
          indexId: selected.definition._id,
          queryHash: hash,
          direction,
          inner: result.continueCursor,
        }),
    plan: {
      kind: "index" as const,
      indexId: selected.definition._id,
      postFiltered: selected.postFiltered,
    },
  };
}

function buildEntryQuery(ctx: QueryCtx, selected: SelectedIndex) {
  const start = paginator(ctx.db, schema).query("indexEntries");
  const indexName =
    "by_scopeId_and_indexId_and_k0_and_k1_and_k2_and_recordId" as const;
  const scopeId = selected.definition.scopeId;
  const indexId = selected.definition._id;
  const eq = selected.equalityValues;
  if (eq.length === 0) {
    return start.withIndex(indexName, (q) =>
      addBounds(
        q.eq("scopeId", scopeId).eq("indexId", indexId),
        "k0",
        selected.range,
      ),
    );
  }
  if (eq.length === 1) {
    return start.withIndex(indexName, (q) =>
      addBounds(
        q
          .eq("scopeId", scopeId)
          .eq("indexId", indexId)
          .eq("k0", eq[0] ?? null),
        "k1",
        selected.range,
      ),
    );
  }
  if (eq.length === 2) {
    return start.withIndex(indexName, (q) =>
      addBounds(
        q
          .eq("scopeId", scopeId)
          .eq("indexId", indexId)
          .eq("k0", eq[0] ?? null)
          .eq("k1", eq[1] ?? null),
        "k2",
        selected.range,
      ),
    );
  }
  return start.withIndex(indexName, (q) =>
    q
      .eq("scopeId", scopeId)
      .eq("indexId", indexId)
      .eq("k0", eq[0] ?? null)
      .eq("k1", eq[1] ?? null)
      .eq("k2", eq[2] ?? null),
  );
}

function addBounds<
  Document extends GenericDocument,
  IndexFields extends GenericIndexFields,
  FieldNum extends number,
>(
  builder: IndexRangeBuilder<Document, IndexFields, FieldNum>,
  field: IndexFields[FieldNum],
  bounds?: RangeBounds,
): IndexRange {
  if (!bounds) return builder;
  const lowerValue = bounds.lower?.value as Parameters<typeof builder.gte>[1];
  const upperValue = bounds.upper?.value as Parameters<typeof builder.lte>[1];
  if (bounds.lower && bounds.upper) {
    const lower = bounds.lower.inclusive
      ? builder.gte(field, lowerValue)
      : builder.gt(field, lowerValue);
    return bounds.upper.inclusive
      ? lower.lte(field, upperValue)
      : lower.lt(field, upperValue);
  }
  if (bounds.lower) {
    return bounds.lower.inclusive
      ? builder.gte(field, lowerValue)
      : builder.gt(field, lowerValue);
  }
  return bounds.upper!.inclusive
    ? builder.lte(field, upperValue)
    : builder.lt(field, upperValue);
}

async function scannedPage(
  ctx: QueryCtx,
  scopeId: string,
  tableId: Id<"tables">,
  query: QuerySpec,
  pagination: Pagination,
  fields: Doc<"fields">[],
) {
  const records = await ctx.db
    .query("records")
    .withIndex("by_scopeId_and_tableId", (q) =>
      q.eq("scopeId", scopeId).eq("tableId", tableId),
    )
    .take(SCAN_LIMIT + 1);
  if (records.length > SCAN_LIMIT) {
    const suggestedIndex = suggestIndex(query, fields);
    fail("INDEX_REQUIRED", "This query requires a runtime index", {
      suggestedIndex: JSON.stringify(suggestedIndex),
    });
  }
  const direction = query.orderBy?.direction ?? "asc";
  const orderFields = query.orderBy?.fieldIds ?? [];
  const hash = requestHash(query);
  const cursor = pagination.cursor
    ? decodeCursor(pagination.cursor, "scan", scopeId, tableId, hash, direction)
    : null;
  const filtered = records.filter((record) => matchesAll(record, query.where));
  filtered.sort((left, right) =>
    compareRecords(left, right, orderFields, direction),
  );
  const afterCursor = cursor
    ? filtered.filter(
        (record) =>
          compareBoundary(
            record,
            orderFields,
            cursor.boundaryValues,
            cursor.recordId,
            direction,
          ) > 0,
      )
    : filtered;
  const page = afterCursor.slice(0, pagination.pageSize);
  const isDone = afterCursor.length <= pagination.pageSize;
  const last = page.at(-1);
  return {
    page,
    isDone,
    continueCursor:
      isDone || !last
        ? null
        : encodeCursor({
            version: 1,
            kind: "scan",
            scopeId,
            tableId,
            queryHash: hash,
            direction,
            boundaryValues: orderFields.map(
              (fieldId) => last.values[fieldId] ?? null,
            ),
            recordId: last._id,
          }),
    plan: { kind: "scan" as const, postFiltered: false },
  };
}

function matchesAll(record: Doc<"records">, predicates: Predicate[]): boolean {
  return predicates.every((predicate) => {
    const actual = (record.values[predicate.fieldId] ?? null) as Scalar;
    const comparison = compareScalar(actual, normalizeScalar(predicate.value));
    switch (predicate.op) {
      case "eq":
        return comparison === 0;
      case "lt":
        return comparison < 0;
      case "lte":
        return comparison <= 0;
      case "gt":
        return comparison > 0;
      case "gte":
        return comparison >= 0;
    }
  });
}

function compareRecords(
  left: Doc<"records">,
  right: Doc<"records">,
  fieldIds: Id<"fields">[],
  direction: "asc" | "desc",
): number {
  const factor = direction === "asc" ? 1 : -1;
  for (const fieldId of fieldIds) {
    const comparison = compareScalar(
      (left.values[fieldId] ?? null) as Scalar,
      (right.values[fieldId] ?? null) as Scalar,
    );
    if (comparison !== 0) return comparison * factor;
  }
  return left._id < right._id ? -factor : left._id > right._id ? factor : 0;
}

function compareBoundary(
  record: Doc<"records">,
  fieldIds: Id<"fields">[],
  values: Scalar[],
  recordId: string,
  direction: "asc" | "desc",
): number {
  const factor = direction === "asc" ? 1 : -1;
  for (let index = 0; index < fieldIds.length; index += 1) {
    const comparison = compareScalar(
      (record.values[fieldIds[index]!] ?? null) as Scalar,
      values[index] ?? null,
    );
    if (comparison !== 0) return comparison * factor;
  }
  return record._id < recordId ? -factor : record._id > recordId ? factor : 0;
}

function suggestIndex(
  query: QuerySpec,
  fields: Doc<"fields">[],
): Id<"fields">[] {
  const valid = new Set(fields.map((field) => field._id));
  const equality = query.where
    .filter(
      (predicate) => predicate.op === "eq" && valid.has(predicate.fieldId),
    )
    .map((predicate) => predicate.fieldId)
    .sort();
  const ranges = query.where
    .filter(
      (predicate) => predicate.op !== "eq" && valid.has(predicate.fieldId),
    )
    .map((predicate) => predicate.fieldId)
    .sort();
  const combined = [...equality, ...ranges, ...(query.orderBy?.fieldIds ?? [])];
  return [...new Set(combined)].slice(0, 3);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function encodeCursor(payload: CursorPayload): string {
  return `crt1:${encodeURIComponent(JSON.stringify(payload))}`;
}

function decodeCursor(
  encoded: string,
  kind: "index",
  scopeId: string,
  resourceId: string,
  hash: string,
  direction: "asc" | "desc",
): IndexCursor;
function decodeCursor(
  encoded: string,
  kind: "scan",
  scopeId: string,
  resourceId: string,
  hash: string,
  direction: "asc" | "desc",
): ScanCursor;
function decodeCursor(
  encoded: string,
  kind: "index" | "scan",
  scopeId: string,
  resourceId: string,
  hash: string,
  direction: "asc" | "desc",
): CursorPayload {
  try {
    invariant(
      encoded.startsWith("crt1:"),
      "INVALID_CURSOR",
      "Unsupported cursor version",
    );
    const payload = JSON.parse(
      decodeURIComponent(encoded.slice(5)),
    ) as CursorPayload;
    const matchesResource =
      (payload.kind === "index" && payload.indexId === resourceId) ||
      (payload.kind === "scan" && payload.tableId === resourceId);
    invariant(
      payload.version === 1 &&
        payload.kind === kind &&
        payload.scopeId === scopeId &&
        payload.queryHash === hash &&
        payload.direction === direction &&
        matchesResource,
      "INVALID_CURSOR",
      "Cursor does not belong to this scope or query",
    );
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "ConvexError") throw error;
    fail("INVALID_CURSOR", "Cursor is malformed");
  }
}
