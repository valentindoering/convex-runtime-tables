import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const CLEANUP_BATCH = 100;

export const cleanupExpired = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const keys = await ctx.db
      .query("idempotencyKeys")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(CLEANUP_BATCH);
    for (const key of keys) await ctx.db.delete("idempotencyKeys", key._id);

    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_retentionExpiresAt", (q) =>
        q.gt("retentionExpiresAt", undefined).lte("retentionExpiresAt", now),
      )
      .take(CLEANUP_BATCH);
    for (const job of jobs) await ctx.db.delete("jobs", job._id);

    if (keys.length === CLEANUP_BATCH || jobs.length === CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.maintenance.cleanupExpired, {});
    }
    return null;
  },
});
