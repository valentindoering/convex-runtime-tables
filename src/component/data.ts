import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { fail } from "./errors.js";
import { normalizeIndexSlots, type Scalar } from "./normalization.js";
import { ensureScope } from "./validation.js";

type ReadCtx = QueryCtx | MutationCtx;

export async function loadTable(
  ctx: ReadCtx,
  scopeId: string,
  tableId: Id<"tables">,
): Promise<Doc<"tables">> {
  return ensureScope(await ctx.db.get("tables", tableId), scopeId, "Table");
}

export async function loadFields(
  ctx: ReadCtx,
  scopeId: string,
  tableId: Id<"tables">,
): Promise<Doc<"fields">[]> {
  const active = await ctx.db
    .query("fields")
    .withIndex("by_scopeId_and_tableId_and_state", (q) =>
      q.eq("scopeId", scopeId).eq("tableId", tableId).eq("state", "active"),
    )
    .take(201);
  const deleting = await ctx.db
    .query("fields")
    .withIndex("by_scopeId_and_tableId_and_state", (q) =>
      q.eq("scopeId", scopeId).eq("tableId", tableId).eq("state", "deleting"),
    )
    .take(201);
  return [...active, ...deleting];
}

export async function loadIndexesForWrites(
  ctx: ReadCtx,
  scopeId: string,
  tableId: Id<"tables">,
): Promise<Doc<"indexDefinitions">[]> {
  const states = ["building", "verifying", "ready", "failed"] as const;
  const groups = await Promise.all(
    states.map((state) =>
      ctx.db
        .query("indexDefinitions")
        .withIndex("by_scopeId_and_tableId_and_state", (q) =>
          q.eq("scopeId", scopeId).eq("tableId", tableId).eq("state", state),
        )
        .take(5),
    ),
  );
  return groups.flat();
}

export async function maintainRecordIndexes(
  ctx: MutationCtx,
  record: Doc<"records">,
): Promise<void> {
  const indexes = await loadIndexesForWrites(
    ctx,
    record.scopeId,
    record.tableId,
  );
  for (const index of indexes) {
    await upsertIndexEntry(ctx, index, record);
  }
}

export async function upsertIndexEntry(
  ctx: MutationCtx,
  index: Doc<"indexDefinitions">,
  record: Doc<"records">,
  enforceUnique = true,
): Promise<void> {
  const [k0, k1, k2] = normalizeIndexSlots(
    index.fieldIds,
    record.values as Record<string, Scalar>,
  );
  if (
    enforceUnique &&
    index.unique &&
    (index.state === "ready" || index.state === "verifying")
  ) {
    const collisions = await ctx.db
      .query("indexEntries")
      .withIndex(
        "by_scopeId_and_indexId_and_k0_and_k1_and_k2_and_recordId",
        (q) =>
          q
            .eq("scopeId", index.scopeId)
            .eq("indexId", index._id)
            .eq("k0", k0)
            .eq("k1", k1)
            .eq("k2", k2),
      )
      .take(2);
    if (collisions.some((entry) => entry.recordId !== record._id)) {
      fail(
        "UNIQUE_CONFLICT",
        `Unique index ${index.name} already contains this key`,
        {
          indexId: index._id,
        },
      );
    }
  }
  const current = await ctx.db
    .query("indexEntries")
    .withIndex("by_scopeId_and_indexId_and_recordId", (q) =>
      q
        .eq("scopeId", index.scopeId)
        .eq("indexId", index._id)
        .eq("recordId", record._id),
    )
    .unique();
  if (!current) {
    await ctx.db.insert("indexEntries", {
      scopeId: index.scopeId,
      indexId: index._id,
      recordId: record._id,
      k0,
      k1,
      k2,
      recordRev: record.rev,
    });
    return;
  }
  if (current.recordRev > record.rev) return;
  await ctx.db.patch("indexEntries", current._id, {
    k0,
    k1,
    k2,
    recordRev: record.rev,
  });
}

export async function deleteRecordIndexEntries(
  ctx: MutationCtx,
  scopeId: string,
  recordId: Id<"records">,
): Promise<void> {
  const entries = await ctx.db
    .query("indexEntries")
    .withIndex("by_scopeId_and_recordId_and_indexId", (q) =>
      q.eq("scopeId", scopeId).eq("recordId", recordId),
    )
    .take(5);
  for (const entry of entries) await ctx.db.delete("indexEntries", entry._id);
}
