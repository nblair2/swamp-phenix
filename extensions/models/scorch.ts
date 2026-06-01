/**
 * The `@nblair2/phenix/scorch` model: drive scorch runs (phenix's
 * scenario/attack pipeline executor) over the HTTP API — start a run and
 * optionally poll it to completion, read pipeline status, cancel a run, and list
 * a run's output tarballs.
 *
 * Starting a run is asynchronous: `POST …/scorch/pipelines/{run}` replies `204`
 * and executes in the background. Completion is detected by polling two signals:
 * the per-run pipeline DAG (`GET …/scorch/pipelines/{run}/{loop}`), whose
 * terminal `done` node reports `success`/`failure`, and the experiment-level
 * pipelines list (`GET …/scorch/pipelines`), whose `running` field is the active
 * run id or `-1` when idle. `scorch_run` deliberately does **not** throw when a
 * run ends in `failure` — a failed attack inject can still have produced the
 * result tarball we want — only on a transport error or a poll timeout.
 *
 * Connection details come from the model's global arguments; the HTTP client and
 * shared plumbing live in `./_lib/`.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import { asObject, GlobalArgsSchema, listFrom } from "./_lib/phenix.ts";
import {
  clientFor,
  inst,
  type MethodResult,
  type ModelContext,
  operationSchema,
  writeOperation,
} from "./_lib/model.ts";

const PREFIX = "scorch";

/** Pipeline `done`-node statuses that mean the run has finished. */
const TERMINAL = new Set(["success", "failure"]);

/** The recorded outcome of a single scorch run. */
const ScorchRunSchema = z.object({
  experiment: z.string(),
  run: z.number().int(),
  loop: z.number().int(),
  /** `success` | `failure` | `unknown` (finished but status unread). */
  status: z.string(),
  started: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationSec: z.number().optional(),
  waited: z.boolean(),
}).passthrough();

// Tunables are `.optional()` (not `.default()`) so swamp does not mark them
// `required` in the method's JSON-Schema — a workflow step can pass just
// `name`+`run`. Defaults are applied in `execute` below.
const RunArgs = z.object({
  name: z.string().min(1).describe("Experiment name"),
  run: z.number().int().min(0).describe("Scorch run index to execute"),
  loop: z.number().int().min(0).optional().describe(
    "Pipeline loop index to watch for completion (default 0)",
  ),
  waitForCompletion: z.boolean().optional().describe(
    "Poll until the run reaches a terminal state before returning " +
      "(default true)",
  ),
  intervalSec: z.number().int().min(0).optional().describe(
    "Seconds between completion polls (default 15)",
  ),
  timeoutSec: z.number().int().min(1).optional().describe(
    "Give up and throw after this many seconds without completion " +
      "(default 3600; a single run can exceed 30 min)",
  ),
});

const NameArg = z.object({
  name: z.string().min(1).describe("Experiment name"),
});

const CancelArgs = z.object({
  name: z.string().min(1).describe("Experiment name"),
  run: z.number().int().min(0).describe("Scorch run index to cancel"),
});

const FilesArgs = z.object({
  name: z.string().min(1).describe("Experiment name"),
  run: z.number().int().min(0).optional().describe(
    "Restrict to a single run's artifacts (matches the 'run-N' category)",
  ),
});

/** Sleep helper; in tests an `intervalSec` of 0 makes this a microtask. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `/api/v1/experiments/{name}/scorch` for `name`. */
function scorchBase(name: string): string {
  return `/api/v1/experiments/${encodeURIComponent(name)}/scorch`;
}

/** Parse the `running` field (active run id, or -1/none) from a pipelines list. */
function parseRunning(body: unknown): number | null {
  const r = asObject(body).running;
  return typeof r === "number" ? r : null;
}

/** The terminal `done` node's status in a pipeline DAG response, if present. */
function doneStatus(body: unknown): string | null {
  const o = asObject(body);
  const nodes = Array.isArray(o.pipeline)
    ? o.pipeline
    : Array.isArray(body)
    ? body
    : [];
  for (const n of nodes as Record<string, unknown>[]) {
    if (n && typeof n === "object" && n.name === "done") {
      return typeof n.status === "string" ? n.status : null;
    }
  }
  return null;
}

const methods = {
  scorch_run: {
    description:
      "Start a scorch run and (by default) poll it to completion. Records the " +
      "run's terminal status; throws only on transport error or timeout, not " +
      "on a scorch failure (a failed run may still have produced output).",
    arguments: RunArgs,
    execute: async (
      args: z.infer<typeof RunArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const base = scorchBase(args.name);
      const loop = args.loop ?? 0;
      const waitForCompletion = args.waitForCompletion ?? true;
      const intervalSec = args.intervalSec ?? 15;
      const timeoutSec = args.timeoutSec ?? 3600;

      // Idempotent start: only POST if this run is not already executing.
      const pre = await client.get(`${base}/pipelines`, {
        allowStatuses: [404],
      });
      let started = parseRunning(pre.body) === args.run;
      if (!started) {
        await client.post(`${base}/pipelines/${args.run}`);
      }
      const startedAt = new Date().toISOString();

      let status = "unknown";
      if (waitForCompletion) {
        const deadline = Date.now() + timeoutSec * 1000;
        let done = false;
        while (Date.now() < deadline) {
          // Most direct signal: the per-run DAG's terminal `done` node.
          const dag = await client.get(
            `${base}/pipelines/${args.run}/${loop}`,
            { allowStatuses: [404] },
          );
          const ds = doneStatus(dag.body);
          if (ds && TERMINAL.has(ds)) {
            status = ds;
            done = true;
            break;
          }
          // Cross-check: experiment-level running flag. Once we have seen this
          // run active and it is no longer active, it has finished.
          const list = await client.get(`${base}/pipelines`, {
            allowStatuses: [404],
          });
          const running = parseRunning(list.body);
          if (running === args.run) {
            started = true;
          } else if (started) {
            status = ds ?? "unknown";
            done = true;
            break;
          }
          await sleep(intervalSec * 1000);
        }
        if (!done) {
          throw new Error(
            `scorch run ${args.run} for '${args.name}' did not reach a ` +
              `terminal state within ${timeoutSec}s`,
          );
        }
      }

      const finishedAt = new Date().toISOString();
      const handle = await context.writeResource(
        "scorchRun",
        inst(PREFIX, `${args.name}-run${args.run}`),
        {
          experiment: args.name,
          run: args.run,
          loop,
          status,
          started,
          startedAt,
          finishedAt,
          durationSec: Math.round(
            (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000,
          ),
          waited: waitForCompletion,
        },
      );
      return { dataHandles: [handle] };
    },
  },

  scorch_status: {
    description:
      "Read the scorch pipeline status for an experiment (which run, if any, " +
      "is currently executing)",
    arguments: NameArg,
    execute: async (
      args: z.infer<typeof NameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(`${scorchBase(args.name)}/pipelines`);
      return writeOperation(context, "scorch_status", {
        target: args.name,
        result: res.body,
      });
    },
  },

  scorch_cancel: {
    description: "Cancel a running scorch run",
    arguments: CancelArgs,
    execute: async (
      args: z.infer<typeof CancelArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.del(`${scorchBase(args.name)}/pipelines/${args.run}`);
      return writeOperation(context, "scorch_cancel", {
        target: args.name,
        message: `run ${args.run}`,
      });
    },
  },

  scorch_files: {
    description:
      "List a scorch run's output tarballs (name + size) from the experiment " +
      "files endpoint, filtered to scorch '.tgz' artifacts",
    arguments: FilesArgs,
    execute: async (
      args: z.infer<typeof FilesArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/files`,
      );
      const files = listFrom(res.body, "files");
      const wanted = files
        .filter((f) => {
          const name = typeof f.name === "string" ? f.name : "";
          const cats = Array.isArray(f.categories)
            ? (f.categories as unknown[])
            : [];
          if (!name.endsWith(".tgz") || !cats.includes("Scorch Artifact")) {
            return false;
          }
          return args.run === undefined || cats.includes(`run-${args.run}`);
        })
        .map((f) => ({
          name: f.name,
          size: f.size,
          path: f.path,
          date: f.date,
          categories: f.categories,
        }));
      return writeOperation(context, "scorch_files", {
        target: args.name,
        message: args.run !== undefined ? `run ${args.run}` : undefined,
        result: { files: wanted, count: wanted.length },
      });
    },
  },
};

/** The `@nblair2/phenix/scorch` model. */
export const model = {
  type: "@nblair2/phenix/scorch",
  version: "2026.05.31.6",
  globalArguments: GlobalArgsSchema,
  resources: {
    scorchRun: {
      description: "The outcome of a scorch run (terminal status and timing)",
      schema: ScorchRunSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    operation: {
      description:
        "Outcome of a one-shot scorch read/action (status, cancel, files)",
      schema: operationSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods,
};
