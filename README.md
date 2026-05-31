# @nblair2/phenix

A [swamp](https://swamp.club/) model extension for
[sceptre-phenix](https://github.com/sandialabs/sceptre-phenix), Sandia's
minimega-based network-emulation and cyber-range orchestrator. It gives a swamp
agent control of a phenix deployment through its HTTP API: config objects
(Topology, Scenario, Experiment, Image, User), the experiment lifecycle, VM
control (power, reconfigure, snapshots, captures), cluster/server reads, and
identity (users, roles, tokens).

## What it does

The extension publishes **five models**, one per phenix domain. Each is
configured and invoked on its own, but all share the same connection/credential
schema (so they're configured the same way) and the same underlying HTTP client.

| Model                        | Covers                                                                    |
| ---------------------------- | ------------------------------------------------------------------------- |
| `@nblair2/phenix/config`     | CRUD over phenix config objects (Topology/Scenario/Experiment/Image/User) |
| `@nblair2/phenix/experiment` | The experiment lifecycle and its schedule/apps/topology/files/trigger     |
| `@nblair2/phenix/vm`         | VM inventory, reconfigure, power, snapshots, captures, commit             |
| `@nblair2/phenix/cluster`    | Deployment-wide reads: hosts, disks, apps/topologies, version, settings   |
| `@nblair2/phenix/user`       | Identity: UI users, RBAC roles, long-lived API tokens                     |

The API is rooted at `/api/v1` (plus a few root-level routes like `/version`).
Authentication is bearer-token: supply a pre-issued long-lived `token`, or a
`username`/`password` to log in via `POST /api/v1/login`; the JWT is then sent on
every request in the `X-Phenix-Auth-Token: Bearer <jwt>` header.

phenix has no response envelope — single resources come back as bare objects and
lists are wrapped (`{experiments: […]}`, `{vms: […]}`, …). Some mutating
endpoints reply `204 No Content` and broadcast the new state over a websocket,
so those methods re-`GET` the entity to capture and store its current state.

### `@nblair2/phenix/config`

| Method          | phenix endpoint                       | Description                                       |
| --------------- | ------------------------------------- | ------------------------------------------------- |
| `config_list`   | `GET /api/v1/configs`                 | List all configs, storing each                    |
| `config_get`    | `GET /api/v1/configs/:kind/:name`     | Fetch one config by kind and name                 |
| `config_create` | `POST /api/v1/configs`                | Create from an inline object or a YAML/JSON file  |
| `config_update` | `PUT /api/v1/configs/:kind/:name`     | Replace a config from an inline object or file    |
| `config_delete` | `DELETE /api/v1/configs/:kind/:name`  | Delete a config                                   |

### `@nblair2/phenix/experiment`

| Method                    | phenix endpoint                               | Description                                  |
| ------------------------- | --------------------------------------------- | -------------------------------------------- |
| `experiment_list`         | `GET /api/v1/experiments`                     | List all experiments                         |
| `experiment_get`          | `GET /api/v1/experiments/:name`               | Fetch one experiment                         |
| `experiment_create`       | `POST /api/v1/experiments`                    | Create from a topology (+ optional scenario) |
| `experiment_delete`       | `DELETE /api/v1/experiments/:name`            | Delete an experiment (must be stopped)       |
| `experiment_start` ⚠️     | `POST /api/v1/experiments/:name/start`        | Launch an experiment                         |
| `experiment_stop` ⚠️      | `POST /api/v1/experiments/:name/stop`         | Tear down a running experiment               |
| `experiment_apps`         | `GET /api/v1/experiments/:name/apps`          | List the experiment's apps                   |
| `experiment_schedule_get` | `GET /api/v1/experiments/:name/schedule`      | Read the VM-placement schedule               |
| `experiment_schedule_set` | `POST /api/v1/experiments/:name/schedule`     | Apply a scheduling algorithm                 |
| `experiment_topology`     | `GET /api/v1/experiments/:name/topology`      | Fetch the expanded topology                  |
| `experiment_files`        | `GET /api/v1/experiments/:name/files`         | List experiment files                        |
| `experiment_trigger`      | `POST /api/v1/experiments/:name/trigger`      | Re-trigger running-stage apps                |

### `@nblair2/phenix/vm`

| Method                 | phenix endpoint                                          | Description                          |
| ---------------------- | -------------------------------------------------------- | ------------------------------------ |
| `vm_list`              | `GET /api/v1/experiments/:exp/vms`                       | List all VMs in an experiment        |
| `vm_list_all`          | `GET /api/v1/vms`                                        | List every VM across all experiments |
| `vm_get`               | `GET /api/v1/experiments/:exp/vms/:name`                 | Fetch one VM                         |
| `vm_update` ⚠️         | `PATCH /api/v1/experiments/:exp/vms/:name`               | Change CPUs/RAM/disk/dnb/host/etc.   |
| `vm_start` ⚠️          | `POST .../vms/:name/start`                               | Boot a VM                            |
| `vm_stop` ⚠️           | `POST .../vms/:name/stop`                                | Power off (pause) a VM               |
| `vm_shutdown` ⚠️       | `GET .../vms/:name/shutdown`                             | Graceful guest-OS shutdown           |
| `vm_restart` ⚠️        | `GET .../vms/:name/restart`                              | Restart a VM                         |
| `vm_reset` ⚠️          | `GET .../vms/:name/reset`                                | Hard-reset a VM                      |
| `vm_redeploy` ⚠️       | `POST .../vms/:name/redeploy`                            | Redeploy (optionally re-spec'd)      |
| `vm_snapshot_list`     | `GET .../vms/:name/snapshots`                            | List disk snapshots                  |
| `vm_snapshot_create` ⚠️| `POST .../vms/:name/snapshots`                           | Create a disk snapshot               |
| `vm_snapshot_restore`⚠️| `POST .../vms/:name/snapshots/:snapshot`                | Restore from a snapshot              |
| `vm_commit` ⚠️         | `POST .../vms/:name/commit`                             | Commit the disk to a new image       |
| `vm_capture_start` ⚠️  | `POST .../vms/:name/captures`                           | Start a packet capture               |
| `vm_capture_stop` ⚠️   | `DELETE .../vms/:name/captures`                         | Stop all captures                    |

### `@nblair2/phenix/cluster`

| Method               | phenix endpoint                              | Description                              |
| -------------------- | -------------------------------------------- | ---------------------------------------- |
| `host_list`          | `GET /api/v1/hosts`                          | List cluster hosts (head/compute)        |
| `disk_list`          | `GET /api/v1/disks`                          | List disk images                         |
| `application_list`   | `GET /api/v1/applications`                   | List available phenix apps               |
| `topology_list`      | `GET /api/v1/topologies`                     | List Topology configs                    |
| `topology_scenarios` | `GET /api/v1/topologies/:topo/scenarios`     | List scenarios for a topology            |
| `version`            | `GET /version`                               | Read the server version                  |
| `features`           | `GET /features`                              | Read enabled feature flags               |
| `settings_get`       | `GET /api/v1/settings`                       | Read server settings                     |

### `@nblair2/phenix/user`

| Method               | phenix endpoint                              | Description                              |
| -------------------- | -------------------------------------------- | ---------------------------------------- |
| `user_list`          | `GET /api/v1/users`                          | List UI users                            |
| `user_get`           | `GET /api/v1/users/:username`                | Fetch one user                           |
| `user_create` ⚠️     | `POST /api/v1/users`                         | Create a user with an RBAC role          |
| `user_delete` ⚠️     | `DELETE /api/v1/users/:username`             | Delete a user                            |
| `role_list`          | `GET /api/v1/roles`                          | List RBAC roles                          |
| `token_create` ⚠️    | `POST /api/v1/users/:username/tokens`        | Mint a long-lived API token              |

⚠️ marks methods that change server or experiment state.

## Global arguments

Every model takes the same connection/credential arguments, configured on each
model instance and shared by all of its methods:

| Argument   | Required | Default | Description                                                            |
| ---------- | -------- | ------- | ---------------------------------------------------------------------- |
| `host`     | yes      | —       | phenix server hostname or IP                                           |
| `port`     | no       | `3000`  | Server port                                                            |
| `scheme`   | no       | `https` | `http` or `https`                                                      |
| `username` | \*       | —       | Username (with `password`) to log in                                   |
| `password` | \*       | —       | Password (sensitive)                                                   |
| `token`    | \*       | —       | Pre-issued long-lived API token (sensitive); when set, login is skipped |
| `caCert`   | no       | —       | PEM CA cert to trust a self-signed/private-CA server (sensitive)       |

\* Provide **either** a `token`, **or** both `username` and `password`. For
deployments fronted by proxy auth, prefer a `token` (mint one with the
`user` model's `token_create`, or from the phenix UI).

## Usage

```bash
# Read the server version (cluster model), token auth
swamp model method run @nblair2/phenix/cluster version \
  --global-arg host=phenix.example.com \
  --global-arg token="$PHENIX_TOKEN"

# Or password auth (add for a self-signed server: --global-arg caCert="$(cat ca.pem)")
swamp model method run @nblair2/phenix/experiment experiment_list \
  --global-arg host=phenix.example.com \
  --global-arg username=admin --global-arg password="$PHENIX_PASS"
```

```bash
# Create a config from a local topology file, then create + start an experiment
swamp model method run @nblair2/phenix/config config_create --arg file=./my-topology.yaml
swamp model method run @nblair2/phenix/experiment experiment_create \
  --arg name=demo --arg topology=my-topology --arg scenario=my-scenario
swamp model method run @nblair2/phenix/experiment experiment_start --arg name=demo

# Inspect and drive the VMs
swamp model method run @nblair2/phenix/vm vm_list --arg exp=demo
swamp model method run @nblair2/phenix/vm vm_restart --arg exp=demo --arg name=server-1

# Tear it down
swamp model method run @nblair2/phenix/experiment experiment_stop --arg name=demo
swamp model method run @nblair2/phenix/experiment experiment_delete --arg name=demo
```

### Argument notes

- `config_create` / `config_update` take **either** an inline `config` object
  **or** a `file` path to a local YAML/JSON document (not both).
- `experiment_create` takes `name` and `topology` (required), plus optional
  `scenario`, `vlanMin`/`vlanMax`, `disabledApps`, `deployMode`, `defaultBridge`,
  and `useGreMesh`.
- VM methods are scoped by `exp` (experiment) plus `name` (VM); `vm_list_all`
  spans every experiment and needs no arguments.
- `token_create`'s result includes the **secret token value** — treat the
  stored `operation` resource accordingly.

### Composing models in a workflow

The models don't call each other; a workflow chains them. A `config` step can
upload a topology, an `experiment` step create and start it, and a `vm` step
drive the result. Because every model writes to the same resource store, a later
step can read an earlier model's stored state with CEL data-chaining — e.g.
`data.latest("<experiment-model-instance>", "experiment")`.

## Stored resources

Methods persist what they read/change as swamp resources, so later methods and
workflows can query them. Each resource belongs to the model that writes it:

- `config` (config model) — config objects, keyed by `<kind>-<name>`.
- `experiment` (experiment model) — experiments, keyed by name.
- `vm` (vm model) — VMs, keyed by `<experiment>-<vm>`.
- `host` / `disk` (cluster model) — cluster hosts and disk images.
- `user` (user model) — UI users, keyed by username.
- `operation` — outcomes of one-shot actions (schedule, trigger, captures,
  commit, token mint, version/features/settings reads, etc.); written by the
  experiment, vm, cluster and user models.

## Development

```bash
deno task fmt           # format
deno task check         # type-check
deno task lint          # lint
deno task test          # run unit tests (stubbed fetch, no server needed)
deno task version:check # assert manifest.yaml and all five model versions agree

swamp extension fmt manifest.yaml --check
swamp extension quality manifest.yaml
```

The extension ships five models — `config.ts`, `experiment.ts`, `vm.ts`,
`cluster.ts` and `user.ts` under `extensions/models/` — each exporting a `model`
of type `@nblair2/phenix/<noun>`. They share the HTTP client and global-argument
schema in `extensions/models/_lib/phenix.ts` and the swamp-model plumbing in
`extensions/models/_lib/model.ts`. Each model's methods and resource specs are
written inline (so the registry can statically parse and display them on the
extension page); method `execute` bodies stay type-checked via
`z.infer<typeof …>`. Unit tests live alongside each model (`*_test.ts`) and stub
`fetch` (and file reads) through the shared harness in `_lib/testing.ts`, so
they run without a live phenix server.

## Releasing

Releases are automated — you never tag by hand and never edit the version twice.

```bash
deno task bump          # set the next CalVer in manifest.yaml AND all 5 models
                        # (or pin one: deno task bump 2026.06.01.1)
```

Commit that, open a PR, and merge. On merge to `main`, CI publishes to the swamp
registry **only if the manifest version is newer than what's published** (so
merges without a bump are no-ops), then auto-creates the matching `v<version>`
git tag and GitHub Release. The version lives in `manifest.yaml` (what the
registry publishes) plus a literal `version` in each of the five model files
(the registry parses each model's version from source, so it can't be a shared
constant) — and `deno task bump` rewrites them all together; CI's `version:check`
fails any PR where they drift. The only repository secret needed is
`SWAMP_API_KEY` (a personal API key from your swamp.club account settings).

## License

AGPL-3.0-only — see [LICENSE.txt](LICENSE.txt). This matches the license
convention used across the swamp extension ecosystem.
