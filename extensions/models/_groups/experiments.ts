/**
 * Experiment lifecycle for the `@nblair2/phenix` model: list / get / create /
 * delete, start / stop, and the surrounding read-and-control endpoints
 * (apps, schedule, topology, files, trigger). Mutating endpoints reply `204`
 * and broadcast state over a websocket, so this group re-`GET`s the experiment
 * to capture and store its current state.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  asObject,
  ExperimentSchema,
  type PhenixClient,
} from "../_lib/phenix.ts";
import {
  clientFor,
  inst,
  type MethodDef,
  type MethodResult,
  type ModelContext,
  operationResource,
  type ResourceSpec,
  writeList,
  writeOperation,
} from "../_lib/model.ts";
import { defineMethod } from "../_lib/model.ts";
import { experimentsFromData } from "../_lib/phenix.ts";

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

const CreateArgs = z.object({
  name: z.string().min(1).describe("Unique experiment name"),
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

/** Resource specs owned by this group. */
export const resources: Record<string, ResourceSpec> = {
  experiment: {
    description: "A phenix experiment and its current lifecycle state",
    schema: ExperimentSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
  operation: operationResource,
};

/** Methods contributed by this group. */
export const methods: Record<string, MethodDef> = {
  experiment_list: defineMethod({
    description: "List all experiments, storing each one",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
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
  }),

  experiment_get: defineMethod({
    description: "Fetch a single experiment by name and store its state",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      return storeExperiment(client, context, args.name);
    },
  }),

  experiment_create: defineMethod({
    description:
      "Create an experiment from a topology (and optional scenario). " +
      "Does not start it.",
    arguments: CreateArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.post("/api/v1/experiments", createBody(args));
      // Create replies 204 (state via websocket); re-read to capture it.
      return storeExperiment(client, context, args.name);
    },
  }),

  experiment_delete: defineMethod({
    description: "Delete an experiment (must be stopped)",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.del(`/api/v1/experiments/${encodeURIComponent(args.name)}`);
      return { dataHandles: [] };
    },
  }),

  experiment_start: defineMethod({
    description: "Start (launch) an experiment, then store its updated state",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.post(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/start`,
      );
      return storeExperiment(client, context, args.name);
    },
  }),

  experiment_stop: defineMethod({
    description: "Stop (tear down) a running experiment, then store its state",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.post(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/stop`,
      );
      return storeExperiment(client, context, args.name);
    },
  }),

  experiment_apps: defineMethod({
    description: "List the apps configured for an experiment",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/apps`,
      );
      return writeOperation(context, "experiment_apps", {
        target: args.name,
        result: res.body,
      });
    },
  }),

  experiment_schedule_get: defineMethod({
    description: "Read the current VM-placement schedule for an experiment",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/schedule`,
      );
      return writeOperation(context, "experiment_schedule", {
        target: args.name,
        result: res.body,
      });
    },
  }),

  experiment_schedule_set: defineMethod({
    description: "Apply a scheduling algorithm to place an experiment's VMs",
    arguments: ScheduleArgs,
    execute: async (args, context): Promise<MethodResult> => {
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
  }),

  experiment_topology: defineMethod({
    description: "Fetch the (expanded) topology of an experiment",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/topology`,
      );
      return writeOperation(context, "experiment_topology", {
        target: args.name,
        result: res.body,
      });
    },
  }),

  experiment_files: defineMethod({
    description: "List the files associated with an experiment",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/experiments/${encodeURIComponent(args.name)}/files`,
      );
      return writeOperation(context, "experiment_files", {
        target: args.name,
        result: res.body,
      });
    },
  }),

  experiment_trigger: defineMethod({
    description: "Trigger (re-run) running-stage apps for an experiment",
    arguments: TriggerArgs,
    execute: async (args, context): Promise<MethodResult> => {
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
  }),
};
