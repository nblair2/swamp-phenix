/**
 * Swamp model for sceptre-phenix, Sandia's minimega-based network-emulation
 * orchestrator.
 *
 * A single model type (`@nblair2/phenix`) exposes the phenix HTTP API as
 * methods — generic config CRUD (Topology / Scenario / Experiment / Image /
 * User), the experiment lifecycle (create / start / stop / delete plus
 * schedule, apps, topology, files, trigger), per-experiment VM control
 * (inventory, reconfigure, power, snapshots, captures), and cluster/server
 * reads (hosts, disks, apps, topologies, version, features, settings) and
 * identity (users, roles, tokens). Connection and credentials are configured
 * once via the model's global arguments. The methods and resources are
 * assembled here from the per-domain modules under `./_groups/`.
 *
 * @module
 */
import { GlobalArgsSchema } from "./_lib/phenix.ts";
import type { MethodDef, ResourceSpec } from "./_lib/model.ts";
import {
  methods as configMethods,
  resources as configResources,
} from "./_groups/configs.ts";
import {
  methods as experimentMethods,
  resources as experimentResources,
} from "./_groups/experiments.ts";
import {
  methods as vmMethods,
  resources as vmResources,
} from "./_groups/vms.ts";
import {
  methods as clusterMethods,
  resources as clusterResources,
} from "./_groups/cluster.ts";
import {
  methods as userMethods,
  resources as userResources,
} from "./_groups/users.ts";

/** Every resource spec across the model, keyed by spec name. */
const resources: Record<string, ResourceSpec> = {
  ...configResources,
  ...experimentResources,
  ...vmResources,
  ...clusterResources,
  ...userResources,
};

/** Every method across the model, keyed by method name. */
const methods: Record<string, MethodDef> = {
  ...configMethods,
  ...experimentMethods,
  ...vmMethods,
  ...clusterMethods,
  ...userMethods,
};

/**
 * The `@nblair2/phenix` model: drives a sceptre-phenix deployment across its
 * config, experiment, VM, cluster and identity surface. See the `_groups/`
 * modules for the per-domain method implementations.
 */
export const model = {
  type: "@nblair2/phenix",
  version: "2026.05.30.1",
  globalArguments: GlobalArgsSchema,
  resources,
  methods,
};
