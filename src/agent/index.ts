export type RuntimeTablesAgentOperation =
  | "listTables"
  | "getTable"
  | "queryRecords"
  | "explainQuery"
  | "insertRecords"
  | "patchRecord"
  | "upsertRecords"
  | "deleteRecord"
  | "createIndex"
  | "getJob";

export type RuntimeTablesAgentRequest = {
  operation: RuntimeTablesAgentOperation;
  arguments: Record<string, unknown>;
};

export type RuntimeTablesAgentHandlers = {
  [Operation in RuntimeTablesAgentOperation]: (
    arguments_: Record<string, unknown>,
  ) => Promise<unknown>;
};

export function createRuntimeTablesAgentDispatcher(
  handlers: RuntimeTablesAgentHandlers,
): (request: RuntimeTablesAgentRequest) => Promise<unknown> {
  return async (request) =>
    await handlers[request.operation](request.arguments);
}
