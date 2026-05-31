/**
 * Unit tests for the `@nblair2/phenix/experiment` model: identity/shape, the
 * create-then-re-GET flow, start, list, and the create argument schema.
 *
 * @module
 */
import { model } from "./experiment.ts";
import {
  assert,
  assertEquals,
  assertModel,
  harness,
  jsonResponse,
} from "./_lib/testing.ts";

Deno.test("experiment model identity and shape", () => {
  assertModel(
    model,
    "@nblair2/phenix/experiment",
    [
      "experiment_list",
      "experiment_get",
      "experiment_create",
      "experiment_delete",
      "experiment_start",
      "experiment_stop",
      "experiment_apps",
      "experiment_schedule_get",
      "experiment_schedule_set",
      "experiment_topology",
      "experiment_files",
      "experiment_trigger",
    ],
    ["experiment", "operation"],
  );
});

Deno.test("experiment_create POSTs snake_case body then re-GETs the experiment", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.method === "POST") return jsonResponse(204, null);
    return jsonResponse(200, { name: "demo", running: false });
  });
  await model.methods.experiment_create.execute(
    {
      name: "demo",
      topology: "topo1",
      scenario: "scn1",
      vlanMin: 100,
      vlanMax: 200,
      disabledApps: ["foo"],
    },
    context,
  );
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.path, "/api/v1/experiments");
  assertEquals(post.json, {
    name: "demo",
    topology: "topo1",
    scenario: "scn1",
    vlan_min: 100,
    vlan_max: 200,
    disabled_apps: ["foo"],
  });
  const get = calls.find((c) => c.method === "GET")!;
  assertEquals(get.path, "/api/v1/experiments/demo");
  assertEquals(written[0].specName, "experiment");
  assertEquals(written[0].instanceName, "experiment-demo");
});

Deno.test("experiment_start POSTs to /start and stores the refreshed state", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.method === "POST") return jsonResponse(200, {});
    return jsonResponse(200, { name: "demo", running: true });
  });
  await model.methods.experiment_start.execute({ name: "demo" }, context);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].path, "/api/v1/experiments/demo/start");
  assertEquals((written[0].data as Record<string, unknown>).running, true);
});

Deno.test("experiment_list stores one resource per experiment", async () => {
  const { context, written } = harness(() =>
    jsonResponse(200, { experiments: [{ name: "a" }, { name: "b" }] })
  );
  const result = await model.methods.experiment_list.execute({}, context);
  assertEquals(result.dataHandles.length, 2);
  assertEquals(written.map((w) => w.instanceName), [
    "experiment-a",
    "experiment-b",
  ]);
});

Deno.test("experiment_create requires name and topology", () => {
  const args = model.methods.experiment_create.arguments;
  assert(args.safeParse({ name: "x", topology: "t" }).success);
  assert(!args.safeParse({ name: "x" }).success, "topology required");
  assert(!args.safeParse({ topology: "t" }).success, "name required");
});
