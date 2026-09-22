# Release evidence

Status (2026-09-22): npm prerelease preparation is in progress. Publication
remains blocked pending a fresh release review and final-candidate hosted gates.
The historical sections below describe earlier runs, not the current candidate.

## Release review repair, September 22

The fresh review found impossible index suggestions when equality fields occur
inside the requested ordering, ignored scan `endCursor`, unstructured malformed
operator-cursor errors, and full-record read amplification past transaction
limits. The repair normalizes constant ordering fields, validates/pins scan end
boundaries, guards operator cursors, and byte-bounds lifecycle reads and indexed
record hydration without skipping continuation entries.

- `src/component/releaseRegression.test.ts` covers 16 ordering/equality
  variants, ascending/descending scan boundaries, malformed operator cursors,
  and thirty 600 KB records with enforced transaction limits through
  build/query/purge.
- `npm test`: 110 tests, 10 files, no type errors; 14.44 seconds.
- `npm run typecheck`, format, lint, build: passed.
- The packed consumer passed on the new isolated dev deployment
  `precise-stoat-634` (expires in four days). It mounted/codegenerated with no
  drift, exercised two independent-client subscription fixtures, and built,
  traversed both directions, and purged thirty 600 KB records plus the seed row.
  Log: `/private/tmp/crt-hosted-consumer-20260922.log`.
- The final candidate still needs independent regression review and the fresh
  100k hosted suite. These results are not a production GO.

## Verified publishing status, 2026-09-22

- Public npm lookup for `convex-runtime-tables` returned E404. No public package
  was found under that name; this does not reserve the name.
- The latest `npm whoami --registry=https://registry.npmjs.org` check succeeded
  as `valentindoering`. An earlier E401 has been resolved; nothing was
  published.
- [CI run 33532204130](https://github.com/valentindoering/convex-runtime-tables/actions/runs/33532204130)
  succeeded for `a2843691041d2095ceec46cde0b78b4f4ba53d47`.
- [Hosted run 33726911021](https://github.com/valentindoering/convex-runtime-tables/actions/runs/33726911021)
  succeeded for the same commit on September 3. It passed the packed consumer,
  real two-client subscription, codegen freshness, and two cleanup runs.
- The 100,000-row suite reported 99,990 exact surviving records, 99,990 entries
  in each of two indexes, zero verification mismatches, zero failures, and zero
  remaining tables after cleanup. Total wall time was 3,047,109 ms (50m 47s).
  Page latency was p50 263.67 ms / p95 282.489 ms; first/deep pages read 206
  documents each. Both build jobs completed in 2,433 batches with zero retries.
  Document amplification was two sidecar entries per record; byte storage and
  server-internal OCC retries were not measured.
- [Latest hosted run 35701124321](https://github.com/valentindoering/convex-runtime-tables/actions/runs/35701124321)
  failed on September 22 with
  `401 AuthenticationFailed: Invalid Convex deploy key` for the isolated
  `perfect-lark-558` test deployment. The scale step did not run. Historical
  success does not make this latest gate green.

See [npm-release.md](./npm-release.md) for the concrete alpha release procedure.

Candidate preparation on September 22 passed formatting, lint, typecheck, build,
and 104 tests across 9 files in 13.94 seconds. A clean local packed consumer
installed `0.1.0-alpha.1`, mounted the component, regenerated without drift,
performed a mutation and query, received a second-client reactive update, and
completed both fixture runs with exact cleanup. `release:prepare` checks all
exports and required documentation across 107 packed files. The final candidate
also restores the historical alpha.0 changelog entry; this documentation-only
addition does not change the code exercised by that consumer run. These local
results do not replace a fresh hosted gate or release review.

## Local deterministic gates

- `npm test`: 94 tests across 8 files passed in 14.79 seconds with no type
  errors.
- `npm run test:coverage`: 94 tests passed in 48.15 seconds. Overall coverage is
  88.41% statements, 75.07% branches, 93.24% functions, and 90.70% lines.
  Critical-file branch coverage is planner 69.03%, index data 86.20%, and
  lifecycle jobs 80.86%.
- `npm run test:real-concurrency`: an anonymous local Convex backend passed 20
  two-client repetitions each for delete versus backfill, unique insertion,
  idempotent insertion, and expected-revision patching. R1 used 1,000 rows and
  asserted that the build was still queued or running immediately before the
  second client deleted its target. The final 5,000-row concurrent idempotent
  import reported 5,080 records and 5,080 exact sidecar entries after including
  the preceding race fixtures.
- `npm run test:consumer`: the exact tarball installed into a clean consumer,
  mounted the component, code-generated twice without drift, executed a mutation
  and query, and delivered a `ConvexClient.onUpdate` callback from a second
  client. The result was `mutation=ok`, `queryCount=1`, `reactiveCount=2`, and
  `codegenFresh=true`. It purged the reserved smoke scope before running, then
  ran the same fixture twice on that scope and returned `cleanup=succeeded`
  after both deletion jobs and zero-table checks. The tarball contained 104
  files and was 104.8 kB compressed / 653.6 kB unpacked. Its inspected contents
  had no test module or fault-injection hook.
- Focused hardening regressions prove stale/orphaned indexed reads return
  `INDEX_NOT_READY`, formerly-ready unique indexes block writes without partial
  state until repair, stalled ready-index verification can restart, and 192
  deterministic competing-index plans match an independent scan/sort.
- `SCALE_ROW_COUNT=1000 npm run test:scale`: the revised harness passed its
  exact known-survivor assertion, two independent raw-sidecar oracles, both
  indexes in both directions, selected-index checks on every page, and table
  purge with zero remaining tables. It completed in 14,585 ms with 990 expected
  survivors and 1,980 sidecar entries. Both build jobs succeeded in 24 batches
  with zero retries, mismatches, or terminal failures.
- The clean-worktree CI bootstrap (`convex dev --once`, component codegen, and
  generated-file diff) passed without a pre-existing `.env.local`.
- `npm run format`, `npm run lint`, `npm run typecheck`, and `npm run build`
  passed locally.

Expected conflict logs from the real-concurrency gate are part of its oracle:
each losing request must report `UNIQUE_CONFLICT`, `IDEMPOTENCY_MISMATCH`, or a
bounded `CONFLICT` while the paired request succeeds.

## Development setup

`npm run dev` starts the anonymous local Convex backend, the component build
watcher, and Vite. The combined command was checked at
`http://127.0.0.1:50090/version` and `http://127.0.0.1:5173/`; both returned
HTTP 200, and Ctrl-C stopped both processes. Local development does not upload
code or data.

## Cloud gate status

The earlier GitHub run `33326349821` used the anonymous local backend on a
GitHub runner. Its 100,000-row step took 2 hours 11 minutes 56 seconds and is
not cloud-deployment evidence for this revision.

An isolated expiring Convex development deployment named `perfect-lark-558` was
provisioned for the review gate. GitHub run `33435188493` later uploaded commit
`44e77c05d3758377db574077857a49d140e5bac0`; its packed-consumer cloud
subscription passed, but the run was canceled during its 100,000-row step after
that SHA became obsolete. It does not certify commits `962bd9b` or `b62539b`.
The final-SHA hosted packed-consumer and 100,000-row gates remain pending and
must not be summarized as passing until a run completes with exact cleanup.

Hosted run `33439167267` targeted `c668a5268e48cde2c02178315e113f4f7389ff7c`.
Its packed-consumer step failed because the smoke wrapper reused fixed scope
`packed-consumer` and slug `items` left by the canceled run; the 100,000-row
step was skipped. This is a repeatable test-fixture cleanup defect, not evidence
of a component failure. The revised consumer preflights the fixed reserved scope
by deleting every table and waiting for every deletion job, so it also recovers
residue from an abruptly canceled process. It then executes twice on that same
scope, deletes each table through the component, and requires zero remaining
tables before reporting `cleanup="succeeded"`.

The revised 100,000-row harness now:

- asserts exactly 99,990 survivors and validates every sequence, patch, delete,
  revision, and payload;
- compares structural records with raw sidecar entries for both indexes;
- proves every page used the requested index and traverses both indexes in both
  directions;
- reports wall time, p50/p95 page latency, documents/bytes read, job batches,
  application-observed OCC retries, failures, and document amplification; and
- purges the test table and asserts zero remaining tables.

## Publication state

The GitHub repository and package remain private. Release scripts fail closed.
No npm package, GitHub release, public repository, or Ente deployment was
created. A fresh production release review is still required after the cloud
gate passes.

## Re-review code references

- Same-transaction record and sidecar writes: `src/component/public.ts:556`,
  `src/component/public.ts:566`, `src/component/public.ts:617`,
  `src/component/public.ts:623`, and `src/component/data.ts:61`.
- Same-transaction backfill read and entry write:
  `src/component/indexJobs.ts:220-233`.
- Payload-hashed idempotency tuple: `src/component/normalization.ts:63`,
  `src/component/public.ts:548`, `src/component/public.ts:1169-1213`, and
  `src/component/schema.ts:120`.
- Ready-only planner selection: `src/component/planner.ts:113` and
  `src/component/planner.ts:160`.
- Indexed read drift containment: `src/component/planner.ts:384-424`.
- Post-ready unique enforcement: `src/component/data.ts:82-94` and
  `src/component/indexJobs.ts:477-514`.
- Read-only verification and fail-closed drift handling:
  `src/component/indexJobs.ts:344-504`.
- Index/table lifecycle generation fences: `src/component/indexJobs.ts:574-608`.
- Table-deletion child fences: `src/component/public.ts:943-983`.
- Scope/resource-bound public pagination cursors:
  `src/component/public.ts:986-1048`.
