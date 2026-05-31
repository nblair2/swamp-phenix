/**
 * Shared swamp-model plumbing for the `@nblair2/phenix` extension.
 *
 * The model is a single type (`@nblair2/phenix`) whose methods and resources are
 * assembled from per-domain modules under `../_groups/`. This module holds the
 * types and helpers those groups share: the method-execution context, the
 * `defineMethod` factory (which keeps per-method argument typing while erasing
 * to a uniform registry entry), resource-spec typing, and small helpers for
 * building unique instance names and writing lists of resources.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  connect,
  type PhenixClient,
  type PhenixDeps,
  type PhenixGlobalArgs,
  sanitizeInstanceName,
} from "./phenix.ts";

/** Handle returned by `context.writeResource` (subset we rely on). */
export interface WriteHandle {
  name: string;
  specName: string;
  kind: string;
}

/** Minimal structural type for the swamp method execution context. */
export interface ModelContext {
  globalArgs: PhenixGlobalArgs;
  writeResource(
    specName: string,
    instanceName: string,
    data: unknown,
  ): Promise<WriteHandle>;
  readResource?(
    instanceName: string,
    version?: number,
  ): Promise<Record<string, unknown> | null>;
  /** Test-only hook to inject a pre-built client / file reader (see `_lib`). */
  _deps?: PhenixDeps;
}

/** Standard return shape of a model method. */
export interface MethodResult {
  dataHandles: WriteHandle[];
}

// deno-lint-ignore no-explicit-any
type AnyExecute = (args: any, context: ModelContext) => Promise<MethodResult>;

/** A method as stored in the model's `methods` registry. */
export interface MethodDef {
  description: string;
  arguments: z.ZodTypeAny;
  execute: AnyExecute;
}

/** A resource ("state") spec as stored in the model's `resources` registry. */
export interface ResourceSpec {
  description: string;
  schema: z.ZodTypeAny;
  lifetime: string;
  garbageCollection?: number;
}

/**
 * Define a method with precise argument typing in `execute`, returning a
 * uniformly-typed registry entry. The `arguments` schema drives `args` so each
 * method body stays type-checked while groups can be stored together.
 */
export function defineMethod<S extends z.ZodTypeAny>(def: {
  description: string;
  arguments: S;
  execute: (args: z.infer<S>, context: ModelContext) => Promise<MethodResult>;
}): MethodDef {
  return def as unknown as MethodDef;
}

/** Resolve a connected client, honoring a test-injected fetch when present. */
export function clientFor(context: ModelContext): Promise<PhenixClient> {
  return connect(context.globalArgs, context._deps ?? {});
}

/** Build a unique, path-safe instance name (`<prefix>-<sanitized name>`). */
export function inst(prefix: string, name: string): string {
  return `${prefix}-${sanitizeInstanceName(name)}`;
}

/**
 * Write each object in `items` as its own resource instance, keyed by its
 * `name` field (falling back to `"unknown"`), and return the handles.
 */
export async function writeList(
  context: ModelContext,
  spec: string,
  prefix: string,
  items: Record<string, unknown>[],
): Promise<WriteHandle[]> {
  const handles: WriteHandle[] = [];
  for (const item of items) {
    const name = typeof item.name === "string" ? item.name : "unknown";
    handles.push(await context.writeResource(spec, inst(prefix, name), item));
  }
  return handles;
}

/** Write a single object as a resource instance and return its handle. */
export async function writeOne(
  context: ModelContext,
  spec: string,
  prefix: string,
  name: string,
  data: unknown,
): Promise<MethodResult> {
  const handle = await context.writeResource(spec, inst(prefix, name), data);
  return { dataHandles: [handle] };
}

/**
 * Schema for the shared `operation` resource — the outcome of a one-shot action
 * that has no resource of its own (start/stop a capture, set a schedule, trigger
 * apps, mint a token, read version/features, etc.). Each model declares an
 * inline `operation` resource spec (so the registry can display it) that
 * references this schema.
 */
export const operationSchema = z.object({
  operation: z.string(),
  target: z.string().optional(),
  message: z.string().optional(),
  result: z.unknown().optional(),
  ranAt: z.string(),
}).passthrough();

/** Record the outcome of a one-shot action as an `operation` resource. */
export async function writeOperation(
  context: ModelContext,
  operation: string,
  details: { target?: string; message?: string; result?: unknown },
): Promise<MethodResult> {
  const handle = await context.writeResource(
    "operation",
    inst("op", `${operation}-${Date.now()}`),
    {
      operation,
      target: details.target,
      message: details.message,
      result: details.result,
      ranAt: new Date().toISOString(),
    },
  );
  return { dataHandles: [handle] };
}
