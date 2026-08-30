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
  ])("rejects malformed or oversized request %#", async (request) => {
    const dispatch = createRuntimeTablesAgentDispatcher(handlers());
    await expect(dispatch(request)).rejects.toBeInstanceOf(
      RuntimeTablesAgentError,
    );
  });
});
