/**
 * The `@nblair2/phenix/cluster` model: deployment-wide, mostly read-only views
 * of a phenix cluster and server — cluster hosts, disk images, the available
 * apps / topologies / scenarios, server version and feature flags, and
 * settings. These are not scoped to a single experiment. Connection details are
 * configured once via the model's global arguments; the HTTP client and shared
 * plumbing live in `./_lib/`.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  applicationsFromData,
  DiskSchema,
  disksFromData,
  GlobalArgsSchema,
  HostSchema,
  hostsFromData,
  topologiesFromData,
} from "./_lib/phenix.ts";
import {
  clientFor,
  type MethodResult,
  type ModelContext,
  operationSchema,
  writeList,
  writeOperation,
} from "./_lib/model.ts";

const TopologyScenariosArgs = z.object({
  topology: z.string().min(1).describe("Topology name"),
});

const methods = {
  host_list: {
    description: "List the cluster hosts (head and compute nodes)",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
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
  },

  disk_list: {
    description: "List the disk images available on the cluster",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
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
  },

  application_list: {
    description: "List the phenix apps available on the server",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/applications");
      return writeOperation(context, "application_list", {
        result: applicationsFromData(res.body),
      });
    },
  },

  topology_list: {
    description: "List the available Topology configs",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/topologies");
      return writeOperation(context, "topology_list", {
        result: topologiesFromData(res.body),
      });
    },
  },

  topology_scenarios: {
    description: "List the scenarios compatible with a given topology",
    arguments: TopologyScenariosArgs,
    execute: async (
      args: z.infer<typeof TopologyScenariosArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/topologies/${encodeURIComponent(args.topology)}/scenarios`,
      );
      return writeOperation(context, "topology_scenarios", {
        target: args.topology,
        result: res.body,
      });
    },
  },

  version: {
    description: "Read the phenix server version",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/version");
      return writeOperation(context, "version", { result: res.body });
    },
  },

  features: {
    description: "Read the phenix server's enabled feature flags",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/features");
      return writeOperation(context, "features", { result: res.body });
    },
  },

  settings_get: {
    description: "Read the phenix server settings",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/settings");
      return writeOperation(context, "settings_get", { result: res.body });
    },
  },
};

/** The `@nblair2/phenix/cluster` model. */
export const model = {
  type: "@nblair2/phenix/cluster",
  version: "2026.05.30.2",
  globalArguments: GlobalArgsSchema,
  resources: {
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
    operation: {
      description:
        "Outcome of a one-shot phenix read (apps, topologies, version, etc.)",
      schema: operationSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods,
};
