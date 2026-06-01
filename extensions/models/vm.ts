/**
 * The `@nblair2/phenix/vm` model: VM control across phenix experiments —
 * inventory (list / get, plus `vm_list_all` across every experiment),
 * reconfiguration (update / redeploy), power state
 * (start / stop / shutdown / restart / reset), and disk/capture operations
 * (snapshots, commit, packet captures). VM state is stored keyed by
 * `<experiment>-<vm>`. Connection details are configured once via the model's
 * global arguments; the HTTP client and shared plumbing live in `./_lib/`.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  asObject,
  GlobalArgsSchema,
  type PhenixClient,
  VMSchema,
  vmsFromData,
} from "./_lib/phenix.ts";
import {
  clientFor,
  inst,
  type MethodResult,
  type ModelContext,
  operationSchema,
  writeOperation,
} from "./_lib/model.ts";

const PREFIX = "vm";

/** Path to a single VM under an experiment. */
function vmPath(exp: string, name: string): string {
  return `/api/v1/experiments/${encodeURIComponent(exp)}/vms/${
    encodeURIComponent(name)
  }`;
}

/** Store a VM object keyed by `<exp>-<name>`. */
function writeVM(
  context: ModelContext,
  exp: string,
  vm: Record<string, unknown>,
): Promise<{ name: string; specName: string; kind: string }> {
  const name = typeof vm.name === "string" ? vm.name : "unknown";
  return context.writeResource("vm", inst(PREFIX, `${exp}-${name}`), vm);
}

/**
 * Store the VM returned by a mutation, re-reading it when the response body was
 * empty (e.g. a `204`), so stored state always reflects the operation.
 */
async function storeVMResult(
  client: PhenixClient,
  context: ModelContext,
  exp: string,
  name: string,
  body: unknown,
): Promise<MethodResult> {
  let vm = asObject(body);
  if (typeof vm.name !== "string") {
    const res = await client.get(vmPath(exp, name), { allowStatuses: [404] });
    vm = asObject(res.body);
  }
  if (typeof vm.name !== "string") vm = { name };
  const handle = await writeVM(context, exp, vm);
  return { dataHandles: [handle] };
}

const ExpArg = z.object({
  exp: z.string().min(1).describe("Experiment name"),
});

const ExpVMArgs = z.object({
  exp: z.string().min(1).describe("Experiment name"),
  name: z.string().min(1).describe("VM name"),
});

const UpdateArgs = z.object({
  exp: z.string().min(1).describe("Experiment name"),
  name: z.string().min(1).describe("VM name"),
  cpus: z.number().int().positive().optional().describe("Number of vCPUs"),
  ram: z.number().int().positive().optional().describe("RAM in MB"),
  disk: z.string().optional().describe("Disk image path"),
  dnb: z.boolean().optional().describe("Set the do-not-boot flag"),
  host: z.string().optional().describe("Pin the VM to a cluster host"),
  snapshot: z.boolean().optional().describe("Run the disk in snapshot mode"),
  interface: z.object({
    index: z.number().int().nonnegative(),
    vlan: z.string(),
  }).optional().describe("Connect interface {index} to a {vlan}"),
  tags: z.record(z.string(), z.string()).optional().describe(
    "Tags to set on the VM",
  ),
});

const RedeployArgs = z.object({
  exp: z.string().min(1).describe("Experiment name"),
  name: z.string().min(1).describe("VM name"),
  cpus: z.number().int().positive().optional().describe("Number of vCPUs"),
  ram: z.number().int().positive().optional().describe("RAM in MB"),
  disk: z.string().optional().describe("Disk image path"),
  injects: z.boolean().optional().describe("Re-run file injections"),
});

const SnapshotArgs = z.object({
  exp: z.string().min(1).describe("Experiment name"),
  name: z.string().min(1).describe("VM name"),
  filename: z.string().min(1).describe("Snapshot filename"),
});

const RestoreArgs = z.object({
  exp: z.string().min(1).describe("Experiment name"),
  name: z.string().min(1).describe("VM name"),
  snapshot: z.string().min(1).describe("Snapshot name to restore"),
});

const CaptureArgs = z.object({
  exp: z.string().min(1).describe("Experiment name"),
  name: z.string().min(1).describe("VM name"),
  interface: z.number().int().nonnegative().describe(
    "Interface index to capture on",
  ),
  filter: z.string().optional().describe("Optional BPF capture filter"),
});

/** Build the PATCH body for vm_update from set fields. */
function updateBody(a: z.infer<typeof UpdateArgs>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (a.cpus !== undefined) body.cpus = a.cpus;
  if (a.ram !== undefined) body.ram = a.ram;
  if (a.disk !== undefined) body.disk = a.disk;
  if (a.dnb !== undefined) body.dnb = a.dnb;
  if (a.host !== undefined) body.host = a.host;
  if (a.snapshot !== undefined) body.snapshot = a.snapshot;
  if (a.interface !== undefined) body.interface = a.interface;
  if (a.tags !== undefined) body.tags = a.tags;
  return body;
}

const methods = {
  vm_list: {
    description: "List all VMs in an experiment, storing each one",
    arguments: ExpArg,
    execute: async (
      args: z.infer<typeof ExpArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/experiments/${encodeURIComponent(args.exp)}/vms`,
      );
      const handles = [];
      for (const vm of vmsFromData(res.body)) {
        handles.push(await writeVM(context, args.exp, vm));
      }
      return { dataHandles: handles };
    },
  },

  vm_list_all: {
    description:
      "List every VM across all experiments, storing each as a `vm` resource",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/vms");
      const handles = [];
      for (const vm of vmsFromData(res.body)) {
        const exp = typeof vm.experiment === "string" ? vm.experiment : "_";
        handles.push(await writeVM(context, exp, vm));
      }
      return { dataHandles: handles };
    },
  },

  vm_get: {
    description: "Fetch a single VM by name and store its state",
    arguments: ExpVMArgs,
    execute: async (
      args: z.infer<typeof ExpVMArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(vmPath(args.exp, args.name));
      const handle = await writeVM(context, args.exp, asObject(res.body));
      return { dataHandles: [handle] };
    },
  },

  vm_update: {
    description:
      "Update a VM's CPUs/RAM/disk, do-not-boot flag, host pin, snapshot " +
      "mode, an interface VLAN, or tags",
    arguments: UpdateArgs,
    execute: async (
      args: z.infer<typeof UpdateArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body = updateBody(args);
      if (Object.keys(body).length === 0) {
        throw new Error("no changes provided to vm_update");
      }
      const res = await client.patch(vmPath(args.exp, args.name), body);
      return storeVMResult(client, context, args.exp, args.name, res.body);
    },
  },

  vm_start: {
    description: "Boot a VM, then store its updated state",
    arguments: ExpVMArgs,
    execute: async (
      args: z.infer<typeof ExpVMArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.post(`${vmPath(args.exp, args.name)}/start`);
      return storeVMResult(client, context, args.exp, args.name, res.body);
    },
  },

  vm_stop: {
    description: "Power off (pause) a VM, then store its updated state",
    arguments: ExpVMArgs,
    execute: async (
      args: z.infer<typeof ExpVMArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.post(`${vmPath(args.exp, args.name)}/stop`);
      return storeVMResult(client, context, args.exp, args.name, res.body);
    },
  },

  vm_shutdown: {
    description: "Gracefully shut down a VM's guest OS, then store its state",
    arguments: ExpVMArgs,
    execute: async (
      args: z.infer<typeof ExpVMArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(`${vmPath(args.exp, args.name)}/shutdown`);
      return storeVMResult(client, context, args.exp, args.name, res.body);
    },
  },

  vm_restart: {
    description: "Restart a VM, then store its updated state",
    arguments: ExpVMArgs,
    execute: async (
      args: z.infer<typeof ExpVMArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(`${vmPath(args.exp, args.name)}/restart`);
      return storeVMResult(client, context, args.exp, args.name, res.body);
    },
  },

  vm_reset: {
    description: "Hard-reset a VM, then store its updated state",
    arguments: ExpVMArgs,
    execute: async (
      args: z.infer<typeof ExpVMArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(`${vmPath(args.exp, args.name)}/reset`);
      return storeVMResult(client, context, args.exp, args.name, res.body);
    },
  },

  vm_redeploy: {
    description:
      "Redeploy a VM (optionally with new CPUs/RAM/disk and re-injection)",
    arguments: RedeployArgs,
    execute: async (
      args: z.infer<typeof RedeployArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body: Record<string, unknown> = { name: args.name };
      if (args.cpus !== undefined) body.cpus = args.cpus;
      if (args.ram !== undefined) body.ram = args.ram;
      if (args.disk !== undefined) body.disk = args.disk;
      if (args.injects !== undefined) body.injects = args.injects;
      const res = await client.post(
        `${vmPath(args.exp, args.name)}/redeploy`,
        body,
      );
      return storeVMResult(client, context, args.exp, args.name, res.body);
    },
  },

  vm_snapshot_list: {
    description: "List the disk snapshots available for a VM",
    arguments: ExpVMArgs,
    execute: async (
      args: z.infer<typeof ExpVMArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(`${vmPath(args.exp, args.name)}/snapshots`);
      return writeOperation(context, "vm_snapshot_list", {
        target: `${args.exp}/${args.name}`,
        result: res.body,
      });
    },
  },

  vm_snapshot_create: {
    description: "Create a disk snapshot of a VM",
    arguments: SnapshotArgs,
    execute: async (
      args: z.infer<typeof SnapshotArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.post(
        `${vmPath(args.exp, args.name)}/snapshots`,
        { filename: args.filename },
      );
      return writeOperation(context, "vm_snapshot_create", {
        target: `${args.exp}/${args.name}`,
        message: args.filename,
        result: res.body,
      });
    },
  },

  vm_snapshot_restore: {
    description: "Restore a VM from a named disk snapshot",
    arguments: RestoreArgs,
    execute: async (
      args: z.infer<typeof RestoreArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.post(
        `${vmPath(args.exp, args.name)}/snapshots/${
          encodeURIComponent(args.snapshot)
        }`,
      );
      return writeOperation(context, "vm_snapshot_restore", {
        target: `${args.exp}/${args.name}`,
        message: args.snapshot,
        result: res.body,
      });
    },
  },

  vm_commit: {
    description: "Commit a VM's current disk state to a new backing image",
    arguments: ExpVMArgs,
    execute: async (
      args: z.infer<typeof ExpVMArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.post(`${vmPath(args.exp, args.name)}/commit`);
      return writeOperation(context, "vm_commit", {
        target: `${args.exp}/${args.name}`,
        result: res.body,
      });
    },
  },

  vm_capture_start: {
    description: "Start a packet capture on a VM interface",
    arguments: CaptureArgs,
    execute: async (
      args: z.infer<typeof CaptureArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body: Record<string, unknown> = { interface: args.interface };
      if (args.filter !== undefined) body.filter = args.filter;
      const res = await client.post(
        `${vmPath(args.exp, args.name)}/captures`,
        body,
      );
      return writeOperation(context, "vm_capture_start", {
        target: `${args.exp}/${args.name}`,
        result: res.body,
      });
    },
  },

  vm_capture_stop: {
    description: "Stop all packet captures on a VM",
    arguments: ExpVMArgs,
    execute: async (
      args: z.infer<typeof ExpVMArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.del(`${vmPath(args.exp, args.name)}/captures`);
      return writeOperation(context, "vm_capture_stop", {
        target: `${args.exp}/${args.name}`,
        result: res.body,
      });
    },
  },
};

/** The `@nblair2/phenix/vm` model. */
export const model = {
  type: "@nblair2/phenix/vm",
  version: "2026.05.31.7",
  globalArguments: GlobalArgsSchema,
  resources: {
    vm: {
      description: "A VM within a phenix experiment and its current state",
      schema: VMSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    operation: {
      description:
        "Outcome of a one-shot phenix action (snapshot, commit, capture, etc.)",
      schema: operationSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods,
};
