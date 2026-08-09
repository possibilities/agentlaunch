/**
 * The catalog surface as a zod schema — the single source of truth:
 * `loadCatalog` in `catalog.ts` validates the built-in and a custom file
 * alike with it, and `scripts/generate-schema.ts` emits `catalog.schema.json`
 * from it, so a catalog key exists exactly when it is declared (and
 * described) here.
 *
 * Contract (the agentweb config-schema conventions):
 * - Every object is strict; an unknown key is rejected, never ignored.
 * - `$schema` appears only in the published-file schema; the loader strips
 *   it before validation, whatever its value.
 * - Invariants that need the whole document — include references, provider
 *   semantics, duplicates after family expansion — live in `catalog.ts`,
 *   not here.
 * - Validation failures surface as one `catalog_invalid` CliError via
 *   `catalogParseError`, on the first issue in document order.
 */
import { z } from "zod";
import { CliError } from "./errors.ts";
import type { HarnessName } from "./harness.ts";

/** Names the operator types or references: models, efforts, families,
 * providers. No slashes or colons — those belong to emitted spellings. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Emitted spellings may carry provider paths and the like; only whitespace
 * is out, because the spelling becomes one argv token. */
export const SPELLING_PATTERN = /^\S+$/;

/** Keep in lockstep with HARNESS_NAMES in harness.ts; the `satisfies` pins
 * them together at compile time. */
const HARNESSES = ["claude", "codex", "pi"] as const satisfies readonly HarnessName[];

const effortList = (description: string) =>
  z.array(z.string().regex(NAME_PATTERN)).min(1).describe(description);

const defaultEffort = z
  .string()
  .regex(NAME_PATTERN)
  .describe(
    "This model's default effort, filled in when the model is chosen without an explicit effort — overriding the harness's own default. Must be in the model's effective efforts.",
  );

const familyMemberSchema = z
  .strictObject({
    model: z
      .string()
      .regex(NAME_PATTERN)
      .describe(
        "The name the operator types for this model — identical in every harness that includes the family; only the emitted spelling varies per harness.",
      ),
    efforts: effortList(
      "Model-bound effort vocabulary: the efforts this model supports wherever it runs, replacing the including harness's set. Omit it and the model inherits each including harness's efforts.",
    ).optional(),
    effort: defaultEffort.optional(),
  })
  .describe("One model a family offers.");

const familySchema = z
  .strictObject({
    models: z
      .array(familyMemberSchema)
      .min(1)
      .describe("The family's models, in presentation order."),
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
    effort: defaultEffort.optional(),
  })
  .describe("A model this harness offers outside any family.");

const includeSchema = z
  .strictObject({
    family: z
      .string()
      .regex(NAME_PATTERN)
      .describe('Name of a family from the top-level "families" map.'),
    provider: z
      .string()
      .regex(NAME_PATTERN)
      .describe(
        "Provider the harness runs these models through. How a provider combines with a model name is that harness's own semantics — pi spells it openai-codex/gpt-5.6 — and a provider on a harness with no provider semantics is a catalog fault.",
      )
      .optional(),
  })
  .describe("One family this harness includes.");

const harnessEntrySchema = z
  .strictObject({
    harness: z
      .enum(HARNESSES)
      .describe(
        "Which harness adapter this entry describes. The catalog describes what a harness offers; it cannot conjure an adapter, so only claude, codex, and pi are accepted.",
      ),
    efforts: effortList(
      "The harness's own effort vocabulary, in low-to-high order: the effective set for any model without its own, and what an effort-only request is matched against.",
    ),
    effort: z
      .string()
      .regex(NAME_PATTERN)
      .describe(
        'The harness\'s default effort, filled in when the chosen model has no default of its own. Required. Must be in "efforts", and every offered model without its own default must allow it — a model with a narrower set needs its own "effort".',
      ),
    models: z
      .array(localModelSchema)
      .min(1)
      .describe("Models this harness offers outside any family.")
      .optional(),
    model: z
      .string()
      .regex(NAME_PATTERN)
      .describe(
        "The harness's default model, filled into a request that named no model — when it also satisfies an explicitly requested effort. Required. Must be one of this harness's offered models, families included.",
      ),
    families: z
      .array(includeSchema)
      .min(1)
      .describe("Families this harness includes, unioned into its offering.")
      .optional(),
  })
  .describe(
    "One harness's offering. The array order of these entries is load-bearing: an ambiguous model/effort request resolves to the earliest matching harness, and the first entry is the default when nothing is requested.",
  );

const catalogShape = {
  harness: z
    .enum(HARNESSES)
    .describe(
      'The default harness: what a request that names neither model nor effort resolves to. Required, and must be listed in "harnesses". Throughout this file, a plural key names the offering and its singular names the default.',
    ),
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
      "The harness offerings, in priority order: earliest matching entry wins an ambiguous request, and the first entry is the default harness.",
    ),
};

/** What the loader validates: catalog contents with `$schema` already
 * stripped. */
export const catalogValuesSchema = z.strictObject(catalogShape);

/** What `catalog.schema.json` documents: the same surface plus the `$schema`
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

/** The single error a failed catalog parse surfaces: the first issue in
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
