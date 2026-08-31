import { describe, expect, test, vi } from "vitest";
import {
  RuntimeTablesAgentError,
  createRuntimeTablesAgentDispatcher,
  runtimeTablesAgentOperations,
  runtimeTablesAgentRequestSchemaV1,
  type RuntimeTablesAgentHandlers,
} from "./index.js";

function handlers(): RuntimeTablesAgentHandlers {
  return Object.fromEntries(
    runtimeTablesAgentOperations.map((operation) => [
      operation,
      vi.fn(async (arguments_: Record<string, unknown>) => ({
        operation,
        arguments_,
      })),
    ]),
  ) as unknown as RuntimeTablesAgentHandlers;
}

describe("agent dispatcher", () => {
  test("exports a closed versioned JSON Schema", () => {
    expect(runtimeTablesAgentRequestSchemaV1.properties.version).toEqual({
      const: 1,
    });
    expect(runtimeTablesAgentRequestSchemaV1.additionalProperties).toBe(false);
    expect(runtimeTablesAgentRequestSchemaV1.properties.operation.enum).toEqual(
      runtimeTablesAgentOperations,
    );
    expect(runtimeTablesAgentRequestSchemaV1.oneOf).toHaveLength(
      runtimeTablesAgentOperations.length,
    );
    const querySchema = runtimeTablesAgentRequestSchemaV1.oneOf.find(
      (schema) => schema.properties.operation.const === "queryRecords",
    ) as any;
    expect(
      querySchema?.properties.arguments.properties.query.properties.where.items
        .additionalProperties,
    ).toBe(false);
    expect(
      querySchema?.properties.arguments.properties.pagination.properties
        .maximumBytesRead.maximum,
    ).toBe(4_000_000);
  });

  test("dispatches only own supported operation names", async () => {
    const dispatch = createRuntimeTablesAgentDispatcher(handlers());
    await expect(
      dispatch({
        version: 1,
        operation: "getTable",
        arguments: { scopeId: "scope", tableId: "table" },
      }),
    ).resolves.toMatchObject({ operation: "getTable" });
    for (const operation of ["constructor", "toString", "__proto__"]) {
      await expect(
        dispatch({ version: 1, operation, arguments: {} }),
      ).rejects.toMatchObject({ code: "UNKNOWN_OPERATION" });
    }
  });

  test.each([
    null,
    {},
    { version: 2, operation: "getTable", arguments: {} },
    { version: 1, operation: "getTable", arguments: {} },
    {
      version: 1,
      operation: "getTable",
      arguments: { scopeId: "scope", tableId: 7 },
    },
    {
      version: 1,
      operation: "getTable",
      arguments: { scopeId: "scope", tableId: "table", extra: true },
    },
    {
      version: 1,
      operation: "getTable",
      arguments: { scopeId: "x".repeat(65_000), tableId: "table" },
    },
    {
      version: 1,
      operation: "insertRecords",
      arguments: { scopeId: "scope", tableId: "table", records: [{}] },
    },
    {
      version: 1,
      operation: "createIndex",
      arguments: {
        scopeId: "scope",
        tableId: "table",
        name: "index",
        fieldIds: ["field", 7],
        unique: false,
      },
    },
    {
      version: 1,
      operation: "queryRecords",
      arguments: {
        scopeId: "scope",
        tableId: "table",
        query: { where: [] },
        pagination: { pageSize: "ten" },
      },
    },
    {
      version: 1,
      operation: "patchRecord",
      arguments: {
        scopeId: "scope",
        tableId: "table",
        recordId: "record",
        expectedRev: 1,
        patch: { values: { field: { nested: true } } },
      },
    },
    {
      version: 1,
      operation: "patchRecord",
      arguments: {
        scopeId: "scope",
        tableId: "table",
        recordId: "record",
        expectedRev: 1.5,
        patch: { values: {} },
      },
    },
    {
      version: 1,
      operation: "deleteRecord",
      arguments: {
        scopeId: "scope",
        tableId: "table",
        recordId: "record",
        expectedRev: Number.POSITIVE_INFINITY,
      },
    },
    {
      version: 1,
      operation: "getTable",
      arguments: { scopeId: "scope", tableId: "x".repeat(201) },
    },
    {
      version: 1,
      operation: "queryRecords",
      arguments: {
        scopeId: "scope",
        tableId: "table",
        query: { where: [], extra: true },
        pagination: { pageSize: 1 },
      },
    },
    {
      version: 1,
      operation: "queryRecords",
      arguments: {
        scopeId: "scope",
        tableId: "table",
        query: {
          where: [
            { fieldId: "a", op: "gt", value: 1 },
            { fieldId: "b", op: "lt", value: 2 },
          ],
        },
        pagination: { pageSize: 1 },
      },
    },
    {
      version: 1,
      operation: "queryRecords",
      arguments: {
        scopeId: "scope",
        tableId: "table",
        query: { where: [] },
        pagination: { pageSize: 101 },
      },
    },
    {
      version: 1,
      operation: "queryRecords",
      arguments: {
        scopeId: "scope",
        tableId: "table",
        query: { where: [] },
        pagination: { pageSize: 1, cursor: "x".repeat(8193) },
      },
    },
    {
      version: 1,
      operation: "insertRecords",
      arguments: {
        scopeId: "scope",
        tableId: "table",
        records: [{ values: {}, extra: true }],
      },
    },
  ])("rejects malformed or oversized request %#", async (request) => {
    const dispatch = createRuntimeTablesAgentDispatcher(handlers());
    await expect(dispatch(request)).rejects.toBeInstanceOf(
      RuntimeTablesAgentError,
    );
  });
});
