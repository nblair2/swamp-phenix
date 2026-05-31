/**
 * Unit tests for the `@nblair2/phenix/user` model: identity/shape, token
 * minting (stored in a dedicated, vaulted `token` resource), and the
 * camelCase→snake_case body mapping for user creation.
 *
 * @module
 */
import { model } from "./user.ts";
import {
  assert,
  assertEquals,
  assertModel,
  harness,
  jsonResponse,
} from "./_lib/testing.ts";

Deno.test("user model identity and shape", () => {
  assertModel(
    model,
    "@nblair2/phenix/user",
    [
      "user_list",
      "user_get",
      "user_create",
      "user_delete",
      "role_list",
      "token_create",
    ],
    ["user", "operation", "token"],
  );
});

Deno.test("token_create POSTs lifetime/desc and stores a token resource", async () => {
  const { context, written, calls } = harness(() =>
    jsonResponse(201, { token: "SECRET", desc: "ci", exp: "2027-01-01" })
  );
  await model.methods.token_create.execute(
    { username: "admin", lifetime: "720h", desc: "ci" },
    context,
  );
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].path, "/api/v1/users/admin/tokens");
  assertEquals(calls[0].json, { lifetime: "720h", desc: "ci" });
  // Stored as a dedicated `token` resource (not the generic `operation`).
  assertEquals(written[0].specName, "token");
  const data = written[0].data as Record<string, unknown>;
  assertEquals(data.username, "admin");
  assertEquals(data.token, "SECRET");
  assertEquals(data.exp, "2027-01-01");
});

Deno.test("the token resource marks its value sensitive and vaults to phenix-tokens", () => {
  const spec = model.resources.token;
  assertEquals(spec.vaultName, "phenix-tokens");
  // The `token` field carries { sensitive: true } so swamp auto-vaults it.
  const shape = spec.schema.shape as Record<string, { meta?: () => unknown }>;
  const meta = shape.token.meta?.() as { sensitive?: boolean } | undefined;
  assert(meta?.sensitive === true, "token field must be marked sensitive");
});

Deno.test("user_create maps camelCase args to snake_case body", async () => {
  const { context, calls } = harness(() =>
    jsonResponse(201, { username: "bob" })
  );
  await model.methods.user_create.execute(
    {
      username: "bob",
      password: "pw",
      firstName: "Bob",
      lastName: "Lob",
      roleName: "VM Viewer",
      resourceNames: ["*"],
    },
    context,
  );
  assertEquals(calls[0].json, {
    username: "bob",
    password: "pw",
    role_name: "VM Viewer",
    first_name: "Bob",
    last_name: "Lob",
    resource_names: ["*"],
  });
});
