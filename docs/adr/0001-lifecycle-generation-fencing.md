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

Scheduled work enters through an internal action. Each batch runs as a nested
mutation. A thrown batch rolls back, then a separate mutation records an
observable failure. There is no automatic retry policy for unexpected errors; an
operator must call the explicit retry or repair operation. `batchCount` and
`retryCount` therefore have distinct meanings.

The build pipeline is:

1. backfill, which may write entries;
2. repair records and entries, which may reconcile entries;
3. independent record and entry verification, which never writes entries;
4. ready only when every verification count is zero.

A verification mismatch fails a building index. An operator verification of a
ready index leaves serving state ready but marks maintenance failed and stores
diagnostics.

## Consequences

Lifecycle transitions require more metadata and tests. Stale callbacks are safe
and observable. Verification can detect an ordinary writer defect instead of
hiding it through self-healing. Ready queries remain available during operator
verification.
