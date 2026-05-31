/**
 * Shared test harness for the per-model unit tests. Provides a stubbed `fetch`
 * (and `readFile`) injected via `context._deps`, plus a fake write-context that
 * records `writeResource` calls — so model methods can be exercised without a
 * live phenix server or real files. Each method body asserts the request
 * method/path/body it sends and that results are stored.
 *
 * Imported only by the `*_test.ts` files (never by a model), so it is not part
 * of the published bundle.
 *
 * @module
 */
import type { FetchLike, PhenixGlobalArgs, ReadFileLike } from "./phenix.ts";

/** Connection args used by every test (token auth, no real server). */
export const cfg: PhenixGlobalArgs = {
  host: "phenix.test",
  port: 3000,
  scheme: "https",
  token: "T",
};

/** Throw if `cond` is false. */
export function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}

/** Throw unless `actual` deep-equals `expected` (by JSON serialization). */
export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      msg ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Minimal structural view of a model, for the shared shape assertion. */
interface ModelLike {
  type: string;
  version: string;
  globalArguments?: { partial?: () => unknown };
  methods: Record<
    string,
    { description: string; arguments: { safeParse: (v: unknown) => unknown } }
  >;
  resources: Record<string, unknown>;
}

/**
 * Assert a model's identity and shape: its `type`, that its `version` is valid
 * CalVer, that the named methods/resources are present, and that every method
 * has a non-empty description and a Zod arguments schema. (Cross-file version
 * agreement is enforced separately by `deno task version:check`.)
 */
export function assertModel(
  model: ModelLike,
  type: string,
  methodNames: string[],
  resourceNames: string[],
): void {
  assert(model.type === type, `type ${model.type} !== ${type}`);
  assert(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version), "version is CalVer");
  // swamp calls `.partial()` on `globalArguments` at method-execution time,
  // which throws on a refined object (`z.object(...).refine(...)`). Guard that
  // the schema stays a plain ZodObject so the bug is caught here, in CI, rather
  // than only at `swamp model method run`.
  const ga = model.globalArguments;
  assert(
    typeof ga?.partial === "function",
    "globalArguments must be a ZodObject (exposing .partial())",
  );
  try {
    ga!.partial!();
  } catch (e) {
    throw new Error(
      `globalArguments must be .partial()-able — avoid .refine()/.transform() ` +
        `on the global-args schema (swamp calls .partial() on it): ${e}`,
    );
  }
  for (const name of methodNames) {
    assert(name in model.methods, `missing method ${name}`);
  }
  for (const spec of resourceNames) {
    assert(spec in model.resources, `missing resource ${spec}`);
  }
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
}

/** Build a JSON `Response`, tolerating empty (204/null) bodies. */
export function jsonResponse(status: number, body: unknown): Response {
  // 204 (and other null-body statuses) cannot carry a response body.
  if (status === 204 || body === null) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A `writeResource` call recorded by the harness. */
export interface Written {
  specName: string;
  instanceName: string;
  data: unknown;
}

/** A single HTTP request captured by the stubbed `fetch`. */
export interface Captured {
  method: string;
  path: string;
  search: string;
  json?: Record<string, unknown>;
  raw?: string;
  contentType?: string | null;
}

/** Build a fake context + request log, answering with `handler` per request. */
export function harness(
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
