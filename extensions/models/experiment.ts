/**
 * The `@nblair2/phenix/experiment` model: the experiment lifecycle — list / get
 * / create / delete, start / stop — and the surrounding read-and-control
 * endpoints (apps, schedule, topology, files, trigger). Mutating endpoints
 * reply `204` and broadcast state over a websocket, so these methods re-`GET`
 * the experiment to capture and store its current state. Connection details are
 * configured once via the model's global arguments; the HTTP client and shared
 * plumbing live in `./_lib/`.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  asObject,
  ExperimentSchema,
  experimentsFromData,
  GlobalArgsSchema,
  type PhenixClient,
} from "./_lib/phenix.ts";
import {
  clientFor,
  inst,
  type MethodResult,
  type ModelContext,
  operationSchema,
  writeList,
  writeOperation,
} from "./_lib/model.ts";

const PREFIX = "experiment";

/** Re-read an experiment by name and store it; returns the write result. */
async function storeExperiment(
  client: PhenixClient,
  context: ModelContext,
  name: string,
): Promise<MethodResult> {
  const res = await client.get(
    `/api/v1/experiments/${encodeURIComponent(name)}`,
    { allowStatuses: [404] },
  );
  const exp = Object.keys(asObject(res.body)).length > 0
    ? asObject(res.body)
    : { name };
  const handle = await context.writeResource(
    "experiment",
    inst(PREFIX, name),
    exp,
  );
  return { dataHandles: [handle] };
}

const NameArg = z.object({
  name: z.string().min(1).describe("Experiment name"),
});

// Experiment-name rules mirror upstream phenix (sandialabs/sceptre-phenix):
//   - charset: every config kind (incl. Experiment) is validated server-side
//     against `^[a-zA-Z0-9_@.-]*$` (api/config/config.go: `NameRegex`).
//   - length: in "auto bridge mode" the name doubles as the minimega bridge
//     name and is capped at 15 chars (api/experiment/experiment.go:
//     `maxNameLength`). The cap is server-config-dependent; we apply it here so
//     creates fail fast on auto-bridge servers (the common default).
//   - reserved: the API rejects "all"; the web UI also blocks "create".
const NAME_RE = /^[a-zA-Z0-9_@.-]+$/;
const RESERVED_NAMES = new Set(["all", "create"]);

const CreateArgs = z.object({
  name: z.string()
    .min(1)
    .max(15)
    .regex(NAME_RE, "name may contain only letters, digits, and _ @ . -")
    .refine(
      (n) => !RESERVED_NAMES.has(n.toLowerCase()),
      "experiment name must not be a reserved word ('all' or 'create')",
    )
    .describe(
      "Unique experiment name (≤15 chars; letters, digits, and _ @ . -)",
    ),
  topology: z.string().min(1).describe("Name of the Topology config to use"),
  scenario: z.string().optional().describe(
    "Name of the Scenario config to apply (optional)",
  ),
  vlanMin: z.number().int().optional().describe("Low end of the VLAN range"),
  vlanMax: z.number().int().optional().describe("High end of the VLAN range"),
  disabledApps: z.array(z.string()).optional().describe(
    "Scenario apps to disable for this experiment",
  ),
  deployMode: z.string().optional().describe(
    "Deploy mode (e.g. 'all', 'no-headnode', 'only-headnode')",
  ),
  defaultBridge: z.string().optional().describe(
    "Default minimega bridge name",
  ),
  useGreMesh: z.boolean().optional().describe(
    "Use a GRE mesh between cluster nodes",
  ),
});

const ScheduleArgs = z.object({
  name: z.string().min(1).describe("Experiment name"),
  algorithm: z.string().min(1).describe(
    "Scheduling algorithm (e.g. 'round-robin', 'isolate-experiment')",
  ),
});

const TriggerArgs = z.object({
  name: z.string().min(1).describe("Experiment name"),
  apps: z.array(z.string()).optional().describe(
    "Specific apps to (re)trigger; omit to trigger all",
  ),
});

/** Build the create request body from validated arguments. */
function createBody(a: z.infer<typeof CreateArgs>): Record<string, unknown> {
  const body: Record<string, unknown> = { name: a.name, topology: a.topology };
  if (a.scenario !== undefined) body.scenario = a.scenario;
  if (a.vlanMin !== undefined) body.vlan_min = a.vlanMin;
  if (a.vlanMax !== undefined) body.vlan_max = a.vlanMax;
  if (a.disabledApps !== undefined) body.disabled_apps = a.disabledApps;
  if (a.deployMode !== undefined) body.deploy_mode = a.deployMode;
  if (a.defaultBridge !== undefined) body.default_bridge = a.defaultBridge;
  if (a.useGreMesh !== undefined) body.use_gre_mesh = a.useGreMesh;
  return body;
}

const methods = {
  experiment_list: {
    description: "List all experiments, storing each one",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/experiments");
      const handles = await writeList(
        context,
        "experiment",
        PREFIX,
        experimentsFromData(res.body),
      );
      return { dataHandles: handles };
    },
  },

  experiment_get: {
    description: "Fetch a single experiment by name and store its state",
    arguments: NameArg,
    execute: async (
      args: z.infer<typeof NameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      return storeExperiment(client, context, args.name);
    },
  },

  experiment_create: {
    description:
      "Create an experiment from a topology (and optional scenario). " +
      "Does not start it.",
    arguments: CreateArgs,
    execute: async (
      args: z.infer<typeof CreateArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.post("/api/v1/experiments", createBody(args));
      // Create replies 204 (state via websocket); re-read to capture it.
      return storeExperiment(client, context, args.name);
    },
  },

  experiment_delete: {
    description: "Delete an experiment (must be stopped)",
    arguments: NameArg,
    execute: async (
      args: z.infer<typeof NameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.del(`/api/v1/experiments/${encodeURIComponent(args.name)}`);
      return { dataHandles: [] };
    },
  },

  experiment_start: {
    description: "Start (launch) an experiment, then store its updated state",
    arguments: NameArg,
    execute: async (
      args: z.infer<typeof NameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.post(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/start`,
      );
      return storeExperiment(client, context, args.name);
    },
  },

  experiment_stop: {
    description: "Stop (tear down) a running experiment, then store its state",
    arguments: NameArg,
    execute: async (
      args: z.infer<typeof NameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.post(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/stop`,
      );
      return storeExperiment(client, context, args.name);
    },
  },

  experiment_apps: {
    description: "List the apps configured for an experiment",
    arguments: NameArg,
    execute: async (
      args: z.infer<typeof NameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/apps`,
      );
      return writeOperation(context, "experiment_apps", {
        target: args.name,
        result: res.body,
      });
    },
  },

  experiment_schedule_get: {
    description: "Read the current VM-placement schedule for an experiment",
    arguments: NameArg,
    execute: async (
      args: z.infer<typeof NameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/schedule`,
      );
      return writeOperation(context, "experiment_schedule", {
        target: args.name,
        result: res.body,
      });
    },
  },

  experiment_schedule_set: {
    description: "Apply a scheduling algorithm to place an experiment's VMs",
    arguments: ScheduleArgs,
    execute: async (
      args: z.infer<typeof ScheduleArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.post(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/schedule`,
        { algorithm: args.algorithm },
      );
      return writeOperation(context, "experiment_schedule_set", {
        target: args.name,
        message: args.algorithm,
        result: res.body,
      });
    },
  },

  experiment_topology: {
    description: "Fetch the (expanded) topology of an experiment",
    arguments: NameArg,
    execute: async (
      args: z.infer<typeof NameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/topology`,
      );
      return writeOperation(context, "experiment_topology", {
        target: args.name,
        result: res.body,
      });
    },
  },

  experiment_files: {
    description: "List the files associated with an experiment",
    arguments: NameArg,
    execute: async (
      args: z.infer<typeof NameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/files`,
      );
      return writeOperation(context, "experiment_files", {
        target: args.name,
        result: res.body,
      });
    },
  },

  experiment_trigger: {
    description: "Trigger (re-run) running-stage apps for an experiment",
    arguments: TriggerArgs,
    execute: async (
      args: z.infer<typeof TriggerArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.post(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/trigger`,
        {},
        { query: args.apps ? { apps: args.apps } : undefined },
      );
      return writeOperation(context, "experiment_trigger", {
        target: args.name,
        result: res.body,
      });
    },
  },
};

/** The `@nblair2/phenix/experiment` model. */
export const model = {
  type: "@nblair2/phenix/experiment",
  version: "2026.05.31.5",
  globalArguments: GlobalArgsSchema,
  resources: {
    experiment: {
      description: "A phenix experiment and its current lifecycle state",
      schema: ExperimentSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    operation: {
      description:
        "Outcome of a one-shot phenix action (schedule, trigger, apps, etc.)",
      schema: operationSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods,
};
