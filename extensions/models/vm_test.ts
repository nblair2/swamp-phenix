/**
 * Unit tests for the `@nblair2/phenix/vm` model: identity/shape, the
 * provided-fields-only PATCH, the empty-update guard, the GET-based shutdown,
 * per-experiment listing, and the cross-experiment `vm_list_all`.
 *
 * @module
 */
import { model } from "./vm.ts";
import {
  assert,
  assertEquals,
  assertModel,
  harness,
  jsonResponse,
} from "./_lib/testing.ts";

Deno.test("vm model identity and shape", () => {
  assertModel(
    model,
    "@nblair2/phenix/vm",
    [
      "vm_list",
      "vm_list_all",
      "vm_get",
      "vm_update",
      "vm_start",
      "vm_stop",
      "vm_shutdown",
      "vm_restart",
      "vm_reset",
      "vm_redeploy",
      "vm_snapshot_list",
      "vm_snapshot_create",
      "vm_snapshot_restore",
      "vm_commit",
      "vm_capture_start",
      "vm_capture_stop",
    ],
    ["vm", "operation"],
  );
});

Deno.test("vm_update PATCHes only the provided fields", async () => {
  const { context, calls } = harness((c) => {
    if (c.method === "PATCH") return jsonResponse(200, { name: "vm1" });
    return jsonResponse(200, { name: "vm1" });
  });
  await model.methods.vm_update.execute(
    { exp: "demo", name: "vm1", cpus: 4, dnb: true },
    context,
  );
  const patch = calls.find((c) => c.method === "PATCH")!;
  assertEquals(patch.path, "/api/v1/experiments/demo/vms/vm1");
  assertEquals(patch.json, { cpus: 4, dnb: true });
});

Deno.test("vm_update with no changes throws", async () => {
  const { context } = harness(() => jsonResponse(200, {}));
  let threw = false;
  try {
    await model.methods.vm_update.execute({ exp: "d", name: "v" }, context);
  } catch {
    threw = true;
  }
  assert(threw, "vm_update with no fields should throw");
});

Deno.test("vm_shutdown uses GET and stores under <exp>-<vm>", async () => {
  const { context, written, calls } = harness(() =>
    jsonResponse(200, { name: "vm1", state: "QUIT" })
  );
  await model.methods.vm_shutdown.execute(
    { exp: "demo", name: "vm1" },
    context,
  );
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].path, "/api/v1/experiments/demo/vms/vm1/shutdown");
  assertEquals(written[0].specName, "vm");
  assertEquals(written[0].instanceName, "vm-demo-vm1");
});

Deno.test("vm_list stores each VM keyed by experiment and name", async () => {
  const { context, written } = harness(() =>
    jsonResponse(200, { vms: [{ name: "a" }, { name: "b" }], total: 2 })
  );
  await model.methods.vm_list.execute({ exp: "demo" }, context);
  assertEquals(written.map((w) => w.instanceName), ["vm-demo-a", "vm-demo-b"]);
});

Deno.test("vm_list_all keys VMs by their reported experiment", async () => {
  const { context, written } = harness(() =>
    jsonResponse(200, {
      vms: [{ name: "a", experiment: "e1" }, { name: "b", experiment: "e2" }],
    })
  );
  await model.methods.vm_list_all.execute({}, context);
  assertEquals(written.map((w) => w.instanceName), ["vm-e1-a", "vm-e2-b"]);
});
