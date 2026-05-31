/**
 * Cluster- and server-level reads for the `@nblair2/phenix` model: cluster
 * hosts, disk images, the global VM listing, available apps / topologies /
 * scenarios, server version and feature flags, and settings. These are mostly
 * read-only views of the phenix deployment as a whole (not scoped to one
 * experiment).
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  applicationsFromData,
  DiskSchema,
  disksFromData,
  HostSchema,
  hostsFromData,
  topologiesFromData,
  vmsFromData,
} from "../_lib/phenix.ts";
import {
  clientFor,
  defineMethod,
  inst,
  type MethodDef,
  type MethodResult,
  operationResource,
  type ResourceSpec,
  writeList,
  writeOperation,
} from "../_lib/model.ts";

const TopologyScenariosArgs = z.object({
  topology: z.string().min(1).describe("Topology name"),
});

/** Resource specs owned by this group. */
export const resources: Record<string, ResourceSpec> = {
  host: {
    description: "A phenix cluster host (head or compute node)",
    schema: HostSchema,
    lifetime: "7d",
    garbageCollection: 20,
  },
  disk: {
    description: "A disk image known to the phenix cluster",
    schema: DiskSchema,
    lifetime: "7d",
    garbageCollection: 20,
  },
  operation: operationResource,
};

/** Methods contributed by this group. */
export const methods: Record<string, MethodDef> = {
  host_list: defineMethod({
    description: "List the cluster hosts (head and compute nodes)",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/hosts");
      const handles = await writeList(
        context,
        "host",
        "host",
        hostsFromData(res.body),
      );
      return { dataHandles: handles };
    },
  }),

  disk_list: defineMethod({
    description: "List the disk images available on the cluster",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/disks");
      const handles = await writeList(
        context,
        "disk",
        "disk",
        disksFromData(res.body),
      );
      return { dataHandles: handles };
    },
  }),

  vm_list_all: defineMethod({
    description:
      "List every VM across all experiments, storing each as a `vm` resource",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/vms");
      const handles = [];
      for (const vm of vmsFromData(res.body)) {
        const exp = typeof vm.experiment === "string" ? vm.experiment : "_";
        const name = typeof vm.name === "string" ? vm.name : "unknown";
        handles.push(
          await context.writeResource("vm", inst("vm", `${exp}-${name}`), vm),
        );
      }
      return { dataHandles: handles };
    },
  }),

  application_list: defineMethod({
    description: "List the phenix apps available on the server",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/applications");
      return writeOperation(context, "application_list", {
        result: applicationsFromData(res.body),
      });
    },
  }),

  topology_list: defineMethod({
    description: "List the available Topology configs",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/topologies");
      return writeOperation(context, "topology_list", {
        result: topologiesFromData(res.body),
      });
    },
  }),

  topology_scenarios: defineMethod({
    description: "List the scenarios compatible with a given topology",
    arguments: TopologyScenariosArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/topologies/${encodeURIComponent(args.topology)}/scenarios`,
      );
      return writeOperation(context, "topology_scenarios", {
        target: args.topology,
        result: res.body,
      });
    },
  }),

  version: defineMethod({
    description: "Read the phenix server version",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/version");
      return writeOperation(context, "version", { result: res.body });
    },
  }),

  features: defineMethod({
    description: "Read the phenix server's enabled feature flags",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/features");
      return writeOperation(context, "features", { result: res.body });
    },
  }),

  settings_get: defineMethod({
    description: "Read the phenix server settings",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/settings");
      return writeOperation(context, "settings_get", { result: res.body });
    },
  }),
};
