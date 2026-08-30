export const runtimeTablesAgentOperations = [
  "listTables",
  "getTable",
  "queryRecords",
  "explainQuery",
  "insertRecords",
  "patchRecord",
  "upsertRecords",
  "deleteRecord",
  "createIndex",
  "repairIndex",
  "verifyIndex",
  "getJob",
] as const;

export type RuntimeTablesAgentOperation =
  (typeof runtimeTablesAgentOperations)[number];

export type RuntimeTablesAgentRequest = {
  version: 1;
  operation: RuntimeTablesAgentOperation;
  arguments: Record<string, unknown>;
};

export type RuntimeTablesAgentHandlers = {
  [Operation in RuntimeTablesAgentOperation]: (
    arguments_: Record<string, unknown>,
  ) => Promise<unknown>;
};

export type RuntimeTablesAgentErrorCode =
  "INVALID_REQUEST" | "UNKNOWN_OPERATION" | "PAYLOAD_TOO_LARGE";

export class RuntimeTablesAgentError extends Error {
  constructor(
    public readonly code: RuntimeTablesAgentErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "RuntimeTablesAgentError";
  }
}

const argumentShapes: Record<
  RuntimeTablesAgentOperation,
  { required: readonly string[]; allowed: readonly string[] }
> = {
  listTables: {
    required: ["scopeId", "pagination"],
    allowed: ["scopeId", "pagination"],
  },
  getTable: {
    required: ["scopeId", "tableId"],
    allowed: ["scopeId", "tableId"],
  },
  queryRecords: {
    required: ["scopeId", "tableId", "query", "pagination"],
    allowed: ["scopeId", "tableId", "query", "pagination"],
  },
  explainQuery: {
    required: ["scopeId", "tableId", "query"],
    allowed: ["scopeId", "tableId", "query"],
  },
  insertRecords: {
    required: ["scopeId", "tableId", "records"],
    allowed: ["scopeId", "tableId", "records", "idempotencyKey"],
  },
  patchRecord: {
    required: ["scopeId", "tableId", "recordId", "patch", "expectedRev"],
    allowed: ["scopeId", "tableId", "recordId", "patch", "expectedRev"],
  },
  upsertRecords: {
    required: ["scopeId", "tableId", "uniqueIndexId", "records"],
    allowed: [
      "scopeId",
      "tableId",
      "uniqueIndexId",
      "records",
      "idempotencyKey",
    ],
  },
  deleteRecord: {
    required: ["scopeId", "tableId", "recordId"],
    allowed: ["scopeId", "tableId", "recordId", "expectedRev"],
  },
  createIndex: {
    required: ["scopeId", "tableId", "name", "fieldIds", "unique"],
    allowed: ["scopeId", "tableId", "name", "fieldIds", "unique"],
  },
  repairIndex: {
    required: ["scopeId", "indexId"],
    allowed: ["scopeId", "indexId"],
  },
  verifyIndex: {
    required: ["scopeId", "indexId"],
    allowed: ["scopeId", "indexId"],
  },
  getJob: {
    required: ["scopeId", "jobId"],
    allowed: ["scopeId", "jobId"],
  },
};

const argumentPropertySchemas = {
  scopeId: { type: "string", minLength: 1, maxLength: 200 },
  tableId: { type: "string", minLength: 1 },
  recordId: { type: "string", minLength: 1 },
  indexId: { type: "string", minLength: 1 },
  uniqueIndexId: { type: "string", minLength: 1 },
  jobId: { type: "string", minLength: 1 },
  idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
  name: { type: "string", minLength: 1, maxLength: 200 },
  unique: { type: "boolean" },
  expectedRev: { type: "number" },
  records: { type: "array", minItems: 1, maxItems: 100 },
  fieldIds: {
    type: "array",
    minItems: 1,
    maxItems: 3,
    items: { type: "string", minLength: 1 },
  },
  query: { type: "object" },
  pagination: { type: "object" },
  patch: { type: "object" },
} as const;

export const runtimeTablesAgentOperationSchemasV1 =
  runtimeTablesAgentOperations.map((operation) => {
    const shape = argumentShapes[operation];
    return {
      type: "object",
      required: ["version", "operation", "arguments"],
      additionalProperties: false,
      properties: {
        version: { const: 1 },
        operation: { const: operation },
        arguments: {
          type: "object",
          required: shape.required,
          additionalProperties: false,
          properties: Object.fromEntries(
            shape.allowed.map((key) => [
              key,
              argumentPropertySchemas[
                key as keyof typeof argumentPropertySchemas
              ],
            ]),
          ),
        },
      },
    };
  });

export const runtimeTablesAgentRequestSchemaV1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/valentindoering/convex-runtime-tables/schemas/agent-request-v1.json",
  title: "Convex Runtime Tables agent request v1",
  type: "object",
  additionalProperties: false,
  required: ["version", "operation", "arguments"],
  properties: {
    version: { const: 1 },
    operation: { enum: runtimeTablesAgentOperations },
    arguments: { type: "object" },
  },
  oneOf: runtimeTablesAgentOperationSchemasV1,
} as const;

export const runtimeTablesAgentSchemas = {
  v1: runtimeTablesAgentRequestSchemaV1,
} as const;

export function createRuntimeTablesAgentDispatcher(
  handlers: RuntimeTablesAgentHandlers,
): (request: unknown) => Promise<unknown> {
  return async (request) => {
    const parsed = validateRequest(request);
    const handler = Object.hasOwn(handlers, parsed.operation)
      ? handlers[parsed.operation]
      : undefined;
    if (typeof handler !== "function") {
      throw new RuntimeTablesAgentError(
        "UNKNOWN_OPERATION",
        `No handler is registered for ${parsed.operation}`,
      );
    }
    return await handler(parsed.arguments);
  };
}

function validateRequest(value: unknown): RuntimeTablesAgentRequest {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new RuntimeTablesAgentError(
      "INVALID_REQUEST",
      "Request must be JSON serializable",
    );
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > 64_000) {
    throw new RuntimeTablesAgentError(
      "PAYLOAD_TOO_LARGE",
      "Agent request exceeds 64 KB",
      { bytes },
    );
  }
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RuntimeTablesAgentError(
      "INVALID_REQUEST",
      "Request must be a plain object",
    );
  }
  assertExactKeys(value, ["version", "operation", "arguments"], "request");
  if (value.version !== 1) {
    throw new RuntimeTablesAgentError(
      "INVALID_REQUEST",
      "version must equal 1",
    );
  }
  if (typeof value.operation !== "string" || !isOperation(value.operation)) {
    throw new RuntimeTablesAgentError(
      "UNKNOWN_OPERATION",
      "operation must be a supported operation",
    );
  }
  if (
    !isObject(value.arguments) ||
    Object.getPrototypeOf(value.arguments) !== Object.prototype
  ) {
    throw new RuntimeTablesAgentError(
      "INVALID_REQUEST",
      "arguments must be a plain object",
    );
  }
  const shape = argumentShapes[value.operation];
  assertExactKeys(
    value.arguments,
    shape.allowed,
    `${value.operation}.arguments`,
  );
  for (const key of shape.required) {
    if (!Object.hasOwn(value.arguments, key)) {
      throw new RuntimeTablesAgentError(
        "INVALID_REQUEST",
        `Missing required argument: ${key}`,
      );
    }
  }
  validateCommonTypes(value.operation, value.arguments);
  return value as RuntimeTablesAgentRequest;
}

function validateCommonTypes(
  operation: RuntimeTablesAgentOperation,
  args: Record<string, unknown>,
): void {
  for (const key of [
    "scopeId",
    "tableId",
    "recordId",
    "indexId",
    "uniqueIndexId",
    "jobId",
  ] as const) {
    if (Object.hasOwn(args, key)) {
      const value = args[key];
      if (typeof value !== "string" || value.length === 0) {
        throw new RuntimeTablesAgentError(
          "INVALID_REQUEST",
          `${key} must be a non-empty string`,
        );
      }
    }
  }
  if (Object.hasOwn(args, "idempotencyKey")) {
    const value = args.idempotencyKey;
    if (typeof value !== "string" || value.length < 1 || value.length > 200) {
      throw new RuntimeTablesAgentError(
        "INVALID_REQUEST",
        "idempotencyKey must contain 1 to 200 characters",
      );
    }
  }
  if (Object.hasOwn(args, "records")) {
    if (
      !Array.isArray(args.records) ||
      args.records.length < 1 ||
      args.records.length > 100 ||
      args.records.some(
        (record) =>
          !isPlainObject(record) ||
          Object.keys(record).some((key) => key !== "values") ||
          !Object.hasOwn(record, "values") ||
          !isPlainObject(record.values) ||
          Object.values(record.values).some((value) => !isScalar(value)),
      )
    ) {
      throw new RuntimeTablesAgentError(
        "INVALID_REQUEST",
        "records must contain 1 to 100 objects with a values object",
      );
    }
  }
  if (Object.hasOwn(args, "fieldIds")) {
    if (
      !Array.isArray(args.fieldIds) ||
      args.fieldIds.length < 1 ||
      args.fieldIds.length > 3 ||
      args.fieldIds.some((fieldId) => typeof fieldId !== "string")
    ) {
      throw new RuntimeTablesAgentError(
        "INVALID_REQUEST",
        "fieldIds must contain one to three strings",
      );
    }
  }
  if (operation === "createIndex") {
    if (typeof args.name !== "string" || typeof args.unique !== "boolean") {
      throw new RuntimeTablesAgentError(
        "INVALID_REQUEST",
        "createIndex requires string name and boolean unique",
      );
    }
  }
  if (
    Object.hasOwn(args, "expectedRev") &&
    typeof args.expectedRev !== "number"
  ) {
    throw new RuntimeTablesAgentError(
      "INVALID_REQUEST",
      "expectedRev must be a number",
    );
  }
  for (const key of ["query", "pagination", "patch"] as const) {
    if (Object.hasOwn(args, key) && !isPlainObject(args[key])) {
      throw new RuntimeTablesAgentError(
        "INVALID_REQUEST",
        `${key} must be an object`,
      );
    }
  }
  if (isPlainObject(args.pagination)) validatePagination(args.pagination);
  if (isPlainObject(args.query)) validateQuery(args.query);
  if (isPlainObject(args.patch)) validatePatch(args.patch);
}

function validatePagination(value: Record<string, unknown>): void {
  assertExactKeys(
    value,
    ["pageSize", "cursor", "endCursor", "maximumRowsRead", "maximumBytesRead"],
    "pagination",
  );
  if (!isPositiveInteger(value.pageSize))
    invalid("pageSize must be a positive integer");
  for (const key of ["maximumRowsRead", "maximumBytesRead"] as const) {
    if (Object.hasOwn(value, key) && !isPositiveInteger(value[key])) {
      invalid(`${key} must be a positive integer`);
    }
  }
  for (const key of ["cursor", "endCursor"] as const) {
    if (Object.hasOwn(value, key) && typeof value[key] !== "string") {
      invalid(`${key} must be a string`);
    }
  }
}

function validateQuery(value: Record<string, unknown>): void {
  assertExactKeys(value, ["where", "orderBy"], "query");
  if (!Array.isArray(value.where) || value.where.length > 16) {
    invalid("query.where must be an array with at most 16 predicates");
  }
  for (const predicate of value.where) {
    if (!isPlainObject(predicate)) invalid("Each predicate must be an object");
    assertExactKeys(predicate, ["fieldId", "op", "value"], "predicate");
    if (
      typeof predicate.fieldId !== "string" ||
      !["eq", "gt", "gte", "lt", "lte"].includes(String(predicate.op)) ||
      !isScalar(predicate.value)
    ) {
      invalid(
        "Each predicate requires a fieldId, supported op, and scalar value",
      );
    }
  }
  if (Object.hasOwn(value, "orderBy")) {
    if (!isPlainObject(value.orderBy)) invalid("orderBy must be an object");
    assertExactKeys(value.orderBy, ["fieldIds", "direction"], "orderBy");
    if (
      !Array.isArray(value.orderBy.fieldIds) ||
      value.orderBy.fieldIds.length < 1 ||
      value.orderBy.fieldIds.length > 3 ||
      value.orderBy.fieldIds.some((fieldId) => typeof fieldId !== "string") ||
      !["asc", "desc"].includes(String(value.orderBy.direction))
    ) {
      invalid(
        "orderBy requires one to three field IDs and asc or desc direction",
      );
    }
  }
}

function validatePatch(value: Record<string, unknown>): void {
  assertExactKeys(value, ["values", "unsetFieldIds"], "patch");
  if (
    !isPlainObject(value.values) ||
    Object.values(value.values).some((item) => !isScalar(item))
  ) {
    invalid("patch.values must be an object of scalar values");
  }
  if (
    Object.hasOwn(value, "unsetFieldIds") &&
    (!Array.isArray(value.unsetFieldIds) ||
      value.unsetFieldIds.some((fieldId) => typeof fieldId !== "string"))
  ) {
    invalid("unsetFieldIds must be an array of strings");
  }
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

function isScalar(value: unknown): value is null | string | number | boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function invalid(message: string): never {
  throw new RuntimeTablesAgentError("INVALID_REQUEST", message);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new RuntimeTablesAgentError(
        "INVALID_REQUEST",
        `Unexpected property in ${label}: ${key}`,
      );
    }
  }
}

function isOperation(value: string): value is RuntimeTablesAgentOperation {
  return (runtimeTablesAgentOperations as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}
