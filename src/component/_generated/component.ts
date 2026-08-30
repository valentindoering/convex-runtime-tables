/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    public: {
      addField: FunctionReference<
        "mutation",
        "internal",
        {
          expectedSchemaRev: number;
          field: {
            constraints?: {
              max?: number;
              maxLength?: number;
              min?: number;
              referenceTableId?: string;
              selectOptions?: Array<{ code: string; label: string }>;
            };
            key: string;
            name: string;
            required: boolean;
            type:
              | "text"
              | "number"
              | "boolean"
              | "timestamp"
              | "select"
              | "reference";
          };
          scopeId: string;
          tableId: string;
        },
        {
          _creationTime: number;
          _id: string;
          constraints: {
            max?: number;
            maxLength?: number;
            min?: number;
            referenceTableId?: string;
            selectOptions?: Array<{ code: string; label: string }>;
          };
          createdAt: number;
          key: string;
          name: string;
          required: boolean;
          scopeId: string;
          state: "active" | "deleting";
          tableId: string;
          type:
            | "text"
            | "number"
            | "boolean"
            | "timestamp"
            | "select"
            | "reference";
          updatedAt: number;
        },
        Name
      >;
      createIndex: FunctionReference<
        "mutation",
        "internal",
        {
          fieldIds: Array<string>;
          name: string;
          scopeId: string;
          tableId: string;
          unique: boolean;
        },
        { indexId: string; jobId: string },
        Name
      >;
      createTable: FunctionReference<
        "mutation",
        "internal",
        {
          fields: Array<{
            constraints?: {
              max?: number;
              maxLength?: number;
              min?: number;
              referenceTableId?: string;
              selectOptions?: Array<{ code: string; label: string }>;
            };
            key: string;
            name: string;
            required: boolean;
            type:
              | "text"
              | "number"
              | "boolean"
              | "timestamp"
              | "select"
              | "reference";
          }>;
          name: string;
          scopeId: string;
          slug: string;
        },
        {
          fields: Array<{
            _creationTime: number;
            _id: string;
            constraints: {
              max?: number;
              maxLength?: number;
              min?: number;
              referenceTableId?: string;
              selectOptions?: Array<{ code: string; label: string }>;
            };
            createdAt: number;
            key: string;
            name: string;
            required: boolean;
            scopeId: string;
            state: "active" | "deleting";
            tableId: string;
            type:
              | "text"
              | "number"
              | "boolean"
              | "timestamp"
              | "select"
              | "reference";
            updatedAt: number;
          }>;
          indexes: Array<{
            _creationTime: number;
            _id: string;
            createdAt: number;
            failure: null | {
              code: string;
              message: string;
              samples: Array<string>;
            };
            fieldIds: Array<string>;
            name: string;
            scopeId: string;
            state: "building" | "verifying" | "ready" | "failed" | "deleting";
            tableId: string;
            unique: boolean;
            updatedAt: number;
          }>;
          table: {
            _creationTime: number;
            _id: string;
            createdAt: number;
            name: string;
            schemaRev: number;
            scopeId: string;
            slug: string;
            state: "active" | "deleting";
            updatedAt: number;
          };
        },
        Name
      >;
      deleteIndex: FunctionReference<
        "mutation",
        "internal",
        { indexId: string; scopeId: string },
        { jobId: string },
        Name
      >;
      deleteRecord: FunctionReference<
        "mutation",
        "internal",
        {
          expectedRev?: number;
          recordId: string;
          scopeId: string;
          tableId: string;
        },
        null,
        Name
      >;
      deleteTable: FunctionReference<
        "mutation",
        "internal",
        { scopeId: string; tableId: string },
        { jobId: string },
        Name
      >;
      explainQuery: FunctionReference<
        "query",
        "internal",
        {
          query: {
            orderBy?: { direction: "asc" | "desc"; fieldIds: Array<string> };
            where: Array<{
              fieldId: string;
              op: "eq" | "lt" | "lte" | "gt" | "gte";
              value: null | boolean | number | string;
            }>;
          };
          scopeId: string;
          tableId: string;
        },
        | { indexId: string; kind: "index"; postFiltered: boolean }
        | { kind: "scan"; postFiltered: boolean }
        | { kind: "indexRequired"; suggestedIndex: Array<string> },
        Name
      >;
      getJob: FunctionReference<
        "query",
        "internal",
        { jobId: string; scopeId: string },
        null | {
          _creationTime: number;
          _id: string;
          attempts: number;
          createdAt: number;
          cursor: null | string;
          kind: "buildIndex" | "deleteIndex" | "deleteTable";
          lastError: null | { code: string; message: string };
          phase:
            | "backfill"
            | "verifyRecords"
            | "verifyEntries"
            | "deleteEntries"
            | "deleteRecords"
            | "deleteFields"
            | "deleteMetadata"
            | "done";
          progress: number;
          scopeId: string;
          state: "queued" | "running" | "succeeded" | "failed";
          targetId: string;
          updatedAt: number;
        },
        Name
      >;
      getRecord: FunctionReference<
        "query",
        "internal",
        { recordId: string; scopeId: string; tableId: string },
        null | {
          _creationTime: number;
          _id: string;
          createdAt: number;
          rev: number;
          scopeId: string;
          tableId: string;
          updatedAt: number;
          values: Record<string, null | boolean | number | string>;
        },
        Name
      >;
      getTable: FunctionReference<
        "query",
        "internal",
        { scopeId: string; tableId: string },
        {
          fields: Array<{
            _creationTime: number;
            _id: string;
            constraints: {
              max?: number;
              maxLength?: number;
              min?: number;
              referenceTableId?: string;
              selectOptions?: Array<{ code: string; label: string }>;
            };
            createdAt: number;
            key: string;
            name: string;
            required: boolean;
            scopeId: string;
            state: "active" | "deleting";
            tableId: string;
            type:
              | "text"
              | "number"
              | "boolean"
              | "timestamp"
              | "select"
              | "reference";
            updatedAt: number;
          }>;
          indexes: Array<{
            _creationTime: number;
            _id: string;
            createdAt: number;
            failure: null | {
              code: string;
              message: string;
              samples: Array<string>;
            };
            fieldIds: Array<string>;
            name: string;
            scopeId: string;
            state: "building" | "verifying" | "ready" | "failed" | "deleting";
            tableId: string;
            unique: boolean;
            updatedAt: number;
          }>;
          table: {
            _creationTime: number;
            _id: string;
            createdAt: number;
            name: string;
            schemaRev: number;
            scopeId: string;
            slug: string;
            state: "active" | "deleting";
            updatedAt: number;
          };
        },
        Name
      >;
      insertRecords: FunctionReference<
        "mutation",
        "internal",
        {
          idempotencyKey?: string;
          records: Array<{
            values: Record<string, null | boolean | number | string>;
          }>;
          scopeId: string;
          tableId: string;
        },
        Array<{ recordId: string; rev: number }>,
        Name
      >;
      listTables: FunctionReference<
        "query",
        "internal",
        { scopeId: string },
        Array<{
          _creationTime: number;
          _id: string;
          createdAt: number;
          name: string;
          schemaRev: number;
          scopeId: string;
          slug: string;
          state: "active" | "deleting";
          updatedAt: number;
        }>,
        Name
      >;
      patchRecord: FunctionReference<
        "mutation",
        "internal",
        {
          expectedRev: number;
          patch: {
            unsetFieldIds?: Array<string>;
            values: Record<string, null | boolean | number | string>;
          };
          recordId: string;
          scopeId: string;
          tableId: string;
        },
        { recordId: string; rev: number },
        Name
      >;
      queryRecords: FunctionReference<
        "query",
        "internal",
        {
          pagination: {
            cursor?: string;
            endCursor?: string;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            pageSize: number;
          };
          query: {
            orderBy?: { direction: "asc" | "desc"; fieldIds: Array<string> };
            where: Array<{
              fieldId: string;
              op: "eq" | "lt" | "lte" | "gt" | "gte";
              value: null | boolean | number | string;
            }>;
          };
          scopeId: string;
          tableId: string;
        },
        {
          continueCursor: null | string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            createdAt: number;
            rev: number;
            scopeId: string;
            tableId: string;
            updatedAt: number;
            values: Record<string, null | boolean | number | string>;
          }>;
          plan:
            | { indexId: string; kind: "index"; postFiltered: boolean }
            | { kind: "scan"; postFiltered: boolean };
        },
        Name
      >;
      retryIndexBuild: FunctionReference<
        "mutation",
        "internal",
        { indexId: string; scopeId: string },
        { jobId: string },
        Name
      >;
      updateField: FunctionReference<
        "mutation",
        "internal",
        {
          expectedSchemaRev: number;
          fieldId: string;
          patch: { name: string };
          scopeId: string;
        },
        {
          _creationTime: number;
          _id: string;
          constraints: {
            max?: number;
            maxLength?: number;
            min?: number;
            referenceTableId?: string;
            selectOptions?: Array<{ code: string; label: string }>;
          };
          createdAt: number;
          key: string;
          name: string;
          required: boolean;
          scopeId: string;
          state: "active" | "deleting";
          tableId: string;
          type:
            | "text"
            | "number"
            | "boolean"
            | "timestamp"
            | "select"
            | "reference";
          updatedAt: number;
        },
        Name
      >;
      updateTable: FunctionReference<
        "mutation",
        "internal",
        {
          expectedSchemaRev: number;
          patch: { name?: string; slug?: string };
          scopeId: string;
          tableId: string;
        },
        {
          fields: Array<{
            _creationTime: number;
            _id: string;
            constraints: {
              max?: number;
              maxLength?: number;
              min?: number;
              referenceTableId?: string;
              selectOptions?: Array<{ code: string; label: string }>;
            };
            createdAt: number;
            key: string;
            name: string;
            required: boolean;
            scopeId: string;
            state: "active" | "deleting";
            tableId: string;
            type:
              | "text"
              | "number"
              | "boolean"
              | "timestamp"
              | "select"
              | "reference";
            updatedAt: number;
          }>;
          indexes: Array<{
            _creationTime: number;
            _id: string;
            createdAt: number;
            failure: null | {
              code: string;
              message: string;
              samples: Array<string>;
            };
            fieldIds: Array<string>;
            name: string;
            scopeId: string;
            state: "building" | "verifying" | "ready" | "failed" | "deleting";
            tableId: string;
            unique: boolean;
            updatedAt: number;
          }>;
          table: {
            _creationTime: number;
            _id: string;
            createdAt: number;
            name: string;
            schemaRev: number;
            scopeId: string;
            slug: string;
            state: "active" | "deleting";
            updatedAt: number;
          };
        },
        Name
      >;
      upsertRecords: FunctionReference<
        "mutation",
        "internal",
        {
          idempotencyKey?: string;
          records: Array<{
            values: Record<string, null | boolean | number | string>;
          }>;
          scopeId: string;
          tableId: string;
          uniqueIndexId: string;
        },
        Array<{ recordId: string; rev: number }>,
        Name
      >;
      verifyIndex: FunctionReference<
        "mutation",
        "internal",
        { indexId: string; scopeId: string },
        { jobId: string },
        Name
      >;
    };
  };
