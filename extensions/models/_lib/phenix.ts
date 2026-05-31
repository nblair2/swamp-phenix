/**
 * Shared client for the sceptre-phenix HTTP API.
 *
 * phenix serves a JSON HTTP API rooted at `/api/v1` (plus a few root-level
 * routes such as `/version` and `/features`). Authentication is a bearer-token
 * scheme: either supply a pre-issued long-lived token, or log in with
 * `POST /api/v1/login` (`{user, pass}`) and read the JWT from the response
 * body's `token` field. The token is then sent on every request in the
 * **`X-Phenix-Auth-Token: Bearer <jwt>`** header (phenix deliberately does NOT
 * use the standard `Authorization` header, to avoid clashing with proxy auth).
 *
 * Unlike some APIs, phenix has no response envelope: single resources are
 * returned as bare objects and lists are wrapped under a kind-specific key
 * (e.g. `{experiments: [...]}`, `{vms: [...], total}`, `{configs: [...]}`).
 * Some mutating endpoints (create experiment, start/stop) reply `204 No Content`
 * and broadcast the new state over a websocket instead, so callers re-`GET` the
 * entity to capture its state. Config create/update can take a raw YAML or JSON
 * document body. This module centralizes connection config, the login
 * handshake, request encoding, response/error handling, and small typed schemas
 * and extractors so the model methods stay thin.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";

/**
 * Connection and credential arguments shared by every method of the model.
 * Reused as the model's `globalArguments` schema. Provide either a pre-issued
 * `token`, or a `username`/`password` pair to log in with.
 */
export const GlobalArgsSchema = z.object({
  host: z.string().min(1).describe(
    "phenix server hostname or IP (e.g. phenix.example.com)",
  ),
  port: z.number().int().positive().default(3000).describe(
    "phenix server port (default 3000)",
  ),
  scheme: z.enum(["http", "https"]).default("https").describe(
    "URL scheme used to reach the phenix server (default https)",
  ),
  username: z.string().optional().describe(
    "phenix username (used with password to log in; omit if using token)",
  ),
  password: z.string().meta({ sensitive: true }).optional().describe(
    "phenix password (used with username to log in; omit if using token)",
  ),
  token: z.string().meta({ sensitive: true }).optional().describe(
    "Pre-issued long-lived phenix API token (JWT); when set, login is skipped",
  ),
  caCert: z.string().meta({ sensitive: true }).optional().describe(
    "PEM-encoded CA certificate to trust when the phenix server uses a " +
      "self-signed or private-CA certificate",
  ),
});
// NOTE: the "token, or username+password" rule is enforced at runtime in
// `connect()` rather than with a Zod `.refine()` here. swamp calls `.partial()`
// on a model's `globalArguments` at method-execution time, which throws on a
// refined object ("`.partial()` cannot be used on object schemas containing
// refinements") — so the global-args schema must stay a plain ZodObject.

/** Validated connection/credential arguments. */
export type PhenixGlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Successful result of a single API call: the HTTP status and parsed body. */
export interface ApiResult {
  /** HTTP status code of the response. */
  status: number;
  /** The parsed JSON response body (object, array, or null for empty/204). */
  body: unknown;
}

/** Error thrown when phenix returns a non-OK HTTP status. */
export class PhenixApiError extends Error {
  /** HTTP status code that accompanied the failure (0 for client-side errors). */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PhenixApiError";
    this.status = status;
  }
}

/** Minimal fetch signature so tests can inject a stub. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Reads a file's bytes; defaults to `Deno.readFile`, overridable in tests. */
export type ReadFileLike = (path: string) => Promise<Uint8Array>;

/** Optional dependencies, primarily for testing. */
export interface PhenixDeps {
  /** Override the global `fetch` (used to stub HTTP in unit tests). */
  fetch?: FetchLike;
  /** Override file reading (used to stub config-file uploads in unit tests). */
  readFile?: ReadFileLike;
}

/** Query-string values: scalars or arrays (arrays repeat the key). */
export type QueryValue = string | number | boolean | string[] | undefined;

/** Per-request options shared by every verb. */
export interface RequestOpts {
  /** Query-string parameters appended to the URL. */
  query?: Record<string, QueryValue>;
  /** HTTP statuses to treat as success (e.g. `[404]` to tolerate "not found"). */
  allowStatuses?: number[];
}

/** A connected, authenticated phenix client. */
export interface PhenixClient {
  /** Issue a GET against `path` (relative to the server root, e.g. `/api/v1/...`). */
  get(path: string, opts?: RequestOpts): Promise<ApiResult>;
  /** Issue a POST with an optional JSON body. */
  post(
    path: string,
    body?: Record<string, unknown>,
    opts?: RequestOpts,
  ): Promise<ApiResult>;
  /** Issue a PATCH with a JSON body. */
  patch(
    path: string,
    body: Record<string, unknown>,
    opts?: RequestOpts,
  ): Promise<ApiResult>;
  /** Issue a PUT with an optional JSON body. */
  put(
    path: string,
    body?: Record<string, unknown>,
    opts?: RequestOpts,
  ): Promise<ApiResult>;
  /** Issue a DELETE. */
  del(path: string, opts?: RequestOpts): Promise<ApiResult>;
  /** Issue a POST with a raw text body (e.g. a YAML/JSON config document). */
  postRaw(
    path: string,
    body: string,
    contentType: string,
    opts?: RequestOpts,
  ): Promise<ApiResult>;
  /** Issue a PUT with a raw text body (e.g. a YAML/JSON config document). */
  putRaw(
    path: string,
    body: string,
    contentType: string,
    opts?: RequestOpts,
  ): Promise<ApiResult>;
}

/** Build the server root URL (`<scheme>://host:port`) for a connection. */
export function baseUrl(
  cfg: Pick<PhenixGlobalArgs, "host" | "port" | "scheme">,
): string {
  return `${cfg.scheme}://${cfg.host}:${cfg.port}`;
}

/** Append query parameters to a URL, repeating keys for array values. */
function withQuery(url: string, query?: Record<string, QueryValue>): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) u.searchParams.append(key, String(item));
    } else {
      u.searchParams.append(key, String(value));
    }
  }
  return u.toString();
}

/**
 * Remove path-traversal and separator characters so a name is safe to use as a
 * swamp resource instance name (which maps directly to a storage path).
 */
export function sanitizeInstanceName(name: string): string {
  return name.replace(/\.\./g, "").replace(/[/\\]/g, "_");
}

/** Parse a response body as JSON, tolerating empty (204) and non-JSON bodies. */
async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON body (e.g. a proxy error page or plain-text error).
    return text;
  }
}

/** Pull a human-readable message out of a parsed error body. */
function errorMessage(body: unknown, status: number): string {
  if (typeof body === "string" && body.length > 0) return body;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const key of ["error", "message", "msg"]) {
      if (typeof o[key] === "string") return o[key] as string;
    }
  }
  return `phenix request failed (HTTP ${status})`;
}

/** Build a Deno HTTP client that trusts a private CA cert, if one is provided. */
function caClientInit(cfg: PhenixGlobalArgs, deps: PhenixDeps): RequestInit {
  if (cfg.caCert && !deps.fetch && "createHttpClient" in Deno) {
    const httpClient = (Deno as unknown as {
      createHttpClient: (o: { caCerts: string[] }) => unknown;
    }).createHttpClient({ caCerts: [cfg.caCert] });
    return { client: httpClient } as RequestInit;
  }
  return {};
}

/**
 * Obtain a bearer token: return the pre-issued `token` if set, otherwise log in
 * via `POST /api/v1/login` and read the JWT from the response body's `token`.
 */
async function authenticate(
  cfg: PhenixGlobalArgs,
  fetchFn: FetchLike,
  root: string,
  clientInit: RequestInit,
): Promise<string> {
  if (cfg.token) return cfg.token;
  const res = await fetchFn(`${root}/api/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: cfg.username, pass: cfg.password }),
    ...clientInit,
  });
  const body = await parseBody(res);
  if (!res.ok) {
    throw new PhenixApiError(errorMessage(body, res.status), res.status);
  }
  const token = (body && typeof body === "object")
    ? (body as Record<string, unknown>).token
    : undefined;
  if (typeof token !== "string" || token.length === 0) {
    throw new PhenixApiError(
      "login succeeded but no token was returned",
      res.status,
    );
  }
  return token;
}

/**
 * Connect to phenix and return an authenticated client.
 *
 * Resolves a bearer token (pre-issued `token`, or a `POST /api/v1/login`
 * handshake) and returns helpers that attach it as `X-Phenix-Auth-Token:
 * Bearer <jwt>` on every call. When `caCert` is set, a dedicated Deno HTTP
 * client is created so a self-signed/private-CA server certificate is trusted.
 */
export async function connect(
  cfg: PhenixGlobalArgs,
  deps: PhenixDeps = {},
): Promise<PhenixClient> {
  if (!cfg.token && !(cfg.username && cfg.password)) {
    throw new PhenixApiError(
      "provide either a token, or both username and password",
      0,
    );
  }
  const fetchFn: FetchLike = deps.fetch ?? (globalThis.fetch as FetchLike);
  const root = baseUrl(cfg);
  const clientInit = caClientInit(cfg, deps);
  const token = await authenticate(cfg, fetchFn, root, clientInit);

  async function send(
    method: string,
    path: string,
    opts: {
      body?: Record<string, unknown>;
      raw?: { text: string; contentType: string };
      query?: Record<string, QueryValue>;
      allowStatuses?: number[];
    },
  ): Promise<ApiResult> {
    const headers: Record<string, string> = {
      "X-Phenix-Auth-Token": `Bearer ${token}`,
    };
    let bodyInit: BodyInit | undefined;
    if (opts.raw !== undefined) {
      headers["Content-Type"] = opts.raw.contentType;
      bodyInit = opts.raw.text;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(opts.body);
    }
    const res = await fetchFn(withQuery(`${root}${path}`, opts.query), {
      method,
      headers,
      body: bodyInit,
      ...clientInit,
    });
    const body = await parseBody(res);
    if (!res.ok && !(opts.allowStatuses ?? []).includes(res.status)) {
      throw new PhenixApiError(errorMessage(body, res.status), res.status);
    }
    return { status: res.status, body };
  }

  return {
    get: (path, opts) =>
      send("GET", path, {
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    post: (path, body, opts) =>
      send("POST", path, {
        body,
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    patch: (path, body, opts) =>
      send("PATCH", path, {
        body,
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    put: (path, body, opts) =>
      send("PUT", path, {
        body,
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    del: (path, opts) =>
      send("DELETE", path, {
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    postRaw: (path, text, contentType, opts) =>
      send("POST", path, {
        raw: { text, contentType },
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    putRaw: (path, text, contentType, opts) =>
      send("PUT", path, {
        raw: { text, contentType },
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
  };
}

// --- Response helpers -------------------------------------------------------

/** Return `body` as a plain object, or `{}` if it is an array / scalar / null. */
export function asObject(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

/**
 * Extract a list of objects from a phenix response. A bare array body is
 * returned as-is; otherwise the first array found among `keys` on the body
 * object is used (tolerating a missing key or a `null` value).
 */
export function listFrom(
  body: unknown,
  ...keys: string[]
): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const o = asObject(body);
  for (const key of keys) {
    const value = o[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [];
}

/** Extract experiments from a list response (`{experiments: [...]}`). */
export const experimentsFromData = (body: unknown) =>
  listFrom(body, "experiments");

/** Extract VMs from a list response (`{vms: [...], total}`). */
export const vmsFromData = (body: unknown) => listFrom(body, "vms");

/** Extract configs from a list response (`{configs: [...]}`). */
export const configsFromData = (body: unknown) => listFrom(body, "configs");

/** Extract cluster hosts from a list response (`{hosts: [...]}`). */
export const hostsFromData = (body: unknown) => listFrom(body, "hosts");

/** Extract disk images from a list response (`{disks: [...]}`). */
export const disksFromData = (body: unknown) => listFrom(body, "disks");

/** Extract users from a list response (`{users: [...]}`). */
export const usersFromData = (body: unknown) => listFrom(body, "users");

/** Extract roles from a list response (`{roles: [...]}`). */
export const rolesFromData = (body: unknown) => listFrom(body, "roles");

/** Extract applications (phenix apps) from a list response. */
export const applicationsFromData = (body: unknown) =>
  listFrom(body, "apps", "applications");

/** Extract topologies from a list response (`{topologies: [...]}`). */
export const topologiesFromData = (body: unknown) =>
  listFrom(body, "topologies");

// --- Loose response schemas (phenix fields vary by version) -----------------

/** Array field that normalizes a missing key or `null` to `[]`. */
const arr = (el: z.ZodTypeAny) =>
  z.array(el).nullish().transform((v) => v ?? []);

/** An experiment as returned by the experiments endpoints. */
export const ExperimentSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  topology: z.string().optional(),
  scenario: z.string().optional(),
  start_time: z.string().optional(),
  running: z.boolean().optional(),
  status: z.string().optional(),
  vlan_min: z.number().optional(),
  vlan_max: z.number().optional(),
  vlan_count: z.number().optional(),
  vm_count: z.number().optional(),
  apps: arr(z.string()),
}).passthrough();

/** A VM as returned by the VM endpoints. */
export const VMSchema = z.object({
  name: z.string(),
  host: z.string().optional(),
  ipv4: arr(z.string()),
  cpus: z.number().optional(),
  ram: z.number().optional(),
  disk: z.string().optional(),
  uptime: z.number().optional(),
  networks: arr(z.string()),
  taps: arr(z.string()),
  dnb: z.boolean().optional(),
  running: z.boolean().optional(),
  busy: z.boolean().optional(),
  experiment: z.string().optional(),
  state: z.string().optional(),
  cd_rom: z.string().optional(),
  external: z.boolean().optional(),
  snapshot: z.boolean().optional(),
}).passthrough();

/** A config (Topology/Scenario/Experiment/Image/User) envelope. */
export const ConfigSchema = z.object({
  apiVersion: z.string().optional(),
  kind: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
  status: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** A cluster host (head/compute node). */
export const HostSchema = z.object({
  name: z.string(),
  cpus: z.number().optional(),
  load: arr(z.union([z.number(), z.string()])),
  memused: z.number().optional(),
  memtotal: z.number().optional(),
  vms: z.number().optional(),
  schedulable: z.boolean().optional(),
  headnode: z.boolean().optional(),
}).passthrough();

/** A disk image as returned by `/api/v1/disks`. */
export const DiskSchema = z.object({
  name: z.string(),
  kind: z.string().optional(),
  size: z.union([z.number(), z.string()]).optional(),
  virtualSize: z.union([z.number(), z.string()]).optional(),
  inUse: z.boolean().optional(),
  backingImages: arr(z.string()),
}).passthrough();

/** A phenix UI user. */
export const UserSchema = z.object({
  username: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  resource_names: arr(z.string()),
  role: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** A long-lived API token (from `POST /api/v1/users/{u}/tokens`). */
export const TokenSchema = z.object({
  token: z.string(),
  desc: z.string().optional(),
  exp: z.string().optional(),
}).passthrough();
