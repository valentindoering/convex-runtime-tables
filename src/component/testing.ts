import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";

function requireTestScope(scopeId: string): void {
  if (!scopeId.startsWith("test-")) throw new Error("Testing hook is disabled");
}

export const patchRecordWithoutIndexMaintenance = internalMutation({
  args: {
    scopeId: v.string(),
    recordId: v.id("records"),
    values: v.record(
      v.string(),
      v.union(v.null(), v.boolean(), v.number(), v.string()),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireTestScope(args.scopeId);
    const record = await ctx.db.get("records", args.recordId);
    if (!record || record.scopeId !== args.scopeId)
      throw new Error("Record not found");
    await ctx.db.patch("records", record._id, {
      values: args.values,
      rev: record.rev + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const insertOrphanedIndexEntry = internalMutation({
  args: {
    scopeId: v.string(),
    indexId: v.id("indexDefinitions"),
    recordId: v.id("records"),
  },
  returns: v.id("indexEntries"),
  handler: async (ctx, args) => {
    requireTestScope(args.scopeId);
    return await ctx.db.insert("indexEntries", {
      scopeId: args.scopeId,
      indexId: args.indexId,
      recordId: args.recordId,
      k0: "orphan",
      k1: null,
      k2: null,
      recordRev: -1,
    });
  },
});
