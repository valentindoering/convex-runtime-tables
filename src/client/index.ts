import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  FunctionReference,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;
type ReadCtx = QueryCtx | MutationCtx | ActionCtx;
type WriteCtx = MutationCtx | ActionCtx;
type PublicArgs<Name extends keyof ComponentApi["public"]> =
  ComponentApi["public"][Name] extends FunctionReference<
    "query" | "mutation" | "action",
    "public" | "internal",
    infer Args,
    unknown,
    string | undefined
  >
    ? Args
    : never;

export type RuntimeTablesComponent = ComponentApi;

export class RuntimeTables {
  constructor(public readonly component: ComponentApi) {}

  listTables(ctx: ReadCtx, args: PublicArgs<"listTables">) {
    return ctx.runQuery(this.component.public.listTables, args);
  }

  getTable(ctx: ReadCtx, args: PublicArgs<"getTable">) {
    return ctx.runQuery(this.component.public.getTable, args);
  }

  getRecord(ctx: ReadCtx, args: PublicArgs<"getRecord">) {
    return ctx.runQuery(this.component.public.getRecord, args);
  }

  queryRecords(ctx: ReadCtx, args: PublicArgs<"queryRecords">) {
    return ctx.runQuery(this.component.public.queryRecords, args);
  }

  explainQuery(ctx: ReadCtx, args: PublicArgs<"explainQuery">) {
    return ctx.runQuery(this.component.public.explainQuery, args);
  }

  getJob(ctx: ReadCtx, args: PublicArgs<"getJob">) {
    return ctx.runQuery(this.component.public.getJob, args);
  }

  createTable(ctx: WriteCtx, args: PublicArgs<"createTable">) {
    return ctx.runMutation(this.component.public.createTable, args);
  }

  updateTable(ctx: WriteCtx, args: PublicArgs<"updateTable">) {
    return ctx.runMutation(this.component.public.updateTable, args);
  }

  addField(ctx: WriteCtx, args: PublicArgs<"addField">) {
    return ctx.runMutation(this.component.public.addField, args);
  }

  updateField(ctx: WriteCtx, args: PublicArgs<"updateField">) {
    return ctx.runMutation(this.component.public.updateField, args);
  }

  insertRecords(ctx: WriteCtx, args: PublicArgs<"insertRecords">) {
    return ctx.runMutation(this.component.public.insertRecords, args);
  }

  patchRecord(ctx: WriteCtx, args: PublicArgs<"patchRecord">) {
    return ctx.runMutation(this.component.public.patchRecord, args);
  }

  upsertRecords(ctx: WriteCtx, args: PublicArgs<"upsertRecords">) {
    return ctx.runMutation(this.component.public.upsertRecords, args);
  }

  deleteRecord(ctx: WriteCtx, args: PublicArgs<"deleteRecord">) {
    return ctx.runMutation(this.component.public.deleteRecord, args);
  }

  createIndex(ctx: WriteCtx, args: PublicArgs<"createIndex">) {
    return ctx.runMutation(this.component.public.createIndex, args);
  }

  verifyIndex(ctx: WriteCtx, args: PublicArgs<"verifyIndex">) {
    return ctx.runMutation(this.component.public.verifyIndex, args);
  }

  repairIndex(ctx: WriteCtx, args: PublicArgs<"repairIndex">) {
    return ctx.runMutation(this.component.public.repairIndex, args);
  }

  retryIndexBuild(ctx: WriteCtx, args: PublicArgs<"retryIndexBuild">) {
    return ctx.runMutation(this.component.public.retryIndexBuild, args);
  }

  deleteIndex(ctx: WriteCtx, args: PublicArgs<"deleteIndex">) {
    return ctx.runMutation(this.component.public.deleteIndex, args);
  }

  deleteTable(ctx: WriteCtx, args: PublicArgs<"deleteTable">) {
    return ctx.runMutation(this.component.public.deleteTable, args);
  }
}
