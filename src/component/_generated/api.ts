/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as data from "../data.js";
import type * as errors from "../errors.js";
import type * as indexJobs from "../indexJobs.js";
import type * as jobRunner from "../jobRunner.js";
import type * as maintenance from "../maintenance.js";
import type * as normalization from "../normalization.js";
import type * as planner from "../planner.js";
import type * as public_ from "../public.js";
import type * as testing from "../testing.js";
import type * as validation from "../validation.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  crons: typeof crons;
  data: typeof data;
  errors: typeof errors;
  indexJobs: typeof indexJobs;
  jobRunner: typeof jobRunner;
  maintenance: typeof maintenance;
  normalization: typeof normalization;
  planner: typeof planner;
  public: typeof public_;
  testing: typeof testing;
  validation: typeof validation;
  validators: typeof validators;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
