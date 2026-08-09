/**
 * Generates `catalog.schema.json` and `config.schema.json` from the zod
 * schemas in `src/catalog-schema.ts` and `src/config-schema.ts` — the same
 * schemas `loadCatalog` and `loadConfig` validate with, so a published file
 * cannot drift from what the launcher accepts. A schema is that file's
 * documentation, and this generator refuses to emit an undocumented key.
 *
 * Regenerate with `bun run generate:schemas`. `test/catalog-schema.test.ts`
 * and `test/config-schema.test.ts` fail when a checked-in file drifts from
 * its source.
 */
import { join } from "node:path";
import { z } from "zod";
import { catalogFileSchema } from "../src/catalog-schema.ts";
import { configFileSchema } from "../src/config-schema.ts";

const CATALOG_TITLE = "agentsurface catalog";
const CATALOG_DESCRIPTION =
  "The ordered description of harnesses, their models, and their effort sets, read from the built-in catalog.json shipped with the checkout — or, when it exists, ~/.config/agentsurface/catalog.json (XDG_CONFIG_HOME relocates the directory), which REPLACES the built-in outright rather than merging with it. Every launch consumes it through the --x-harness value: a harness name launches that harness's defaults, <model>:<effort> resolves to the earliest harness in the file's order offering the combination, <harness>:<model>:<effort> pins and validates. Effort sets inherit model > family > harness; defaults live in a \"defaults\" object per harness, per family (supplying a harness that includes it and states none), and per model (effort only). The file is validated strictly and totally at load; every fault is a catalog_invalid error rather than a silently ignored line, and x-doctor reports it.";

const CONFIG_TITLE = "agentsurface launcher configuration";
const CONFIG_DESCRIPTION =
  "Per-user configuration for the agentsurface launcher, read from ~/.config/agentsurface/config.json (XDG_CONFIG_HOME relocates the directory). The file is optional: with no file at all, yolo is ON for every harness (ADR 0009) — the file exists to disable it. When the file does exist it is validated strictly and every fault is a config_invalid domain error that fails the launch — a config that would be silently misread is worse than none, because a disabling config with a typo would quietly launch with the permission gates down against the operator's wishes. Only `x-doctor` downgrades that to a report.";

type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every nested schema node, wherever a JSON Schema can hold one. */
function children(node: Schema): Schema[] {
  const found: Schema[] = [];
  for (const key of ["items", "additionalProperties", "propertyNames"]) {
    const child = node[key];
    if (isObject(child)) found.push(child);
  }
  const properties = node["properties"];
  if (isObject(properties)) {
    for (const child of Object.values(properties)) if (isObject(child)) found.push(child);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const list = node[key];
    if (Array.isArray(list)) for (const child of list) if (isObject(child)) found.push(child);
  }
  return found;
}

/** A schema is its file's documentation: every named property, array item,
 * record value, and union branch must carry a description. */
function assertDocumented(node: unknown, where: string): void {
  if (!isObject(node)) return;
  const union = node["anyOf"] ?? node["oneOf"];
  if (Array.isArray(union)) {
    for (const [index, branch] of union.entries()) {
      assertDocumented(branch, `${where}<${index}>`);
    }
    return;
  }
  if (node["type"] === "object" || node["properties"] !== undefined) {
    if (typeof node["description"] !== "string" && where !== "root") {
      throw new Error(`schema node "${where}" has no description`);
    }
    const props = node["properties"];
    if (isObject(props)) {
      for (const [key, value] of Object.entries(props)) {
        if (!isObject(value) || typeof value["description"] !== "string") {
          throw new Error(`schema property "${where}.${key}" has no description`);
        }
        assertDocumented(value, `${where}.${key}`);
      }
    }
    if (isObject(node["additionalProperties"])) {
      assertDocumented(node["additionalProperties"], `${where}.*`);
    }
    return;
  }
  if (isObject(node["items"])) assertDocumented(node["items"], `${where}[]`);
}

/**
 * zod emits every union as `anyOf`; the published schemas spell one whose
 * branches are mutually exclusive as `oneOf`, the stronger and more useful
 * claim for an editor offering completions. The rewrite asserts the
 * branches really are disjoint by type, so an overlapping union fails the
 * generation rather than being published as something it is not.
 */
function unionsToOneOf(node: Schema): void {
  for (const child of children(node)) unionsToOneOf(child);
  const branches = node["anyOf"];
  if (!Array.isArray(branches)) return;
  const types = branches.map((branch) => (isObject(branch) ? branch["type"] : undefined));
  if (types.some((type) => typeof type !== "string") || new Set(types).size !== types.length) {
    throw new Error("a union's branches are not disjoint by type; publish it as anyOf");
  }
  delete node["anyOf"];
  node["oneOf"] = branches;
}

function publish(schema: z.ZodType, title: string, description: string): Schema {
  const generated = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Schema;
  if (generated["type"] !== "object" || generated["additionalProperties"] !== false) {
    throw new Error(`the ${title} root is no longer a strict object schema`);
  }
  assertDocumented(generated, "root");
  unionsToOneOf(generated);
  const { $schema, ...rest } = generated;
  return { $schema, title, description, ...rest };
}

export function buildCatalogSchema(): Schema {
  return publish(catalogFileSchema, CATALOG_TITLE, CATALOG_DESCRIPTION);
}

export function buildConfigSchema(): Schema {
  return publish(configFileSchema, CONFIG_TITLE, CONFIG_DESCRIPTION);
}

/** Every published schema, by the file it belongs in. */
export const SCHEMAS: ReadonlyArray<{ file: string; build: () => Schema }> = [
  { file: "catalog.schema.json", build: buildCatalogSchema },
  { file: "config.schema.json", build: buildConfigSchema },
];

if (import.meta.main) {
  for (const { file, build } of SCHEMAS) {
    const path = join(import.meta.dir, "..", file);
    await Bun.write(path, `${JSON.stringify(build(), null, 2)}\n`);
    console.log(`wrote ${path}`);
  }
}
