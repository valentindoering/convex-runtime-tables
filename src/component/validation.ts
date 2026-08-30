import type { Doc, Id } from "./_generated/dataModel.js";
import { getConvexSize } from "convex/values";
import { fail, invariant } from "./errors.js";
import { normalizeScalar, type Scalar } from "./normalization.js";

export const MAX_FIELDS = 200;
export const MAX_INDEXES = 4;
export const MAX_INDEX_FIELDS = 3;
export const MAX_BATCH_ITEMS = 100;
export const MAX_RECORD_BYTES = 700_000;
export const MAX_INDEXED_STRING_BYTES = 1_024;
export const MAX_INDEX_ENTRY_BYTES = 32_000;
export const MAX_CURSOR_BYTES = 8_192;
export const MAX_ROWS_READ = 1_000;
export const MAX_BYTES_READ = 4_000_000;
export const MAX_BATCH_BYTES = 1_500_000;
export const SCAN_LIMIT = 200;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type FieldInput = {
  key: string;
  name: string;
  type: Doc<"fields">["type"];
  required: boolean;
  constraints?: Partial<Doc<"fields">["constraints"]>;
};

export function validateScopeId(scopeId: string): void {
  invariant(
    scopeId.length >= 1 && scopeId.length <= 200,
    "VALIDATION_FAILED",
    "scopeId must contain 1 to 200 characters",
  );
}

export function validateSlug(slug: string): void {
  invariant(
    /^[a-z][a-z0-9-]{0,62}$/.test(slug),
    "VALIDATION_FAILED",
    "Table slugs must start with a letter and contain only lowercase letters, digits, and hyphens",
  );
}

export function validateFieldInput(field: FieldInput): void {
  invariant(
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.key),
    "VALIDATION_FAILED",
    `Invalid field key: ${field.key}`,
  );
  invariant(
    field.name.length >= 1 && field.name.length <= 200,
    "VALIDATION_FAILED",
    `Invalid display name for field ${field.key}`,
  );
  const constraints = field.constraints ?? {};
  invariant(
    constraints.min === undefined ||
      field.type === "number" ||
      field.type === "timestamp",
    "VALIDATION_FAILED",
    "min applies only to number and timestamp fields",
  );
  invariant(
    constraints.max === undefined ||
      field.type === "number" ||
      field.type === "timestamp",
    "VALIDATION_FAILED",
    "max applies only to number and timestamp fields",
  );
  if (constraints.min !== undefined) {
    invariant(
      Number.isFinite(constraints.min),
      "VALIDATION_FAILED",
      "min must be finite",
    );
  }
  if (constraints.max !== undefined) {
    invariant(
      Number.isFinite(constraints.max),
      "VALIDATION_FAILED",
      "max must be finite",
    );
  }
  if (constraints.min !== undefined && constraints.max !== undefined) {
    invariant(
      constraints.min <= constraints.max,
      "VALIDATION_FAILED",
      "min cannot be greater than max",
    );
  }
  invariant(
    constraints.maxBytes === undefined ||
      field.type === "text" ||
      field.type === "reference",
    "VALIDATION_FAILED",
    "maxBytes applies only to text and reference fields",
  );
  if (constraints.maxBytes !== undefined) {
    invariant(
      Number.isInteger(constraints.maxBytes) &&
        constraints.maxBytes >= 1 &&
        constraints.maxBytes <= 100_000,
      "VALIDATION_FAILED",
      "maxBytes must be an integer between 1 and 100000",
    );
  }
  invariant(
    constraints.selectOptions === undefined || field.type === "select",
    "VALIDATION_FAILED",
    "selectOptions applies only to select fields",
  );
  invariant(
    constraints.referenceTableId === undefined || field.type === "reference",
    "VALIDATION_FAILED",
    "referenceTableId applies only to reference fields",
  );
  if (field.type === "select") {
    const options = constraints.selectOptions ?? [];
    invariant(
      options.length <= 200,
      "LIMIT_EXCEEDED",
      "Select fields allow at most 200 options",
    );
    const codes = new Set<string>();
    for (const option of options) {
      invariant(
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(option.code),
        "VALIDATION_FAILED",
        `Invalid select option code: ${option.code}`,
      );
      invariant(
        utf8Bytes(option.label.normalize("NFC")) >= 1 &&
          utf8Bytes(option.label.normalize("NFC")) <= 256,
        "VALIDATION_FAILED",
        `Select option label must contain 1 to 256 bytes: ${option.code}`,
      );
      invariant(
        !codes.has(option.code),
        "VALIDATION_FAILED",
        `Duplicate select option: ${option.code}`,
      );
      codes.add(option.code);
    }
    invariant(
      getConvexSize(options) <= 64_000,
      "LIMIT_EXCEEDED",
      "Select option metadata exceeds 64 KB",
    );
  }
}

export function validateFields(fields: readonly FieldInput[]): void {
  invariant(
    fields.length <= MAX_FIELDS,
    "LIMIT_EXCEEDED",
    `Tables allow at most ${MAX_FIELDS} fields`,
  );
  const keys = new Set<string>();
  for (const field of fields) {
    validateFieldInput(field);
    invariant(
      !keys.has(field.key),
      "VALIDATION_FAILED",
      `Duplicate field key: ${field.key}`,
    );
    keys.add(field.key);
  }
}

export function validateRecordValues(
  fields: readonly Doc<"fields">[],
  input: Readonly<Record<string, Scalar>>,
): Record<string, Scalar> {
  const fieldById = new Map(
    fields.map((field) => [field._id as string, field]),
  );
  const normalized: Record<string, Scalar> = {};
  for (const [fieldId, rawValue] of Object.entries(input)) {
    const field = fieldById.get(fieldId);
    invariant(
      field && field.state === "active",
      "VALIDATION_FAILED",
      `Unknown or deleted field: ${fieldId}`,
    );
    const value = normalizeScalar(rawValue);
    validateValue(field, value);
    normalized[fieldId] = value;
  }
  for (const field of fields) {
    if (field.state !== "active") continue;
    const value = normalized[field._id as string];
    if (field.required && (value === undefined || value === null)) {
      fail("VALIDATION_FAILED", `Required field is missing: ${field.key}`, {
        fieldId: field._id as string,
      });
    }
  }
  invariant(
    Object.keys(normalized).length <= MAX_FIELDS,
    "LIMIT_EXCEEDED",
    `Records allow at most ${MAX_FIELDS} values`,
  );
  const recordBytes = getConvexSize(normalized);
  invariant(
    recordBytes <= MAX_RECORD_BYTES,
    "LIMIT_EXCEEDED",
    `Record exceeds the ${MAX_RECORD_BYTES}-byte safety budget`,
    { recordBytes },
  );
  return normalized;
}

export function validateValue(field: Doc<"fields">, value: Scalar): void {
  if (value === null) {
    invariant(
      !field.required,
      "VALIDATION_FAILED",
      `Field ${field.key} cannot be null`,
    );
    return;
  }
  switch (field.type) {
    case "text":
    case "select":
    case "reference":
      invariant(
        typeof value === "string",
        "VALIDATION_FAILED",
        `Field ${field.key} requires a string`,
      );
      if (field.constraints.maxBytes !== undefined) {
        invariant(
          utf8Bytes(value) <= field.constraints.maxBytes,
          "VALIDATION_FAILED",
          `Field ${field.key} exceeds maxBytes`,
        );
      }
      if (field.type === "select") {
        const allowed = new Set(
          (field.constraints.selectOptions ?? []).map((option) => option.code),
        );
        invariant(
          allowed.has(value),
          "VALIDATION_FAILED",
          `Unknown option for field ${field.key}`,
        );
      }
      break;
    case "number":
      invariant(
        typeof value === "number",
        "VALIDATION_FAILED",
        `Field ${field.key} requires a number`,
      );
      validateNumericBounds(field, value);
      break;
    case "timestamp":
      invariant(
        typeof value === "number" && Number.isSafeInteger(value),
        "VALIDATION_FAILED",
        `Field ${field.key} requires an integer epoch-millisecond timestamp`,
      );
      invariant(
        value >= -8_640_000_000_000_000 && value <= 8_640_000_000_000_000,
        "VALIDATION_FAILED",
        `Timestamp for field ${field.key} is outside the supported range`,
      );
      validateNumericBounds(field, value);
      break;
    case "boolean":
      invariant(
        typeof value === "boolean",
        "VALIDATION_FAILED",
        `Field ${field.key} requires a boolean`,
      );
      break;
  }
}

export function validateStoredDocumentSize(
  value: Record<string, unknown>,
  label: string,
  maximum = MAX_RECORD_BYTES,
): void {
  const bytes = getConvexSize(value as never);
  invariant(bytes <= maximum, "LIMIT_EXCEEDED", `${label} exceeds size limit`, {
    bytes,
    maximum,
  });
}

export function validatePositiveInteger(
  value: number | undefined,
  label: string,
  maximum: number,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  invariant(
    Number.isFinite(value) && Number.isInteger(value) && value > 0,
    "VALIDATION_FAILED",
    `${label} must be a positive finite integer`,
  );
  invariant(
    value <= maximum,
    "LIMIT_EXCEEDED",
    `${label} cannot exceed ${maximum}`,
  );
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateNumericBounds(field: Doc<"fields">, value: number): void {
  invariant(
    Number.isFinite(value),
    "VALIDATION_FAILED",
    `Field ${field.key} requires a finite number`,
  );
  if (field.constraints.min !== undefined) {
    invariant(
      value >= field.constraints.min,
      "VALIDATION_FAILED",
      `Field ${field.key} is below min`,
    );
  }
  if (field.constraints.max !== undefined) {
    invariant(
      value <= field.constraints.max,
      "VALIDATION_FAILED",
      `Field ${field.key} is above max`,
    );
  }
}

export function ensureScope<T extends { scopeId: string }>(
  value: T | null,
  scopeId: string,
  resource: string,
): T {
  if (!value) fail("NOT_FOUND", `${resource} was not found`);
  if (value.scopeId !== scopeId)
    fail("SCOPE_MISMATCH", `${resource} belongs to another scope`);
  return value;
}

export function ensureActiveTable(table: Doc<"tables">): void {
  if (table.state === "deleting")
    fail("TABLE_DELETING", "Table is being deleted");
}

export function ensureFieldIds(
  fields: readonly Doc<"fields">[],
  fieldIds: readonly Id<"fields">[],
): void {
  invariant(
    fieldIds.length >= 1 && fieldIds.length <= MAX_INDEX_FIELDS,
    "VALIDATION_FAILED",
    `Indexes require 1 to ${MAX_INDEX_FIELDS} fields`,
  );
  const available = new Set(
    fields
      .filter((field) => field.state === "active")
      .map((field) => field._id),
  );
  const unique = new Set(fieldIds);
  invariant(
    unique.size === fieldIds.length,
    "VALIDATION_FAILED",
    "Index fields must be unique",
  );
  for (const fieldId of fieldIds) {
    invariant(
      available.has(fieldId),
      "VALIDATION_FAILED",
      `Unknown or deleted field: ${fieldId}`,
    );
  }
}
