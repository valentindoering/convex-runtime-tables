# ADR 0002: Canonical cursor plan identity

Status: accepted

## Context

The first cursor format stored a hand-written non-cryptographic hash of the
query. It did not identify every result-shaping metadata revision and made
collision reasoning part of correctness.

## Decision

Cursor version 2 stores the canonical JSON string for the complete selected
plan. The plan includes query predicates and ordering, plan kind, scope, table,
selected index when present, direction, and table `schemaRev`. The outer cursor
also stores those authoritative resource fields and the inner supported
`convex-helpers` cursor or bounded-scan boundary.

Resume recomputes the canonical plan and requires exact equality. It also
requires the same cursor version, kind, scope, resource, direction, and
`schemaRev`. Encoded cursors and end cursors are capped at 8 KiB before parsing
or returning. A cursor is opaque but not signed; scope checks, ready-only index
selection, and target ownership remain authoritative.

`schemaRev` changes for result-shaping field and table metadata, index creation,
an index becoming ready, index deletion, and table deletion. Old cursors fail
with `INVALID_CURSOR` instead of silently changing meaning.

## Consequences

Cursor contents are larger but directly inspectable during debugging. There is
no collision-dependent identity. Metadata changes invalidate pagination
conservatively.
