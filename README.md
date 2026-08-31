# convex-runtime-tables

Runtime-defined tables, fields, scalar records, and secondary indexes for Convex
applications.

This repository is an unpublished `0.1.0-alpha.0` implementation. `package.json`
contains `private: true`, so npm will refuse publication until a release review
removes that guard.

## What it provides

- Scope-isolated runtime table and field definitions.
- Runtime validation for text, number, boolean, timestamp, select, and reference
  values.
- Records keyed by stable field IDs, with optimistic `rev` checks.
- Up to four runtime sidecar indexes per table and three fields per index.
- Equality-prefix and next-field range queries, ascending or descending.
- Structural index pagination for unfiltered tables of any supported size and
  bounded scans for filtered tables with at most 200 records.
- Opaque, query-bound cursors using the supported `convex-helpers` component
  paginator.
- Generation-fenced online backfill, explicit repair, independent read-only
  verification, uniqueness checks, retry, and cleanup jobs.
- Atomic, idempotent insert batches and unique-index upserts.
- A transport-neutral agent dispatcher and a local finance acceptance example.

## When not to use it

Use an ordinary Convex table when the schema is known during development. Native
schemas give you stronger static types, fewer writes, simpler indexes, and less
operational work. This component is for schemas owned by users or operators at
runtime.

This alpha does not provide joins, SQL, formulas, aggregates, full-text search,
references with referential integrity, audit events, row permissions,
attachments, or a spreadsheet engine.

## Install locally

The package is not published. In another repository, install it from a local
checkout and mount the component:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import runtimeTables from "convex-runtime-tables/convex.config.js";

const app = defineApp();
app.use(runtimeTables);
export default app;
```

Component functions are not client endpoints. Wrap them in host queries and
mutations that authenticate the caller, authorize the requested scope and
action, then pass the authorized `scopeId` to
`components.runtimeTables.public.*`.

## Develop

```sh
npm install
npm run dev
```

`npm run dev` starts the anonymous local Convex backend, the component build
watcher, and Vite together. It prints one readiness line when both services are
available at `http://127.0.0.1:5173/` and stops both on Ctrl-C.

The example initializes a `transactions` runtime table, builds three indexes,
seeds an idempotent dataset, and renders a reactive grid. Development uses an
anonymous local Convex backend and does not publish a deployment.

Verification commands:

```sh
npm run build:codegen
npm run typecheck
npm run lint
npm test
npm run test:race
npm run test:coverage
npm run test:consumer
npm run build
```

## Public component API

Queries:

- `listTables`
- `getTable`
- `getRecord`
- `queryRecords`
- `explainQuery`
- `getJob`

Mutations:

- `createTable`, `updateTable`, `addField`, `updateField`
- `insertRecords`, `patchRecord`, `upsertRecords`, `deleteRecord`
- `createIndex`, `repairIndex`, `verifyIndex`, `retryIndexBuild`, `deleteIndex`,
  `deleteTable`

See [query-contract.md](./docs/query-contract.md) for predicate and pagination
rules and [host-integration.md](./docs/host-integration.md) for authorization
and agent boundaries.

## Security model

Components do not have `ctx.auth`. Every function therefore requires an explicit
`scopeId` and loads every supplied table, field, record, index, cursor,
idempotency key, and job before use. Cross-scope IDs fail closed. The host
remains responsible for authentication, authorization, audit policy, secrets,
public HTTP or MCP transport, and destructive-operation approval.

Do not expose component functions directly to untrusted callers. The example
uses a fixed scope only because it is a local acceptance app.

## License

Apache-2.0. See [LICENSE](./LICENSE).
