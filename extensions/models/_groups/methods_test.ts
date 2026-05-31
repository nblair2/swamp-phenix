/**
 * Unit tests for the `@nblair2/phenix` model methods. Uses a stubbed `fetch`
 * (and `readFile`) injected via `context._deps` plus a fake write context, so
 * the tests run without a live phenix server or real files. They assert the
 * request method/path/body each method sends and that results are stored.
 *
 * @module
 */
import { model } from "../phenix.ts";
import type {
  FetchLike,
  PhenixGlobalArgs,
  ReadFileLike,
} from "../_lib/phenix.ts";

const cfg: PhenixGlobalArgs = {
  host: "phenix.test",
  port: 3000,
  scheme: "https",
  token: "T",
};

function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      msg ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function jsonResponse(status: number, body: unknown): Response {
  // 204 (and other null-body statuses) cannot carry a response body.
  if (status === 204 || body === null) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Written {
  specName: string;
  instanceName: string;
  data: unknown;
}

interface Captured {
  method: string;
  path: string;
  search: string;
  json?: Record<string, unknown>;
  raw?: string;
  contentType?: string | null;
}

/** Build a fake context + request log, answering with `handler` per request. */
function harness(
  handler: (c: Captured) => Response,
  readFile?: ReadFileLike,
) {
  const written: Written[] = [];
  const calls: Captured[] = [];
  const fetchStub: FetchLike = (input, init) => {
    const u = new URL(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const contentType = headers.get("content-type");
    const rawBody = init?.body ? String(init.body) : undefined;
    let json: Record<string, unknown> | undefined;
    if (rawBody && contentType === "application/json") {
      json = JSON.parse(rawBody);
    }
    const c: Captured = {
      method,
      path: u.pathname,
      search: u.search,
      json,
      raw: rawBody,
      contentType,
    };
    calls.push(c);
    return Promise.resolve(handler(c));
  };
  const context = {
    globalArgs: cfg,
    _deps: { fetch: fetchStub, readFile },
    writeResource: (specName: string, instanceName: string, data: unknown) => {
      written.push({ specName, instanceName, data });
      return Promise.resolve({
        name: instanceName,
        specName,
        kind: "resource",
      });
    },
    readResource: () => Promise.resolve(null as Record<string, unknown> | null),
  };
  return { context, written, calls };
}

// --- configs ---

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

// --- experiments ---

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

// --- vms ---

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

// --- cluster & users ---

Deno.test("vm_list_all keys VMs by their reported experiment", async () => {
  const { context, written } = harness(() =>
    jsonResponse(200, {
      vms: [{ name: "a", experiment: "e1" }, { name: "b", experiment: "e2" }],
    })
  );
  await model.methods.vm_list_all.execute({}, context);
  assertEquals(written.map((w) => w.instanceName), ["vm-e1-a", "vm-e2-b"]);
});

Deno.test("token_create POSTs lifetime/desc and records the token", async () => {
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
  assertEquals(written[0].specName, "operation");
  assertEquals(
    (written[0].data as Record<string, unknown>).operation,
    "token_create",
  );
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

Deno.test("version GETs the root /version route", async () => {
  const { context, calls } = harness(() =>
    jsonResponse(200, { version: "1.2.3" })
  );
  await model.methods.version.execute({}, context);
  assertEquals(calls[0].path, "/version");
});
