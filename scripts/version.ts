#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=swamp
/**
 * Release-version helper for the `@nblair2/phenix` extension.
 *
 * The published version lives in several places that must agree: the `version`
 * in `manifest.yaml` (what the registry publishes) and the `version` literal in
 * each of the five model files under `extensions/models/` (`config.ts`,
 * `experiment.ts`, `vm.ts`, `cluster.ts`, `user.ts`). The registry parses each
 * model's `version` from its source as a string literal, so it cannot be a
 * shared constant — every model carries its own copy. This script keeps them
 * all in lock-step. It is kept outside `extensions/` so it never becomes part
 * of the published bundle.
 *
 * Usage:
 *   deno task bump [version]   # write a new CalVer into the manifest + models
 *   deno task version:check    # assert every file agrees and is valid CalVer
 *
 * `bump` with no argument asks `swamp extension version` for the next CalVer
 * (works unauthenticated); pass an explicit `YYYY.MM.DD.MICRO` to override.
 *
 * @module
 */
const ROOT = `${import.meta.dirname}/..`;
const MANIFEST = `${ROOT}/manifest.yaml`;
const MODELS_DIR = `${ROOT}/extensions/models`;
/** The model entry-point files, each carrying its own `version` literal. */
const MODEL_FILES = [
  "config.ts",
  "experiment.ts",
  "vm.ts",
  "cluster.ts",
  "user.ts",
]
  .map((f) => `${MODELS_DIR}/${f}`);

const CALVER = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/;

/** True if `v` is a syntactically valid CalVer that names a real calendar date. */
function isValidCalVer(v: string): boolean {
  const m = CALVER.exec(v);
  if (!m) return false;
  const [, y, mo, d] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

/** The top-level `version: "..."` in `manifest.yaml`. */
const MANIFEST_VERSION = /^version:\s*"([^"]+)"/m;
/** The `version: "..."` literal in a model's exported object. */
const MODEL_VERSION = /^\s*version:\s*"([^"]+)"/m;

/** A file path paired with the version literal found in it (or null). */
interface FileVersion {
  path: string;
  label: string;
  version: string | null;
}

/** Read the current version recorded in the manifest and every model file. */
async function readVersions(): Promise<{
  manifest: string | null;
  models: FileVersion[];
}> {
  const manifestText = await Deno.readTextFile(MANIFEST);
  const models: FileVersion[] = [];
  for (const path of MODEL_FILES) {
    const text = await Deno.readTextFile(path);
    models.push({
      path,
      label: `extensions/models/${path.split("/").pop()}`,
      version: MODEL_VERSION.exec(text)?.[1] ?? null,
    });
  }
  return {
    manifest: MANIFEST_VERSION.exec(manifestText)?.[1] ?? null,
    models,
  };
}

/** Ask `swamp extension version` for the next CalVer for this extension. */
async function nextVersionFromSwamp(): Promise<string> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("swamp", {
      args: ["extension", "version", "--manifest", MANIFEST, "--json"],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch {
    throw new Error(
      "could not run `swamp` to compute the next version — install swamp, or " +
        "pass an explicit version, e.g. `deno task bump 2026.05.30.1`",
    );
  }
  const out = new TextDecoder().decode(output.stdout).trim();
  // swamp prints `{ "error": "..." }` to stdout (not stderr) on failure.
  let parsed: { nextVersion?: unknown; error?: unknown } = {};
  try {
    parsed = JSON.parse(out);
  } catch { /* fall through to the error below */ }
  if (!output.success || typeof parsed.error === "string") {
    const detail = typeof parsed.error === "string"
      ? parsed.error
      : (out || new TextDecoder().decode(output.stderr).trim());
    throw new Error(
      `could not compute the next version via swamp: ${detail}\n` +
        "pass an explicit version instead, e.g. `deno task bump 2026.05.30.1`",
    );
  }
  if (typeof parsed.nextVersion !== "string") {
    throw new Error("`swamp extension version` did not return a nextVersion");
  }
  return parsed.nextVersion;
}

/** Replace the version literal in a file's text, requiring exactly one match. */
function replaceVersion(
  text: string,
  pattern: RegExp,
  version: string,
): string {
  if (!pattern.test(text)) {
    throw new Error("could not locate a version field to update");
  }
  return text.replace(
    pattern,
    (line) => line.replace(/"[^"]+"/, `"${version}"`),
  );
}

/** Write `version` into `manifest.yaml` and every model file. */
async function bump(version: string): Promise<void> {
  if (!isValidCalVer(version)) {
    throw new Error(
      `'${version}' is not a valid CalVer (expected YYYY.MM.DD.MICRO naming a real date)`,
    );
  }
  const { manifest: oldManifest, models } = await readVersions();

  const manifestText = await Deno.readTextFile(MANIFEST);
  await Deno.writeTextFile(
    MANIFEST,
    replaceVersion(manifestText, MANIFEST_VERSION, version),
  );
  console.log(`manifest.yaml: ${oldManifest} → ${version}`);

  for (const m of models) {
    const text = await Deno.readTextFile(m.path);
    await Deno.writeTextFile(
      m.path,
      replaceVersion(text, MODEL_VERSION, version),
    );
    console.log(`${m.label}: ${m.version} → ${version}`);
  }
}

/** Assert the manifest and every model agree on a valid CalVer; exit 1 if not. */
async function check(): Promise<void> {
  const { manifest, models } = await readVersions();
  const problems: string[] = [];

  if (!manifest) problems.push("no version found in manifest.yaml");
  if (manifest && !isValidCalVer(manifest)) {
    problems.push(`manifest.yaml version '${manifest}' is not valid CalVer`);
  }
  for (const m of models) {
    if (!m.version) {
      problems.push(`no version found in ${m.label}`);
    } else if (!isValidCalVer(m.version)) {
      problems.push(`${m.label} version '${m.version}' is not valid CalVer`);
    } else if (manifest && m.version !== manifest) {
      problems.push(
        `version mismatch: manifest.yaml is '${manifest}' but ${m.label} is ` +
          `'${m.version}' — run \`deno task bump ${manifest}\` to sync them`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("version check failed:");
    for (const p of problems) console.error(`  - ${p}`);
    Deno.exit(1);
  }
  console.log(`version OK: ${manifest} (manifest + ${models.length} models)`);
}

async function main(): Promise<void> {
  const [cmd, arg] = Deno.args;
  switch (cmd) {
    case "bump":
      await bump(arg ?? await nextVersionFromSwamp());
      break;
    case "check":
      await check();
      break;
    default:
      console.error("usage: version.ts <bump [version] | check>");
      Deno.exit(2);
  }
}

await main();
