/**
 * Model-level tests for `@nblair2/phenix`: the model identity, that every group's
 * methods and resources are assembled, and a few argument-schema invariants.
 *
 * @module
 */
import { model } from "./phenix.ts";

function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}

Deno.test("model identity and version are set", () => {
  assert(model.type === "@nblair2/phenix");
  assert(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version), "version is CalVer");
});

Deno.test("methods from every group are present", () => {
  const expected = [
    // configs
    "config_list",
    "config_get",
    "config_create",
    "config_update",
    "config_delete",
    // experiments
    "experiment_list",
    "experiment_create",
    "experiment_start",
    "experiment_stop",
    "experiment_trigger",
    // vms
    "vm_list",
    "vm_update",
    "vm_start",
    "vm_redeploy",
    "vm_capture_start",
    // cluster
    "host_list",
    "disk_list",
    "vm_list_all",
    "version",
    "settings_get",
    // users
    "user_list",
    "user_create",
    "role_list",
    "token_create",
  ];
  for (const name of expected) {
    assert(name in model.methods, `missing method ${name}`);
  }
});

Deno.test("resources from every group are present", () => {
  for (
    const spec of [
      "config",
      "experiment",
      "vm",
      "host",
      "disk",
      "user",
      "operation",
    ]
  ) {
    assert(spec in model.resources, `missing resource ${spec}`);
  }
});

Deno.test("every method has a description and an arguments schema", () => {
  for (const [name, def] of Object.entries(model.methods)) {
    assert(
      typeof def.description === "string" && def.description.length > 0,
      `${name} description`,
    );
    assert(
      typeof def.arguments?.safeParse === "function",
      `${name} arguments schema`,
    );
  }
});

Deno.test("experiment_create requires name and topology", () => {
  const args = model.methods.experiment_create.arguments;
  assert(args.safeParse({ name: "x", topology: "t" }).success);
  assert(!args.safeParse({ name: "x" }).success, "topology required");
  assert(!args.safeParse({ topology: "t" }).success, "name required");
});
