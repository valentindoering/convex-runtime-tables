import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const CLEANUP_BATCH = 50;

export const cleanupIdempotency = internalMutation({
  args: { scopeId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const expired = await ctx.db
      .query("idempotencyKeys")
      .withIndex("by_scopeId_and_expiresAt", (q) =>
        q.eq("scopeId", args.scopeId).lte("expiresAt", Date.now()),
      )
      .take(CLEANUP_BATCH);
    for (const key of expired) await ctx.db.delete("idempotencyKeys", key._id);
    if (expired.length === CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.maintenance.cleanupIdempotency, {
        scopeId: args.scopeId,
      });
    }
    return null;
  },
});
