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

Indexed text is normalized to NFC and capped at 1 KiB. The same normalization
function is used by writes, verification, uniqueness checks, query bounds, and
scan comparison. Tests cover these invariants.

## Online index lifecycle

`createIndex` inserts a `building` definition and a durable job in one mutation.
The definition has a monotonic `generation`, one `activeJobId`, and a separate
`maintenanceState`. Every scheduled call carries the job ID, generation, and
phase. A batch checks all three before writing, rescheduling, or transitioning.
A stale call marks its job `superseded` and performs no target writes.

The build pipeline is backfill, repair, independent verification, then ready.
Backfill and repair may insert, patch, or delete sidecar entries. Verification
never mutates sidecars. It records missing, orphaned, stale, and duplicate
counts plus ten IDs per category. Any mismatch fails the build. A ready index
remains queryable during an operator-requested verification because serving
state and maintenance state are separate.

Every indexed read zips each sidecar entry with its hydrated record before
applying legitimate residual predicates. A missing record, scope/table mismatch,
or record-revision mismatch returns `INDEX_NOT_READY`; the query never hides
structural drift as a short page. Queries remain read-only, so verification and
repair own the lifecycle transition.

Unique enforcement is intentionally conservative during lifecycle work. A
building index does not reject ordinary writes; repair and read-only
verification must prove that its complete key set is unique before it becomes
ready. Its first successful verification permanently activates unique
enforcement. If that formerly-ready index later fails verification, inserts,
patches, and upserts on the table fail with `INDEX_NOT_READY` until repair and
verification restore it. This table-wide fail-closed policy prevents duplicate
authoritative writes during the outage. Existing ready indexes continue
enforcing non-null keys while an operator verification runs. Record deletion
remains available because it cannot introduce a duplicate. Operators can repair
after deleting conflicting records, or drop the index to remove the constraint
and resume writes.

Index and table deletion first changes visible state so planners and writers
stop selecting the resource. Table deletion atomically increments every child
index generation, clears its active job, and moves it to deleting before the
purge is scheduled. Stale child callbacks therefore supersede without another
sidecar write. Workers then delete bounded batches and finally remove metadata.
No worker relies on process memory.

## Limits

- 200 fields per table.
- Four indexes per table.
- Three fields per index.
- 100 records and 1.5 MB per write batch.
- 700 KB record safety budget measured with `getConvexSize`.
- 1 KiB per indexed string and 32 KB per generated index-entry document.
- 100 records per query page.
- 200 records for bounded scan fallback.
- Four million bytes and 1,000 sidecar rows as hard query read caps.
- 8 KiB encoded cursor cap.

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
