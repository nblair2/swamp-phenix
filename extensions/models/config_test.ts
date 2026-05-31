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
  harness,
  jsonResponse,
} from "./_lib/testing.ts";
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
