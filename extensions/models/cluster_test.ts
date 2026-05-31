/**
 * Unit tests for the `@nblair2/phenix/cluster` model: identity/shape and that
 * `version` reads the root `/version` route (not under `/api/v1`).
 *
 * @module
 */
import { model } from "./cluster.ts";
import {
  assertEquals,
  assertModel,
  harness,
  jsonResponse,
} from "./_lib/testing.ts";

Deno.test("cluster model identity and shape", () => {
  assertModel(
    model,
    "@nblair2/phenix/cluster",
    [
      "host_list",
      "disk_list",
      "application_list",
      "topology_list",
      "topology_scenarios",
      "version",
      "features",
      "settings_get",
    ],
    ["host", "disk", "operation"],
  );
});

Deno.test("version GETs the root /version route", async () => {
  const { context, calls } = harness(() =>
    jsonResponse(200, { version: "1.2.3" })
  );
  await model.methods.version.execute({}, context);
  assertEquals(calls[0].path, "/version");
});
