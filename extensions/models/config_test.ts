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
import type { ReadFileLike } from "./_lib/phenix.ts";

Deno.test("config model identity and shape", () => {
  assertModel(
    model,
    "@nblair2/phenix/config",
    [
      "config_list",
      "config_get",
      "config_create",
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
