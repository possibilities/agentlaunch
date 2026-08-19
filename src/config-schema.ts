/**
 * The launcher config format as a zod schema — the single source of truth:
 * `loadConfig` in `config.ts` validates the file with it, and
 * `scripts/generate-schema.ts` emits `config.schema.json` from it, so a
 * config key exists exactly when it is declared (and described) here.
 *
 * Contract (the fleet's config-schema conventions):
 * - Every object is strict; an unknown key is rejected, never ignored.
 * - `$schema` appears only in the published-file schema; the loader strips
 *   it before validation, whatever its value.
 * - No `.default()` anywhere: an omitted key stays omitted through the
 *   parse, so what a missing `yolo` means is the loader's decision to state
 *   (ADR 0009) rather than something the parse quietly injects.
 * - Validation failures become one `config_invalid` CliError via
 *   `configParseError`, naming the offending key.
 */
import { z } from "zod";
import { CliError } from "./errors.ts";
import type { HarnessName } from "./harness.ts";
import { HARNESS_NAMES } from "./harness.ts";

/** One key per harness, so each can be described. `satisfies` pins the set
 * to HARNESS_NAMES: a new harness fails to compile until it is named and
 * documented here. */
const yoloShape = {
  claude: z
    .boolean()
    .describe(
      "Inject --permission-mode auto into claude launches — claude's own auto mode, which classifies each action rather than waving all of them through. Defaults to true when omitted.",
    )
    .optional(),
  codex: z
    .boolean()
    .describe(
      "Inject --dangerously-bypass-approvals-and-sandbox into codex launches. Defaults to true when omitted.",
    )
    .optional(),
  pi: z
    .boolean()
    .describe(
      "Inject --approve into pi launches. Defaults to true when omitted. Pi's tools never prompt, so this only auto-trusts project-local files.",
    )
    .optional(),
} satisfies Record<HarnessName, z.ZodOptional<z.ZodBoolean>>;

const yoloMapSchema = z
  .strictObject(yoloShape)
  .describe(
    "Per-harness answers. Only claude, codex, and pi are accepted — an unknown harness name is a config_invalid error rather than a silently ignored line, so that a misspelling can never read as the default when the operator meant to disable. Any harness left out stays on.",
  );

const yoloSchema = z
  .union([
    z
      .boolean()
      .describe(
        "One answer for every harness: true (the default state) injects each harness's permission flag into claude, codex, and pi alike; false injects nothing anywhere.",
      ),
    yoloMapSchema,
  ])
  .describe(
    "Whether a launch stands each harness's own interactive permission gates down by injecting that harness's documented flag into the launch spec: --permission-mode auto for claude, --dangerously-bypass-approvals-and-sandbox for codex, --approve for pi. Omit the key (or the whole file) and every harness is ON. A bare boolean sets all three at once; an object sets them individually and leaves the unnamed ones on. Utility invocations never receive the flag, a spelling the caller already forwarded is not duplicated (claude's --dangerously-skip-permissions counts as one), and pi's own --no-approve — or any other --permission-mode the caller chose — is never overridden. `--x-yolo` and `--x-no-yolo` (optionally scoped to a harness, repeatable) override this per launch; an explicit --x-no-yolo also removes a yolo flag that was explicitly forwarded, narrated on stderr.",
  );

const rootsSchema = z
  .array(
    z
      .string()
      .min(1)
      .describe("One project root; ~ and ~/ expand to the operator's home directory."),
  )
  .min(1)
  .describe(
    "Parent directories the interactive form (x-surface) scans one level deep for project directories, in scan order. Omitted entirely: ~/code and ~/src.",
  );

const primingSchema = z
  .array(
    z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        "a priming is a bare skill name: lowercase letters, digits, hyphens",
      )
      .describe(
        "One priming choice: a skill name the form prefixes onto the intent — /name for claude and pi, $name for codex.",
      ),
  )
  .describe(
    'Primings the interactive form offers beside "none", in order; the first is the default. Omitted: none are offered.',
  );

const configShape = {
  yolo: yoloSchema.optional(),
  roots: rootsSchema.optional(),
  priming: primingSchema.optional(),
};

/** What the loader validates: config contents with `$schema` already
 * stripped. */
export const configValuesSchema = z.strictObject(configShape);

/** What `config.schema.json` documents: the same format plus the `$schema`
 * key a config file may carry for editor tooling. */
export const configFileSchema = z.strictObject({
  $schema: z
    .string()
    .describe(
      'Path or URL of this schema, for editors that offer completion and validation. The loader accepts it and ignores it; it is the only key besides "yolo" that does not fail validation.',
    )
    .optional(),
  ...configShape,
});

export type ConfigValues = z.infer<typeof configValuesSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * zod's object parser deliberately skips a literal `__proto__` key — its
 * prototype-pollution guard — so a strict object never reports one as
 * unrecognized. JSON.parse does give the key an own slot, and this config
 * has always rejected it like any other unknown name, so every strict level
 * here asks for it by hand rather than letting it slip past.
 */
const HIDDEN_KEY = "__proto__";

function hasHiddenKey(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, HIDDEN_KEY);
}

/** The keys a strict object rejected at its own level. */
function unrecognizedKeys(issues: readonly z.ZodIssue[]): string[] {
  return issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" && issue.path.length === 0 ? issue.keys : [],
  );
}

/**
 * Unknown keys at the config root, in document order: what the strict
 * schema rejected, plus the one key it cannot see. Reported even when the
 * parse succeeded, because that is exactly when the hidden key slips
 * through.
 */
function unknownConfigKeys(body: Record<string, unknown>, error: z.ZodError | undefined): string[] {
  const unknown = new Set(error === undefined ? [] : unrecognizedKeys(error.issues));
  if (hasHiddenKey(body)) unknown.add(HIDDEN_KEY);
  return Object.keys(body).filter((key) => unknown.has(key));
}

/** The error for keys that name no setting. */
function unknownKeyError(keys: readonly string[], path: string): CliError {
  return new CliError(
    "config_invalid",
    `${path} has unknown key${keys.length > 1 ? "s" : ""}: ${keys.join(", ")}`,
    `remove them from ${path}`,
  );
}

/** The object branch's issues, which the union hides behind one opaque
 * `invalid_union` — branch order follows the union's declaration. */
function mapBranchIssues(issue: z.ZodIssue | undefined): readonly z.ZodIssue[] {
  if (issue === undefined || issue.code !== "invalid_union") return [];
  return issue.errors[1] ?? [];
}

/**
 * The fault a `yolo` value carries, addressed by key: the first offending
 * entry in document order, as the config has always reported it. What
 * counts as offending is the schema's verdict; only which one is named
 * first is decided here.
 */
function yoloFault(raw: unknown, issue: z.ZodIssue | undefined, path: string): CliError | null {
  const fault = (message: string): CliError =>
    new CliError("config_invalid", `${path}: ${message}`, `fix ${path}`);
  if (isRecord(raw)) {
    const branch = mapBranchIssues(issue);
    const unknown = new Set(unrecognizedKeys(branch));
    if (hasHiddenKey(raw)) unknown.add(HIDDEN_KEY);
    const mistyped = new Set(
      branch.filter((one) => one.path.length > 0).map((one) => String(one.path[0])),
    );
    for (const key of Object.keys(raw)) {
      if (unknown.has(key)) {
        return fault(
          `"yolo" names an unknown harness "${key}" (expected ${HARNESS_NAMES.join(", ")})`,
        );
      }
      if (mistyped.has(key)) return fault(`"yolo.${key}" must be a boolean`);
    }
  }
  if (issue === undefined) return null;
  return fault('"yolo" must be a boolean or an object of per-harness booleans');
}

/**
 * Validate a parsed config document. `$schema` is editor tooling and is
 * stripped before validation, whatever its value; everything else is the
 * schema's business. Faults are raised in the order this file has always
 * reported them — every unknown root key first, then the `yolo` value — as
 * one `config_invalid` CliError naming the offending key.
 */
export function parseConfig(body: Record<string, unknown>, path: string): ConfigValues {
  // "$schema" names no setting; the loader has never looked at its value.
  const { $schema: _schema, ...values } = body;
  const result = configValuesSchema.safeParse(values);
  const error = result.success ? undefined : result.error;
  const unknown = unknownConfigKeys(body, error);
  if (unknown.length > 0) throw unknownKeyError(unknown, path);
  const fault = yoloFault(
    body["yolo"],
    error?.issues.find((issue) => issue.path[0] === "yolo"),
    path,
  );
  if (fault !== null) throw fault;
  if (!result.success) throw remainingFault(result.error, path);
  return result.data;
}

/** Whatever the two shaped messages above do not cover — a key added to the
 * shape before it is given a message of its own still names itself rather
 * than failing anonymously. */
function remainingFault(error: z.ZodError, path: string): CliError {
  const issue = error.issues[0];
  const where = issue === undefined ? "" : issue.path.map(String).join(".");
  return new CliError(
    "config_invalid",
    where === "" ? `${path} is invalid` : `${path}: ${where}: ${issue?.message}`,
    `fix ${path}`,
  );
}
