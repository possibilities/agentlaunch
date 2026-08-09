/**
 * Generates `catalog.schema.json` from the zod schema in
 * `src/catalog-schema.ts` — the same schema `loadCatalog` validates with, so
 * the published file cannot drift from what the launcher accepts. The schema
 * is the catalog surface's documentation, and this generator refuses to emit
 * an undocumented key.
 *
 * Regenerate with `bun run generate:schema`. `test/catalog-schema.test.ts`
 * fails when the checked-in file drifts from this source.
 */
import { join } from "node:path";
import { z } from "zod";
import { catalogFileSchema } from "../src/catalog-schema.ts";

const TITLE = "agentsurface catalog";
const DESCRIPTION =
  "The ordered description of harnesses, their models, and their effort sets, read from the built-in catalog.json shipped with the checkout — or, when it exists, ~/.config/agentsurface/catalog.json (XDG_CONFIG_HOME relocates the directory), which REPLACES the built-in outright rather than merging with it. Harness order is load-bearing: an ambiguous model/effort request resolves to the earliest matching harness, and the first entry is the default. The file is validated strictly; every fault is a catalog_invalid error rather than a silently ignored line, and x-doctor reports it.";

type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The schema is the catalog surface's documentation: every named property,
 * array item, and record value must carry a description. */
function assertDocumented(node: unknown, where: string): void {
  if (!isObject(node)) return;
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

export function buildSchema(): Schema {
  const generated = z.toJSONSchema(catalogFileSchema, { target: "draft-7", io: "input" }) as Schema;
  if (generated["type"] !== "object" || generated["additionalProperties"] !== false) {
    throw new Error("the root is no longer a strict object schema");
  }
  assertDocumented(generated, "root");
  const { $schema, ...rest } = generated;
  return {
    $schema,
    title: TITLE,
    description: DESCRIPTION,
    ...rest,
  };
}

if (import.meta.main) {
  const path = join(import.meta.dir, "..", "catalog.schema.json");
  await Bun.write(path, `${JSON.stringify(buildSchema(), null, 2)}\n`);
  console.log(`wrote ${path}`);
}
