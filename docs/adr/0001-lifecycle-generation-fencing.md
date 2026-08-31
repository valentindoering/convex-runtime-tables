# ADR 0001: Lifecycle generation fencing

Status: accepted

## Context

Index build, verification, retry, index deletion, and table deletion are
scheduled work. A delayed callback can run after a newer operator action. A
single `state` field also cannot express that a ready index is still serving
while an operator runs read-only verification.

## Decision

Tables and index definitions carry a monotonic `generation` and one
`activeJobId`. Index definitions also separate serving `state` from
`maintenanceState`. Jobs persist their generation, phase, batch count, retry
count, bounded diagnostics, completion time, and retention time.

Every scheduled invocation carries `{jobId, generation, phase, kind}`. Before a
batch, before rescheduling, and before a terminal transition, the worker loads
the target and requires:

- target and job scope match;
- target generation equals job and invocation generation;
- target `activeJobId` equals the job ID;
- invocation phase equals the persisted job phase;
- the target is in the legal serving and maintenance state for that phase.

A mismatch performs no target or sidecar write. The old job becomes
`superseded`. Only the current generation can set an index ready. Repeated
delete calls return the existing non-terminal delete job. Repeating a delete
after its job failed starts a new generation. Repeating the same active
maintenance operation returns its existing job; a different maintenance
operation starts a newer generation and supersedes the old callback.

Table deletion fences its bounded set of child indexes in the same mutation as
the table state change. Each child moves to `deleting`, increments generation,
and clears `activeJobId` before the table purge is scheduled. Any already queued
index callback observes the mismatch and becomes `superseded`.

Scheduled work enters through an internal action. Each batch runs as a nested
mutation. A thrown batch rolls back, then a separate mutation records an
observable failure. There is no automatic retry policy for unexpected errors; an
operator must call the explicit retry or repair operation. `batchCount` and
`retryCount` therefore have distinct meanings.

Hosts must alert on failed jobs and failed maintenance state. The component does
not automatically repair or retry a persistent verification mismatch; recovery
is an explicit operator decision so a writer defect cannot create an unbounded
repair loop.

The hourly retention sweep also queries queued and running jobs through
`jobs.by_state_and_updatedAt`. A job with no progress for five minutes is failed
through the same generation-fenced unexpected-failure path with `JOB_STALLED`.
The sweep examines at most 100 stale jobs per pass and reschedules itself when
more remain. Operators retry an index with `retryIndexBuild`/`repairIndex` or
repeat a failed delete, which starts a new generation. The component does not
hide retries in `batchCount`; `retryCount` remains zero under this fail-fast
application policy.

The build pipeline is:

1. backfill, which may write entries;
2. repair records and entries, which may reconcile entries;
3. independent record and entry verification, which never writes entries;
4. ready only when every verification count is zero.

A verification mismatch fails a building index. A ready index continues serving
while an operator verification is running. If that verification finds drift, the
same transaction changes serving state to `failed`, clears `activeJobId`, stores
bounded diagnostics, and increments the owning table's `schemaRev`. The planner
stops selecting it immediately. Small queries may use the bounded scan fallback;
large queries that match the failed index return `INDEX_NOT_READY` with the
failed index ID. A failed index cannot remain an authoritative read path.

A unique index also carries a monotonic `uniqueEnforcementActivated` marker.
Initial builds leave it false so ordinary population remains possible. The first
successful independent verification sets it true. A later verification failure
retains it, and ordinary inserts, patches, and upserts fail atomically with
`INDEX_NOT_READY` until repair and verification return the index to ready.

## Consequences

Lifecycle transitions require more metadata and tests. Stale callbacks are safe
and observable. Verification can detect an ordinary writer defect instead of
hiding it through self-healing. Ready queries remain available during operator
verification, but verified drift fails closed after the mismatch is known.
