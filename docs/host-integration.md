# Host integration

Mount the component and call it only from host functions. A host wrapper
authenticates the caller, authorizes the requested action, derives an allowed
`scopeId`, and then calls the component in the same query or mutation.

```ts
export const queryRuntimeRecords = query({
  args: requestValidator,
  returns: responseValidator,
  handler: async (ctx, args) => {
    const access = await authorizeRuntimeTableRead(ctx, args.tableId);
    return await ctx.runQuery(components.runtimeTables.public.queryRecords, {
      scopeId: access.scopeId,
      tableId: args.tableId,
      query: args.query,
      pagination: args.pagination,
    });
  },
});
```

Component reads remain reactive across this wrapper. Component mutations called
from a host mutation share its transaction. The test suite proves that a forced
error rolls back both a host audit row and a component record.

The exported `RuntimeTables` class provides typed server-side call helpers. It
does not make authorization decisions.

## Agent access

Agents should receive host-authorized tools, never direct component credentials.
The `./agent` export is a transport-neutral dispatcher for a host that already
implements authorization and argument validation. It is not an MCP server and
opens no network listener.

Recommended operations are list tables, inspect schema, explain or query
records, write records, request an index, and inspect a job. A host should
require human approval for destructive schema operations and decide whether an
agent may create a suggested index after `INDEX_REQUIRED`.

## Idempotency

Insert and upsert batches accept optional keys. Reuse with the same canonical
request returns the stored result. Reuse with different content returns
`IDEMPOTENCY_KEY_REUSED`. Keys expire after 14 days. Each stored key schedules a
bounded scope cleanup worker; table deletion also removes its keys.
