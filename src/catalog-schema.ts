/**
 * The catalog format as a zod schema — the single source of truth:
 * `loadCatalog` in `catalog.ts` validates the built-in and a custom file
 * alike with it, and `scripts/generate-schema.ts` emits `catalog.schema.json`
 * from it, so a catalog key exists exactly when it is declared (and
 * described) here.
 *
 * Contract (the agentweb config-schema conventions):
 * - Every object is strict; an unknown key is rejected, never ignored.
 * - `$schema` appears only in the published-file schema; the loader strips
 *   it before validation, whatever its value.
 * - Invariants that need the whole document — include references, duplicates
 *   after family expansion, the effort-inheritance chain, defaults
 *   resolution — live in `catalog.ts`, not here.
 * - Validation failures become one `catalog_invalid` CliError via
 *   `catalogParseError`, on the first issue in document order.
 */
import { z } from "zod";
import { CliError } from "./errors.ts";
import type { HarnessName } from "./harness.ts";

/** Names the operator types or references: models, efforts, and families.
 * No slashes or colons — colons belong to the harness-value grammar and
 * slashes to emitted spellings. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Emitted spellings may carry native punctuation; only whitespace is out,
 * because the spelling becomes one argv token. */
export const SPELLING_PATTERN = /^\S+$/;

/** Keep in lockstep with HARNESS_NAMES in harness.ts; the `satisfies` pins
 * them together at compile time. */
const HARNESSES = ["claude", "codex"] as const satisfies readonly HarnessName[];

const effortList = (description: string) =>
  z.array(z.string().regex(NAME_PATTERN)).min(1).describe(description);

const modelDefaultsSchema = z
  .strictObject({
    effort: z
      .string()
      .regex(NAME_PATTERN)
      .describe(
        "This model's default effort, filled in when the model is chosen without an explicit effort — overriding the harness's resolved default. Must be in the model's effective efforts.",
      ),
  })
  .describe("Defaults this model carries; only the effort is defaultable per model.");

const familyMemberSchema = z
  .strictObject({
    model: z
      .string()
      .regex(NAME_PATTERN)
      .describe(
        "The name the operator types for this model — identical in every harness that includes the family; only the emitted spelling varies per harness.",
      ),
    spelling: z
      .string()
      .regex(SPELLING_PATTERN)
      .optional()
      .describe(
        "What is actually passed to the harness's native model flag when it differs from the typed name — the same field a local model carries, so a family member can name a spelling the typed-name grammar forbids (claude's opus[1m]). Defaults to the typed name.",
      ),
    efforts: effortList(
      "Model-bound effort vocabulary: the efforts this model supports wherever it runs, replacing the family's (or including harness's) set. Omit it and the model inherits down the chain.",
    ).optional(),
    defaults: modelDefaultsSchema.optional(),
  })
  .describe("One model a family offers.");

const familyDefaultsSchema = z
  .strictObject({
    model: z
      .string()
      .regex(NAME_PATTERN)
      .describe("The family's default model; must be one of its members."),
    effort: z
      .string()
      .regex(NAME_PATTERN)
      .describe(
        "The family's default effort; must be valid for the default model in every harness that includes the family.",
      ),
  })
  .describe(
    "Defaults the family supplies to a harness that includes it and states none of its own. A harness including two defaults-bearing families must state its own.",
  );

const familySchema = z
  .strictObject({
    efforts: effortList(
      "The family's effort vocabulary: what members inherit when they carry no set of their own, whichever harness includes them.",
    ).optional(),
    models: z
      .array(familyMemberSchema)
      .min(1)
      .describe("The family's models, in presentation order."),
    defaults: familyDefaultsSchema.optional(),
  })
  .describe(
    "A model family: a list of models defined once and included by any number of harnesses, so the same typed names work everywhere the family is included.",
  );

const localModelSchema = z
  .strictObject({
    model: z.string().regex(NAME_PATTERN).describe("The name the operator types for this model."),
    spelling: z
      .string()
      .regex(SPELLING_PATTERN)
      .describe(
        "What is actually passed to the harness's native model flag when it differs from the typed name. Defaults to the typed name.",
      )
      .optional(),
    efforts: effortList(
      "Efforts this model supports, replacing the harness-level set. Omit it and the model inherits the harness's efforts.",
    ).optional(),
    defaults: modelDefaultsSchema.optional(),
  })
  .describe("A model this harness offers outside any family.");

const includeSchema = z
  .strictObject({
    family: z
      .string()
      .regex(NAME_PATTERN)
      .describe('Name of a family from the top-level "families" map.'),
  })
  .describe("One family this harness includes.");

const harnessDefaultsSchema = z
  .strictObject({
    model: z
      .string()
      .regex(NAME_PATTERN)
      .describe(
        "The harness's default model, launched when only the harness is named. Must be one of this harness's offered models, families included.",
      ),
    effort: z
      .string()
      .regex(NAME_PATTERN)
      .describe(
        "The harness's default effort, filled in when the chosen model has no default of its own. Every offered model without its own default must allow it — a model with a narrower set needs its own defaults.",
      ),
  })
  .describe(
    "This harness's own defaults. Optional when exactly one included family carries defaults — the family's then apply — and required otherwise.",
  );

const metadataLevelSchema = z
  .strictObject({
    model: z
      .string()
      .regex(NAME_PATTERN)
      .describe("The metadata model; must be one this harness offers, families included."),
    effort: z
      .string()
      .regex(NAME_PATTERN)
      .describe("The metadata effort; must be allowed by the metadata model."),
  })
  .describe(
    "The harness's level for metadata completions — deriving a slug, title, or summary about a session rather than working in one. Small and fast by intent. Consumers read it from x-catalog as one metadata_level value and pass it back as one --x-level value; a harness without one offers no metadata level.",
  );

const harnessEntrySchema = z
  .strictObject({
    harness: z
      .enum(HARNESSES)
      .describe(
        "Which harness adapter this entry describes. The catalog describes what a harness offers; it cannot conjure an adapter, so only claude and codex are accepted.",
      ),
    efforts: effortList(
      "The harness's own effort vocabulary: what a local model inherits when neither it nor a family provides a set. Required exactly when some local model has no set of its own.",
    ).optional(),
    models: z
      .array(localModelSchema)
      .min(1)
      .describe("Models this harness offers outside any family.")
      .optional(),
    families: z
      .array(includeSchema)
      .min(1)
      .describe("Families this harness includes, unioned into its offering.")
      .optional(),
    defaults: harnessDefaultsSchema.optional(),
    metadata: metadataLevelSchema.optional(),
  })
  .describe(
    "One harness's offering. The array order of these entries is load-bearing: a model:effort request resolves to the earliest harness offering that combination.",
  );

const catalogShape = {
  families: z
    .record(z.string().regex(NAME_PATTERN), familySchema)
    .describe(
      "Model families by name. A map, not a list, because order among families means nothing — nothing matches against a family directly; only harnesses that include one.",
    )
    .optional(),
  harnesses: z
    .array(harnessEntrySchema)
    .min(1)
    .describe(
      "The harness offerings, in priority order: a model:effort request resolves to the earliest entry offering that combination.",
    ),
};

/** What the loader validates: catalog contents with `$schema` already
 * stripped. */
export const catalogValuesSchema = z.strictObject(catalogShape);

/** What `catalog.schema.json` documents: the same format plus the `$schema`
 * key a catalog file may carry for editor tooling. */
export const catalogFileSchema = z.strictObject({
  $schema: z
    .string()
    .describe(
      "Path or URL of this schema, for editors that offer completion and validation. The loader accepts it and ignores it; it is the one key here that configures nothing.",
    )
    .optional(),
  ...catalogShape,
});

export type CatalogValues = z.infer<typeof catalogValuesSchema>;
export type FamilyValues = z.infer<typeof familySchema>;
export type HarnessEntryValues = z.infer<typeof harnessEntrySchema>;

/** `["harnesses", 0, "efforts"]` → `harnesses[0].efforts`. */
function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let formatted = "";
  for (const segment of path) {
    formatted +=
      typeof segment === "number"
        ? `[${segment}]`
        : formatted === ""
          ? String(segment)
          : `.${String(segment)}`;
  }
  return formatted;
}

/** The single error a failed catalog parse reports: the first issue in
 * document order, addressed by path. */
export function catalogParseError(error: z.ZodError, path: string): CliError {
  const issue = error.issues[0];
  if (issue === undefined) {
    return new CliError("catalog_invalid", `${path} is invalid`, `fix or remove ${path}`);
  }
  const where = formatIssuePath(issue.path);
  const detail =
    issue.code === "unrecognized_keys"
      ? `unknown key${issue.keys.length > 1 ? "s" : ""} ${issue.keys.join(", ")}`
      : issue.message;
  return new CliError(
    "catalog_invalid",
    `${path}: ${where === "" ? detail : `${where}: ${detail}`}`,
    `fix or remove ${path}`,
  );
}
