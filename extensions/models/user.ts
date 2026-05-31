/**
 * The `@nblair2/phenix/user` model: identity management — phenix UI users, RBAC
 * roles, and long-lived API tokens. Users are stored keyed by username; created
 * tokens and the role catalog are recorded as one-shot operation results.
 * Connection details are configured once via the model's global arguments; the
 * HTTP client and shared plumbing live in `./_lib/`.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  asObject,
  GlobalArgsSchema,
  rolesFromData,
  UserSchema,
  usersFromData,
} from "./_lib/phenix.ts";
import {
  clientFor,
  inst,
  type MethodResult,
  type ModelContext,
  operationSchema,
  writeOperation,
} from "./_lib/model.ts";

const PREFIX = "user";

/** Store a user object keyed by its `username`. */
function writeUser(
  context: ModelContext,
  user: Record<string, unknown>,
) {
  const name = typeof user.username === "string" ? user.username : "unknown";
  return context.writeResource("user", inst(PREFIX, name), user);
}

const UsernameArg = z.object({
  username: z.string().min(1).describe("Username"),
});

const CreateUserArgs = z.object({
  username: z.string().min(1).describe("New username"),
  password: z.string().meta({ sensitive: true }).describe("Initial password"),
  firstName: z.string().optional().describe("First name"),
  lastName: z.string().optional().describe("Last name"),
  roleName: z.string().min(1).describe(
    "RBAC role name (e.g. 'Global Admin', 'VM Viewer')",
  ),
  resourceNames: z.array(z.string()).optional().describe(
    "Resource-name globs the role is scoped to (e.g. ['*'])",
  ),
});

const TokenArgs = z.object({
  username: z.string().min(1).describe("User to mint a token for"),
  lifetime: z.string().min(1).describe(
    "Token lifetime: a Go duration ('720h') or an integer number of days",
  ),
  desc: z.string().optional().describe("Description for the token"),
});

const methods = {
  user_list: {
    description: "List all phenix users, storing each one",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/users");
      const handles = [];
      for (const user of usersFromData(res.body)) {
        handles.push(await writeUser(context, user));
      }
      return { dataHandles: handles };
    },
  },

  user_get: {
    description: "Fetch a single user by username and store it",
    arguments: UsernameArg,
    execute: async (
      args: z.infer<typeof UsernameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(
        `/api/v1/users/${encodeURIComponent(args.username)}`,
      );
      const handle = await writeUser(context, asObject(res.body));
      return { dataHandles: [handle] };
    },
  },

  user_create: {
    description: "Create a phenix user with an RBAC role",
    arguments: CreateUserArgs,
    execute: async (
      args: z.infer<typeof CreateUserArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body: Record<string, unknown> = {
        username: args.username,
        password: args.password,
        role_name: args.roleName,
      };
      if (args.firstName !== undefined) body.first_name = args.firstName;
      if (args.lastName !== undefined) body.last_name = args.lastName;
      if (args.resourceNames !== undefined) {
        body.resource_names = args.resourceNames;
      }
      const res = await client.post("/api/v1/users", body);
      const created = asObject(res.body);
      const handle = await writeUser(
        context,
        typeof created.username === "string"
          ? created
          : { username: args.username },
      );
      return { dataHandles: [handle] };
    },
  },

  user_delete: {
    description: "Delete a phenix user",
    arguments: UsernameArg,
    execute: async (
      args: z.infer<typeof UsernameArg>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.del(`/api/v1/users/${encodeURIComponent(args.username)}`);
      return { dataHandles: [] };
    },
  },

  role_list: {
    description: "List the available RBAC roles",
    arguments: z.object({}),
    execute: async (
      _args: Record<string, never>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/api/v1/roles");
      return writeOperation(context, "role_list", {
        result: rolesFromData(res.body),
      });
    },
  },

  token_create: {
    description:
      "Mint a long-lived API token for a user (the result includes the " +
      "secret token value — handle it carefully)",
    arguments: TokenArgs,
    execute: async (
      args: z.infer<typeof TokenArgs>,
      context: ModelContext,
    ): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.post(
        `/api/v1/users/${encodeURIComponent(args.username)}/tokens`,
        { lifetime: args.lifetime, desc: args.desc ?? "" },
      );
      return writeOperation(context, "token_create", {
        target: args.username,
        result: res.body,
      });
    },
  },
};

/** The `@nblair2/phenix/user` model. */
export const model = {
  type: "@nblair2/phenix/user",
  version: "2026.05.30.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    user: {
      description: "A phenix UI user and its RBAC role",
      schema: UserSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    operation: {
      description:
        "Outcome of a one-shot phenix action (role list, token mint, etc.)",
      schema: operationSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods,
};
