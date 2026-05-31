/**
 * Unit tests for the phenix HTTP client and its helpers. Uses a stubbed `fetch`
 * so no live phenix server is required.
 *
 * @module
 */
import {
  asObject,
  connect,
  type FetchLike,
  GlobalArgsSchema,
  listFrom,
  PhenixApiError,
  type PhenixGlobalArgs,
} from "./phenix.ts";

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const tokenCfg: PhenixGlobalArgs = {
  host: "phenix.test",
  port: 3000,
  scheme: "https",
  token: "PRE",
};

const passCfg: PhenixGlobalArgs = {
  host: "phenix.test",
  port: 3000,
  scheme: "https",
  username: "admin",
  password: "secret",
};

// --- GlobalArgsSchema validation ---

Deno.test("GlobalArgsSchema requires token or username+password", () => {
  assert(GlobalArgsSchema.safeParse({ host: "h", token: "t" }).success);
  assert(
    GlobalArgsSchema.safeParse({ host: "h", username: "u", password: "p" })
      .success,
  );
  assert(
    !GlobalArgsSchema.safeParse({ host: "h", username: "u" }).success,
    "username without password should fail",
  );
  assert(
    !GlobalArgsSchema.safeParse({ host: "h" }).success,
    "no credentials should fail",
  );
});

// --- auth: token path skips login ---

Deno.test("connect with a token does not call login and sends the bearer header", async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchStub: FetchLike = (input, init) => {
    calls.push({ url: input, headers: new Headers(init?.headers) });
    return Promise.resolve(jsonResponse(200, { ok: true }));
  };
  const client = await connect(tokenCfg, { fetch: fetchStub });
  assertEquals(calls.length, 0, "connect with token must not hit the network");
  await client.get("/api/v1/experiments");
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://phenix.test:3000/api/v1/experiments",
  );
  assertEquals(
    calls[0].headers.get("X-Phenix-Auth-Token"),
    "Bearer PRE",
  );
});

// --- auth: login path reads token from the body ---

Deno.test("connect with a password logs in and uses the returned token", async () => {
  const calls: { method: string; path: string; bearer: string | null }[] = [];
  const fetchStub: FetchLike = (input, init) => {
    const u = new URL(input);
    const method = init?.method ?? "GET";
    if (u.pathname === "/api/v1/login") {
      return Promise.resolve(jsonResponse(200, { token: "JWT123", user: {} }));
    }
    calls.push({
      method,
      path: u.pathname,
      bearer: new Headers(init?.headers).get("X-Phenix-Auth-Token"),
    });
    return Promise.resolve(jsonResponse(200, { vms: [] }));
  };
  const client = await connect(passCfg, { fetch: fetchStub });
  await client.get("/api/v1/experiments/x/vms");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].bearer, "Bearer JWT123");
});

// --- error handling ---

Deno.test("a non-OK response throws PhenixApiError with the body message", async () => {
  const fetchStub: FetchLike = () =>
    Promise.resolve(jsonResponse(500, { error: "boom" }));
  const client = await connect(tokenCfg, { fetch: fetchStub });
  let thrown: unknown;
  try {
    await client.get("/api/v1/experiments");
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof PhenixApiError, "should throw PhenixApiError");
  assertEquals((thrown as PhenixApiError).status, 500);
  assertEquals((thrown as PhenixApiError).message, "boom");
});

Deno.test("allowStatuses tolerates an otherwise-failing status", async () => {
  const fetchStub: FetchLike = () => Promise.resolve(jsonResponse(404, {}));
  const client = await connect(tokenCfg, { fetch: fetchStub });
  const res = await client.get("/api/v1/experiments/missing", {
    allowStatuses: [404],
  });
  assertEquals(res.status, 404);
});

// --- raw body upload sets the given content type ---

Deno.test("postRaw sends the raw body and content type", async () => {
  let captured: { body: string; contentType: string | null } | undefined;
  const fetchStub: FetchLike = (_input, init) => {
    captured = {
      body: String(init?.body),
      contentType: new Headers(init?.headers).get("content-type"),
    };
    return Promise.resolve(jsonResponse(201, {}));
  };
  const client = await connect(tokenCfg, { fetch: fetchStub });
  await client.postRaw(
    "/api/v1/configs",
    "kind: Topology\n",
    "application/x-yaml",
  );
  assertEquals(captured?.contentType, "application/x-yaml");
  assertEquals(captured?.body, "kind: Topology\n");
});

// --- response helpers ---

Deno.test("listFrom handles bare arrays, wrapped keys, and missing keys", () => {
  assertEquals(listFrom([{ a: 1 }], "vms"), [{ a: 1 }]);
  assertEquals(listFrom({ vms: [{ b: 2 }] }, "vms"), [{ b: 2 }]);
  assertEquals(listFrom({ other: 1 }, "vms"), []);
  assertEquals(listFrom(null, "vms"), []);
});

Deno.test("asObject returns objects and rejects arrays/scalars", () => {
  assertEquals(asObject({ a: 1 }), { a: 1 });
  assertEquals(asObject([1, 2]), {});
  assertEquals(asObject("x"), {});
  assertEquals(asObject(null), {});
});

// --- empty (204) bodies parse to null ---

Deno.test("a 204 response yields a null body without throwing", async () => {
  const fetchStub: FetchLike = () =>
    Promise.resolve(new Response(null, { status: 204 }));
  const client = await connect(tokenCfg, { fetch: fetchStub });
  const res = await client.post("/api/v1/experiments/x/start");
  assertEquals(res.status, 204);
  assertEquals(res.body, null);
});
