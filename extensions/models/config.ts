/**
 * The `@nblair2/phenix/config` model: CRUD over phenix config objects. phenix
 * stores all of its declarative objects — Topology, Scenario, Experiment, Image,
 * User — as Kubernetes-style configs (`{apiVersion, kind, metadata, spec}`)
 * under `/api/v1/configs`. These methods list / get / create / update / delete
 * any of them. Create and update accept either an inline object or a path to a
 * local YAML/JSON document. Connection details are configured once via the
 * model's global arguments; the HTTP client and shared plumbing live in
 * `./_lib/`.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  asObject,
  ConfigSchema,
  configsFromData,
  GlobalArgsSchema,
  type ReadDirLike,
  type ReadFileLike,
} from "./_lib/phenix.ts";
import {
  clientFor,
  type MethodResult,
  type ModelContext,
} from "./_lib/model.ts";

const PREFIX = "config";

/** Build the `<kind>-<name>` instance suffix for a config object. */
function configKey(cfg: Record<string, unknown>): string {
  const kind = typeof cfg.kind === "string" ? cfg.kind.toLowerCase() : "config";
  const meta = asObject(cfg.metadata);
  const name = typeof meta.name === "string" ? meta.name : "unknown";
  return `${kind}-${name}`;
}

/** Parse a `<kind>-<name>` key from a `…/configs/<kind>/<name>` Location URL. */
function keyFromLocation(loc: string | undefined): string | undefined {
  if (!loc) return undefined;
  const m = loc.match(/\/configs\/([^/]+)\/([^/?#]+)\/?$/);
  if (!m) return undefined;
  return `${decodeURIComponent(m[1]).toLowerCase()}-${
    decodeURIComponent(m[2])
  }`;
}

/**
 * Instance suffix (`<kind>-<name>`) for a created/uploaded config document.
 *
 * phenix answers a successful create with `201 Created` + an EMPTY body +
 * `Location: /api/v1/configs/<kind>/<name>`, so the canonical identity lives in
 * the Location header — prefer it (it's authoritative, unique, and matches what
 * `config_list`/`config_get` store; the local file name often differs from the
 * config's `metadata.name`). Fall back to an echoed full body, then to the
 * file's stem — without a fallback an empty body makes every file in a
 * directory collide on `config-unknown` ("Duplicate data instance name").
 */
function uploadKey(
  location: string | undefined,
  created: Record<string, unknown>,
  file: string,
): string {
  const fromLocation = keyFromLocation(location);
  if (fromLocation) return fromLocation;
  const meta = asObject(created.metadata);
  if (typeof created.kind === "string" && typeof meta.name === "string") {
    return configKey(created);
  }
  return (file.split(/[/\\]/).pop() ?? file).replace(/\.(ya?ml|json)$/i, "");
}

/** Sanitize a path-ish instance key (mirrors model.inst, applied to our key). */
function instKey(key: string): string {
  return `${PREFIX}-${key.replace(/\.\./g, "").replace(/[/\\]/g, "_")}`;
}

/** Read a local config document and guess its content type from the extension. */
async function readConfigFile(
  path: string,
  readFile: ReadFileLike,
): Promise<{ text: string; contentType: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read config file '${path}': ${reason}`);
  }
  const text = new TextDecoder().decode(bytes);
  const contentType = /\.json$/i.test(path)
    ? "application/json"
    : "application/x-yaml";
  return { text, contentType };
}

/** Default directory lister: the `.yml`/`.yaml`/`.json` file names in `path`. */
const defaultReadDir: ReadDirLike = async (path) => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    if (entry.isFile) names.push(entry.name);
  }
  return names;
};

const KindNameArgs = z.object({
  kind: z.string().min(1).describe(
    "Config kind: Topology, Scenario, Experiment, Image, or User",
  ),
  name: z.string().min(1).describe("Config name (metadata.name)"),
});

const UploadDirArgs = z.object({
  dir: z.string().min(1).describe(
    "Local directory whose .yml/.yaml/.json config documents are all uploaded",
  ),
});

const UpsertArgs = z.object({
  config: z.record(z.string(), z.unknown()).optional().describe(
    "Inline config object ({apiVersion, kind, metadata, spec}); " +
      "mutually exclusive with file",
  ),
  file: z.string().optional().describe(
    "Path to a local YAML or JSON config document; mutually exclusive with config",
  ),
}).refine((a) => !!a.config !== !!a.file, {
  message: "provide exactly one of config or file",
});

const UpdateArgs = z.object({
  kind: z.string().min(1).describe(
    "Config kind: Topology, Scenario, Experiment, Image, or User",
  ),
  name: z.string().min(1).describe("Config name (metadata.name)"),
  config: z.record(z.string(), z.unknown()).optional().describe(
    "Inline replacement config object; mutually exclusive with file",
  ),
  file: z.string().optional().describe(
    "Path to a local YAML or JSON config document; mutually exclusive with config",
  ),
}).refine((a) => !!a.config !== !!a.file, {
  message: "provide exactly one of config or file",
});

const methods = {
  config_list: {
    description: "List all phenix configs, storing each one",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/configs");
      const handles = [];
      for (const cfg of configsFromData(res.body)) {
        handles.push(
          await context.writeResource("config", instKey(configKey(cfg)), cfg),
        );
      }
      return { dataHandles: handles };
    },
  },

  config_get: {
    description: "Fetch a single config by kind and name and store it",
    arguments: KindNameArgs,
    execute: async (
      args: z.infer<typeof KindNameArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/configs/${encodeURIComponent(args.kind)}/${
          encodeURIComponent(args.name)
        }`,
      );
      const cfg = asObject(res.body);
      const handle = await context.writeResource(
        "config",
        instKey(configKey(cfg)),
        cfg,
      );
      return { dataHandles: [handle] };
    },
  },

  config_create: {
    description:
      "Create a config from an inline object or a local YAML/JSON file",
    arguments: UpsertArgs,
    execute: async (
      args: z.infer<typeof UpsertArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      let created: Record<string, unknown>;
      let location: string | undefined;
      if (args.file) {
        const readFile = context._deps?.readFile ?? Deno.readFile;
        const { text, contentType } = await readConfigFile(args.file, readFile);
        const res = await client.postRaw("/api/v1/configs", text, contentType);
        created = asObject(res.body);
        location = res.location;
      } else {
        const res = await client.post("/api/v1/configs", args.config!);
        created = asObject(res.body);
        location = res.location;
      }
      // 201 returns an empty body + Location; if the body was empty AND we have
      // an inline config, keep it as the stored data.
      if (Object.keys(created).length === 0 && args.config) {
        created = args.config;
      }
      const handle = await context.writeResource(
        "config",
        // Identity from the Location header (canonical), else the echoed/inline
        // body's kind+name, else the file stem — never a bare `config-unknown`.
        instKey(uploadKey(location, created, args.file ?? "")),
        Object.keys(created).length > 0 ? created : { file: args.file },
      );
      return { dataHandles: [handle] };
    },
  },

  config_upload_dir: {
    description:
      "Upload every .yml/.yaml/.json config document in a local directory " +
      "(one locked call instead of one per file), storing each created config",
    arguments: UploadDirArgs,
    execute: async (
      args: z.infer<typeof UploadDirArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const readFile = context._deps?.readFile ?? Deno.readFile;
      const readDir = context._deps?.readDir ?? defaultReadDir;
      const dir = args.dir.replace(/\/+$/, "");
      const files = (await readDir(dir))
        .filter((n) => /\.(ya?ml|json)$/i.test(n))
        .sort();
      if (files.length === 0) {
        throw new Error(`no config files (.yml/.yaml/.json) found in '${dir}'`);
      }
      const handles = [];
      for (const file of files) {
        const { text, contentType } = await readConfigFile(
          `${dir}/${file}`,
          readFile,
        );
        const res = await client.postRaw("/api/v1/configs", text, contentType);
        const created = asObject(res.body);
        handles.push(
          await context.writeResource(
            "config",
            instKey(uploadKey(res.location, created, file)),
            Object.keys(created).length > 0 ? created : { file },
          ),
        );
      }
      return { dataHandles: handles };
    },
  },

  config_update: {
    description:
      "Replace an existing config (by kind/name) from an inline object or file",
    arguments: UpdateArgs,
    execute: async (
      args: z.infer<typeof UpdateArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const path = `/api/v1/configs/${encodeURIComponent(args.kind)}/${
        encodeURIComponent(args.name)
      }`;
      if (args.file) {
        const readFile = context._deps?.readFile ?? Deno.readFile;
        const { text, contentType } = await readConfigFile(args.file, readFile);
        await client.putRaw(path, text, contentType);
      } else {
        await client.put(path, args.config!);
      }
      // PUT replies 204; re-read so stored state reflects the update.
      const res = await client.get(path);
      const cfg = asObject(res.body);
      const handle = await context.writeResource(
        "config",
        instKey(`${args.kind.toLowerCase()}-${args.name}`),
        Object.keys(cfg).length > 0
          ? cfg
          : { kind: args.kind, name: args.name },
      );
      return { dataHandles: [handle] };
    },
  },

  config_delete: {
    description: "Delete a config by kind and name",
    arguments: KindNameArgs,
    execute: async (
      args: z.infer<typeof KindNameArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.del(
        `/api/v1/configs/${encodeURIComponent(args.kind)}/${
          encodeURIComponent(args.name)
        }`,
      );
      return { dataHandles: [] };
    },
  },
};

/** The `@nblair2/phenix/config` model. */
export const model = {
  type: "@nblair2/phenix/config",
  version: "2026.05.31.6",
  globalArguments: GlobalArgsSchema,
  resources: {
    config: {
      description:
        "A phenix config object (Topology, Scenario, Experiment, Image or User)",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods,
};
