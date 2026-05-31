#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=swamp
/**
 * Release-version helper for the `@nblair2/phenix` extension.
 *
 * The published version lives in two places that must agree: the `version` in
 * `manifest.yaml` (what the registry publishes) and the `version` field of the
 * exported `model` in `extensions/models/phenix.ts`. This script is the single
 * source of truth for keeping them in lock-step. It is intentionally kept
 * outside `extensions/` so it never becomes part of the published bundle.
 *
 * Usage:
 *   deno task bump [version]   # write a new CalVer into both files
 *   deno task version:check    # assert the two files agree and are valid CalVer
 *
 * `bump` with no argument asks `swamp extension version` for the next CalVer
 * (works unauthenticated); pass an explicit `YYYY.MM.DD.MICRO` to override.
 *
 * @module
 */
const ROOT = `${import.meta.dirname}/..`;
const MANIFEST = `${ROOT}/manifest.yaml`;
const MODEL = `${ROOT}/extensions/models/phenix.ts`;

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

/** The `version: "..."` in `manifest.yaml` (top-level key). */
const MANIFEST_VERSION = /^version:\s*"([^"]+)"/m;
/** The `version: "..."` field of the exported model in `phenix.ts`. */
const MODEL_VERSION = /^\s*version:\s*"([^"]+)"/m;

/** Read the current version recorded in each file (null if not found). */
async function readVersions(): Promise<
  { manifest: string | null; model: string | null }
> {
  const manifestText = await Deno.readTextFile(MANIFEST);
  const modelText = await Deno.readTextFile(MODEL);
  return {
    manifest: MANIFEST_VERSION.exec(manifestText)?.[1] ?? null,
    model: MODEL_VERSION.exec(modelText)?.[1] ?? null,
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

/** Write `version` into both `manifest.yaml` and `phenix.ts`. */
async function bump(version: string): Promise<void> {
  if (!isValidCalVer(version)) {
    throw new Error(
      `'${version}' is not a valid CalVer (expected YYYY.MM.DD.MICRO naming a real date)`,
    );
  }
  const { manifest: oldManifest, model: oldModel } = await readVersions();

  const manifestText = await Deno.readTextFile(MANIFEST);
  await Deno.writeTextFile(
    MANIFEST,
    replaceVersion(manifestText, MANIFEST_VERSION, version),
  );

  const modelText = await Deno.readTextFile(MODEL);
  await Deno.writeTextFile(
    MODEL,
    replaceVersion(modelText, MODEL_VERSION, version),
  );

  console.log(`manifest.yaml: ${oldManifest} → ${version}`);
  console.log(`phenix.ts:     ${oldModel} → ${version}`);
}

/** Assert the two files agree and hold a valid CalVer; exit non-zero if not. */
async function check(): Promise<void> {
  const { manifest, model } = await readVersions();
  const problems: string[] = [];
  if (!manifest) problems.push("no version found in manifest.yaml");
  if (!model) problems.push("no version found in extensions/models/phenix.ts");
  if (manifest && !isValidCalVer(manifest)) {
    problems.push(`manifest.yaml version '${manifest}' is not valid CalVer`);
  }
  if (model && !isValidCalVer(model)) {
    problems.push(`phenix.ts version '${model}' is not valid CalVer`);
  }
  if (manifest && model && manifest !== model) {
    problems.push(
      `version mismatch: manifest.yaml is '${manifest}' but phenix.ts is ` +
        `'${model}' — run \`deno task bump ${manifest}\` to sync them`,
    );
  }
  if (problems.length > 0) {
    console.error("version check failed:");
    for (const p of problems) console.error(`  - ${p}`);
    Deno.exit(1);
  }
  console.log(`version OK: ${manifest}`);
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
