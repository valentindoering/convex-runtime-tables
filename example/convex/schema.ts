import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  hostAudit: defineTable({
    operation: v.string(),
    createdAt: v.number(),
  }).index("by_operation", ["operation"]),
});
