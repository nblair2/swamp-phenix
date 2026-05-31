/**
 * Unit tests for the `@nblair2/phenix/scorch` model: identity/shape, the
 * start-then-poll-to-completion flow, the scorch-tarball filter, and cancel.
 *
 * @module
 */
import { model } from "./scorch.ts";
import {
  assert,
  assertEquals,
  assertModel,
  harness,
  jsonResponse,
} from "./_lib/testing.ts";

Deno.test("scorch model identity and shape", () => {
  assertModel(
    model,
    "@nblair2/phenix/scorch",
    ["scorch_run", "scorch_status", "scorch_cancel", "scorch_files"],
    ["scorchRun", "operation"],
  );
});

Deno.test("scorch_run starts the run then polls the DAG to a terminal state", async () => {
  let posted = false;
  const { context, written, calls } = harness((c) => {
    if (c.method === "POST") {
      posted = true;
      return jsonResponse(204, null);
    }
    if (c.path.endsWith("/scorch/pipelines")) {
      return jsonResponse(200, { pipelines: [], running: posted ? 0 : -1 });
    }
    // per-run DAG: the terminal `done` node reports success once started
    return jsonResponse(200, {
      pipeline: [
        { name: "configure", status: "success" },
        { name: "done", status: posted ? "success" : "unknown" },
      ],
    });
  });
  await model.methods.scorch_run.execute(
    {
      name: "demo",
      run: 0,
      loop: 0,
      waitForCompletion: true,
      intervalSec: 0,
      timeoutSec: 60,
    },
    context,
  );
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.path, "/api/v1/experiments/demo/scorch/pipelines/0");
  assertEquals(written[0].specName, "scorchRun");
  assertEquals(written[0].instanceName, "scorch-demo-run0");
  const data = written[0].data as Record<string, unknown>;
  assertEquals(data.status, "success");
  assertEquals(data.run, 0);
});

Deno.test("scorch_run skips the POST when the run is already executing", async () => {
  const { context, calls } = harness((c) => {
    if (c.path.endsWith("/scorch/pipelines")) {
      return jsonResponse(200, { running: 3 });
    }
    return jsonResponse(200, {
      pipeline: [{ name: "done", status: "success" }],
    });
  });
  await model.methods.scorch_run.execute(
    {
      name: "demo",
      run: 3,
      loop: 0,
      waitForCompletion: true,
      intervalSec: 0,
      timeoutSec: 60,
    },
    context,
  );
  assert(
    !calls.some((c) => c.method === "POST"),
    "must not re-POST a live run",
  );
});

Deno.test("scorch_files keeps only scorch .tgz artifacts, filtered by run", async () => {
  const { context, written } = harness(() =>
    jsonResponse(200, {
      files: [
        {
          name: "scorch-run-0_2026.tgz",
          size: 1024,
          categories: ["Scorch Artifact", "run-0"],
        },
        {
          name: "scorch-run-10_2026.tgz",
          size: 2048,
          categories: ["Scorch Artifact", "run-10"],
        },
        { name: "notes.txt", size: 5, categories: ["Other"] },
      ],
    })
  );
  await model.methods.scorch_files.execute({ name: "demo", run: 0 }, context);
  const result = (written[0].data as Record<string, unknown>)
    .result as { files: { name: string; size: number }[]; count: number };
  assertEquals(result.count, 1);
  assertEquals(result.files[0].name, "scorch-run-0_2026.tgz");
  assertEquals(result.files[0].size, 1024);
});

Deno.test("scorch_cancel DELETEs the run pipeline", async () => {
  const { context, calls } = harness(() => jsonResponse(204, null));
  await model.methods.scorch_cancel.execute({ name: "demo", run: 3 }, context);
  assertEquals(calls[0].method, "DELETE");
  assertEquals(calls[0].path, "/api/v1/experiments/demo/scorch/pipelines/3");
});
