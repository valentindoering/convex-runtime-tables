# Architecture

## Decision

Runtime records live in one static `records` table. Runtime indexes live in one
static `indexEntries` sidecar table. Each entry stores `scopeId`, `indexId`,
three normalized scalar slots, `recordId`, and the record revision. This
preserves normal Convex transactions and reactive host queries while allowing
index definitions to be data.

Aggregate is not the record query engine. It remains a possible later analytical
path for counts, sums, ranks, and measures.

## Trust boundary

The component owns schemas, validation, records, index metadata, index entries,
idempotency state, and resumable jobs. The host owns identity and authorization.
Every public component function receives `scopeId`; IDs are locators, never
authorization boundaries.

## Normalization experiment

A local Convex deployment was used before freezing the schema. The experiment
inserted missing, `null`, booleans, finite and non-finite numbers, strings, and
arrays into one indexed union field, then queried both directions and traversed
pages with the supported helper paginator.

Observed ascending order was missing, `null`, numbers, booleans, strings, then
arrays. Convex preserved distinct encodings for `-0` and `0`; it also accepted
`NaN` and infinities. The component responds as follows:

- missing and explicit `null` both write an indexed `null` slot;
- `-0` is canonicalized to `0`;
- `NaN` and infinities are rejected;
- arrays and objects are not record scalar values;
- empty strings are legal unless a field constraint forbids them;
- string order is the native case-sensitive binary order;
- timestamps are safe integer epoch milliseconds.

The same normalization function is used by writes, verification, uniqueness
checks, query bounds, and scan comparison. Tests cover these invariants.

## Online index lifecycle

`createIndex` inserts a `building` definition and a durable job in one mutation.
Writers maintain entries for `building`, `verifying`, `ready`, and `failed`
definitions. Backfill reads records in bounded cursor pages and upserts one
entry per record.

After backfill, the definition enters `verifying`. Verification walks records
and entries in separate resumable phases. It repairs stale or orphaned entries
and rejects duplicate tuples for unique indexes. Writers enforce uniqueness
during `verifying`, which acts as the final write barrier: a concurrent writer
that read the previous definition state conflicts with the state transition and
retries against the new state. Only then does the verifier mark the index
`ready`.

Index and table deletion first changes visible state so planners and writers
stop selecting the resource. Workers then delete bounded batches and finally
remove metadata. No worker relies on process memory.

## Limits

- 200 fields per table.
- Four indexes per table.
- Three fields per index.
- 100 records and 1.5 MB per write batch.
- 700 KB record safety budget.
- 100 records per query page.
- 200 records for bounded scan fallback.
- Four million bytes and 1,000 sidecar rows as hard query read caps.

These are domain limits below Convex platform limits. They should be revised
only with transaction metrics and benchmark evidence.

## Primary references

- [Authoring Convex Components](https://docs.convex.dev/components/authoring)
- [Using Convex Components](https://docs.convex.dev/components/using)
- [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/)
- [Convex pagination](https://docs.convex.dev/database/pagination)
- [OCC and atomicity](https://docs.convex.dev/database/advanced/occ)
- [Official component template](https://github.com/get-convex/templates/tree/main/template-component)
- [convex-helpers paginator](https://github.com/get-convex/convex-helpers/tree/main/packages/convex-helpers)
