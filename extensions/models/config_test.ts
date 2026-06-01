/**
 * Unit tests for the `@nblair2/phenix/config` model: identity/shape plus the
 * config CRUD request behavior (file uploads, mutual-exclusion, delete path).
 *
 * @module
 */
import { model } from "./config.ts";
import {
  assert,
  assertEquals,
  assertModel,
  createdResponse,
  harness,
  jsonResponse,
} from "./_lib/testing.ts";
import { PhenixApiError } from "./_lib/phenix.ts";
import type { ReadDirLike, ReadFileLike } from "./_lib/phenix.ts";

Deno.test("config model identity and shape", () => {
  assertModel(
    model,
    "@nblair2/phenix/config",
    [
      "config_list",
      "config_get",
      "config_create",
      "config_upload_dir",
      "config_update",
      "config_delete",
      "config_prune",
    ],
    ["config"],
  );
});

Deno.test("config_create from a file POSTs the raw document as YAML", async () => {
  const readFile: ReadFileLike = (_p) =>
    Promise.resolve(new TextEncoder().encode("kind: Topology\n"));
  const { context, written, calls } = harness(
    () => jsonResponse(201, { kind: "Topology", metadata: { name: "topo1" } }),
    readFile,
  );
  const result = await model.methods.config_create.execute(
    { file: "/tmp/topo.yaml" },
    context,
  );
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.path, "/api/v1/configs");
  assertEquals(post.contentType, "application/x-yaml");
  assertEquals(post.raw, "kind: Topology\n");
  assertEquals(written[0].specName, "config");
  assertEquals(written[0].instanceName, "config-topology-topo1");
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("config_upload_dir POSTs every yaml/json file in the directory", async () => {
  const files: Record<string, string> = {
    "/r/topology-base.yml": "kind: Topology\nmetadata:\n  name: base\n",
    "/r/scenarioA.yml": "kind: Scenario\nmetadata:\n  name: scnA\n",
    "/r/notes.txt": "ignore me",
  };
  const readDir: ReadDirLike = (_p) =>
    Promise.resolve(["topology-base.yml", "scenarioA.yml", "notes.txt"]);
  const readFile: ReadFileLike = (p) =>
    Promise.resolve(new TextEncoder().encode(files[p] ?? ""));
  const posted: string[] = [];
  const { context, written } = harness(
    (c) => {
      if (c.method === "POST") posted.push(String(c.raw));
      return jsonResponse(201, {});
    },
    readFile,
    readDir,
  );
  const result = await model.methods.config_upload_dir.execute(
    { dir: "/r" },
    context,
  );
  // Only the two config files are uploaded (notes.txt skipped), sorted by name.
  assertEquals(posted.length, 2);
  assert(posted[0].includes("name: scnA"), "scenarioA.yml uploaded");
  assert(posted[1].includes("name: base"), "topology-base.yml uploaded");
  assertEquals(result.dataHandles.length, 2);
  assertEquals(written.length, 2);
  // Named from the document's own parsed kind+metadata.name (authoritative,
  // matching config_list) — note metadata.name ("scnA") differs from the file.
  assertEquals(written[0].instanceName, "config-scenario-scnA");
  assertEquals(written[1].instanceName, "config-topology-base");
});

Deno.test("config_upload_dir upserts: a POST 'already exists' falls back to a named PUT", async () => {
  const readDir: ReadDirLike = (_p) => Promise.resolve(["topo.yml"]);
  const readFile: ReadFileLike = (_p) =>
    Promise.resolve(
      new TextEncoder().encode(
        "kind: Topology\nmetadata:\n  name: control-A-base\n",
      ),
    );
  // phenix POST is create-only: a re-run gets 400 "already exists".
  const { context, calls, written } = harness(
    (c) =>
      c.method === "POST"
        ? jsonResponse(400, {
          cause: "storing config: config already exists",
          message: "config with same name already exists",
        })
        : jsonResponse(204, null), // the PUT update
    readFile,
    readDir,
  );
  const result = await model.methods.config_upload_dir.execute(
    { dir: "/r" },
    context,
  );
  assertEquals(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      "POST /api/v1/configs",
      "PUT /api/v1/configs/Topology/control-A-base",
    ],
  );
  assertEquals(written[0].instanceName, "config-topology-control-A-base");
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("config_upload_dir surfaces a genuine validation 400 (does not PUT)", async () => {
  const readDir: ReadDirLike = (_p) => Promise.resolve(["bad.yml"]);
  const readFile: ReadFileLike = (_p) =>
    Promise.resolve(
      new TextEncoder().encode("kind: Topology\nmetadata:\n  name: x\n"),
    );
  const { context, calls } = harness(
    (c) =>
      c.method === "POST"
        ? jsonResponse(400, { message: "invalid topology: missing nodes" })
        : jsonResponse(204, null),
    readFile,
    readDir,
  );
  let thrown: unknown;
  try {
    await model.methods.config_upload_dir.execute({ dir: "/r" }, context);
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof PhenixApiError, "a non-'exists' 400 must surface");
  assertEquals(calls.filter((c) => c.method === "PUT").length, 0);
});

Deno.test("config_upload_dir reads metadata.name past annotations (real scorch shape)", async () => {
  // The dependency-free identity parser must take the metadata-block `name`,
  // not a nested key under `annotations`/`spec`.
  const doc = "apiVersion: phenix.sandia.gov/v2\nkind: Scenario\n" +
    "metadata:\n  name: control-A-scorch\n  annotations:\n" +
    "    topology: control-A-A\nspec:\n  apps: []\n";
  const readDir: ReadDirLike = (_p) => Promise.resolve(["s.yml"]);
  const readFile: ReadFileLike = (_p) =>
    Promise.resolve(new TextEncoder().encode(doc));
  const { context, calls, written } = harness(
    (c) =>
      c.method === "POST"
        ? jsonResponse(400, { message: "config already exists" })
        : jsonResponse(204, null),
    readFile,
    readDir,
  );
  await model.methods.config_upload_dir.execute({ dir: "/r" }, context);
  assertEquals(
    `${calls[1].method} ${calls[1].path}`,
    "PUT /api/v1/configs/Scenario/control-A-scorch",
  );
  assertEquals(written[0].instanceName, "config-scenario-control-A-scorch");
});

Deno.test("config_upload_dir names instances from the Location header (canonical)", async () => {
  // The real phenix create reply: 201, empty body, Location /configs/<kind>/<name>.
  // Note the config's metadata.name differs from the file name (e.g. the file
  // topology-base.yml holds a Topology named control-A-base) — so the Location
  // is the only correct, collision-free identity.
  const readDir: ReadDirLike = (_p) =>
    Promise.resolve(["topology-base.yml", "scenarioA.yml"]);
  const readFile: ReadFileLike = (_p) =>
    Promise.resolve(new TextEncoder().encode("kind: Topology\n"));
  // Files upload sorted: scenarioA.yml first, then topology-base.yml.
  const locations = [
    "/api/v1/configs/scenario/control-A-A",
    "/api/v1/configs/topology/control-A-base",
  ];
  let p = 0;
  const { context, written } = harness(
    (c) =>
      c.method === "POST"
        ? createdResponse(locations[p++])
        : jsonResponse(200, {}),
    readFile,
    readDir,
  );
  await model.methods.config_upload_dir.execute({ dir: "/r" }, context);
  // phenix's `<kind>-<name>` identity (lowercased kind), matching config_list.
  assertEquals(written[0].instanceName, "config-scenario-control-A-A");
  assertEquals(written[1].instanceName, "config-topology-control-A-base");
});

Deno.test("config_upload_dir names from the echoed kind/name when phenix returns a full body", async () => {
  const readDir: ReadDirLike = (_p) => Promise.resolve(["a.yml", "b.yml"]);
  const readFile: ReadFileLike = (_p) =>
    Promise.resolve(new TextEncoder().encode("kind: Topology\n"));
  const bodies = [
    { kind: "Topology", metadata: { name: "alpha" } },
    { kind: "Scenario", metadata: { name: "beta" } },
  ];
  let i = 0;
  const { context, written } = harness(
    (
      c,
    ) => (c.method === "POST"
      ? jsonResponse(201, bodies[i++])
      : jsonResponse(200, {})),
    readFile,
    readDir,
  );
  await model.methods.config_upload_dir.execute({ dir: "/r" }, context);
  // When phenix echoes the stored config, keep its `<kind>-<name>` identity.
  assertEquals(written[0].instanceName, "config-topology-alpha");
  assertEquals(written[1].instanceName, "config-scenario-beta");
});

Deno.test("config_create rejects supplying both config and file", () => {
  const args = model.methods.config_create.arguments;
  assert(!args.safeParse({ config: {}, file: "x" }).success);
  assert(args.safeParse({ file: "x" }).success);
  assert(args.safeParse({ config: { kind: "User" } }).success);
});

Deno.test("config_delete issues DELETE to the kind/name path", async () => {
  const { context, calls } = harness(() => jsonResponse(204, null));
  await model.methods.config_delete.execute(
    { kind: "Experiment", name: "demo" },
    context,
  );
  assertEquals(calls[0].method, "DELETE");
  assertEquals(calls[0].path, "/api/v1/configs/Experiment/demo");
});

Deno.test("config_prune deletes only configs matching the prefix and kinds", async () => {
  const configs = {
    configs: [
      { kind: "Topology", metadata: { name: "control-A-base" } }, // match
      { kind: "Scenario", metadata: { name: "control-A-scorch" } }, // match
      { kind: "Topology", metadata: { name: "control-B-base" } }, // other experiment
      { kind: "Image", metadata: { name: "control-A-img" } }, // prefix ok, kind excluded
      { kind: "Topology", metadata: { name: "byterage" } }, // stock, no prefix
    ],
  };
  const { context, calls } = harness((c) =>
    c.method === "GET" ? jsonResponse(200, configs) : jsonResponse(204, null)
  );
  const result = await model.methods.config_prune.execute(
    { namePrefix: "control-A-", kinds: ["Topology", "Scenario"] },
    context,
  );
  const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
  assertEquals(deletes, [
    "/api/v1/configs/Topology/control-A-base",
    "/api/v1/configs/Scenario/control-A-scorch",
  ]);
  assertEquals(result.dataHandles.length, 0);
});

Deno.test("config_prune is a no-op when nothing matches", async () => {
  const configs = {
    configs: [{ kind: "Topology", metadata: { name: "byterage" } }],
  };
  const { context, calls } = harness((c) =>
    c.method === "GET" ? jsonResponse(200, configs) : jsonResponse(204, null)
  );
  await model.methods.config_prune.execute(
    { namePrefix: "control-A-" },
    context,
  );
  assertEquals(calls.filter((c) => c.method === "DELETE").length, 0);
});

Deno.test("config_prune tolerates a config deleted concurrently (400 not-found)", async () => {
  const configs = {
    configs: [{ kind: "Topology", metadata: { name: "control-A-base" } }],
  };
  // The list shows it, but the DELETE races: phenix reports a missing config
  // as 400 (not 404) on delete — must be tolerated, not thrown.
  const { context, calls } = harness((c) =>
    c.method === "GET"
      ? jsonResponse(200, configs)
      : jsonResponse(400, { message: "config not found" })
  );
  const res = await model.methods.config_prune.execute(
    { namePrefix: "control-A-" },
    context,
  );
  assertEquals(res.dataHandles.length, 0);
  assertEquals(calls.filter((c) => c.method === "DELETE").length, 1);
});
