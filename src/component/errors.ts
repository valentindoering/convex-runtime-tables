import { ConvexError } from "convex/values";

export type RuntimeTablesErrorCode =
  | "SCOPE_MISMATCH"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "UNIQUE_CONFLICT"
  | "INDEX_REQUIRED"
  | "UNSUPPORTED_QUERY"
  | "INDEX_NOT_READY"
  | "INVALID_CURSOR"
  | "LIMIT_EXCEEDED"
  | "IDEMPOTENCY_MISMATCH"
  | "TABLE_DELETING";

export function fail(
  code: RuntimeTablesErrorCode,
  message: string,
  details: Record<string, string | number | boolean | null> = {},
): never {
  throw new ConvexError({ code, message, details });
}

export function invariant(
  condition: unknown,
  code: RuntimeTablesErrorCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): asserts condition {
  if (!condition) fail(code, message, details);
}
