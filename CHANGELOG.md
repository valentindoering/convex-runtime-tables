# Changelog

## 0.1.0-alpha.1 (unreleased)

First planned npm prerelease of `convex-runtime-tables`, on the `alpha` tag.

- Runtime tables, stable field IDs, scalar validation, and scope isolation.
- Atomic record/index writes, revision conflicts, payload-hashed idempotency,
  and unique-index upserts.
- Bounded queries, structural pagination, and query-bound cursors.
- Generation-fenced index builds, explicit repair, independent verification,
  retries, and deletion jobs.
- Typed host client and validated agent dispatcher with versioned JSON Schemas.

The host must enforce authentication and authorization. This alpha has no joins,
aggregates, full-text search, referential integrity, audit log, or row
permissions. API and storage compatibility are not yet guaranteed across alpha
versions. Production-authoritative use still requires the outstanding release
review.

## 0.1.0-alpha.0

- Unpublished runtime-tables component alpha.
- Scoped runtime schemas, validated scalar records, sidecar indexes, bounded
  query planner, optimistic revisions, idempotent writes, and resumable index
  and deletion jobs.
- Finance acceptance example, transport-neutral agent dispatcher, and component
  isolation tests.
