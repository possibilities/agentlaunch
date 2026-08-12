import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogValues, HarnessEntryValues } from "./catalog-schema.ts";
import { catalogParseError, catalogValuesSchema } from "./catalog-schema.ts";
import { CliError, UsageError } from "./errors.ts";
import type { HarnessName } from "./harness.ts";
import { isHarnessName, PROVIDER_SPELLINGS } from "./harness.ts";
import type { Environ } from "./paths.ts";
import { configDirectory } from "./paths.ts";

/**
 * The catalog: the ordered description of harnesses, their models, and
 * their effort sets (ADR 0010, reshaped by ADR 0011). The built-in
 * `catalog.json` ships with the checkout; a custom file at
 * ~/.config/agentlaunch/catalog.json REPLACES it outright — no merging, so
 * what will happen is answerable by reading one file. A malformed custom
 * catalog is a `catalog_invalid` fault, never a silent fall-back to the
 * built-in: a catalog written to constrain must not quietly stop
 * constraining.
 */

export interface CatalogModel {
  /** The name the operator types; identical across every harness that
   * offers the model. */
  model: string;
  /** What the harness's native model flag receives — provider-combined for
   * family includes, `spelling` for local models, the name itself
   * otherwise. */
  spelling: string;
  /** Effective effort set: the model's own, else the family's, else the
   * harness's. */
  efforts: readonly string[];
  /** Default effort when the model is chosen without one; overrides the
   * harness's resolved default. Null falls through. */
  effort: string | null;
  /** The family that contributed the model, null for a local one. */
  family: string | null;
}

export interface CatalogHarness {
  harness: HarnessName;
  models: CatalogModel[];
  /** Resolved default model: the harness's own defaults, or the sole
   * defaults-bearing included family's. */
  model: string;
  /** Resolved default effort, same source as the default model. */
  effort: string;
}

export interface Catalog {
  source: "built-in" | "custom";
  path: string;
  /** In priority order. */
  harnesses: CatalogHarness[];
}

export function catalogPath(env: Environ, home: string): string {
  return join(configDirectory(env, home, "agentlaunch"), "catalog.json");
}

export const BUILTIN_CATALOG_PATH = join(import.meta.dir, "..", "catalog.json");

export function loadCatalog(env: Environ, home: string): Catalog {
  const custom = catalogPath(env, home);
  if (existsSync(custom)) return parseCatalog(custom, "custom");
  return parseCatalog(BUILTIN_CATALOG_PATH, "built-in");
}

function parseCatalog(path: string, source: Catalog["source"]): Catalog {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(
      "catalog_invalid",
      `${path} cannot be read: ${(error as Error).message}`,
      source === "built-in"
        ? "reinstall agentlaunch; the built-in catalog ships with the checkout"
        : `fix or remove ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliError(
      "catalog_invalid",
      `${path} is not valid JSON: ${(error as Error).message}`,
      `fix or remove ${path}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      "catalog_invalid",
      `${path} must hold a JSON object`,
      `fix or remove ${path}`,
    );
  }
  // "$schema" is editor tooling; it names no setting and is stripped
  // before validation, whatever its value.
  const { $schema: _schema, ...body } = parsed as Record<string, unknown>;
  const result = catalogValuesSchema.safeParse(body);
  if (!result.success) throw catalogParseError(result.error, path);
  return expandCatalog(result.data, path, source);
}

/** Resolve family includes into each harness's flat offering, and check the
 * whole-document invariants zod cannot see. */
function expandCatalog(values: CatalogValues, path: string, source: Catalog["source"]): Catalog {
  const fault = (message: string): CliError =>
    new CliError("catalog_invalid", `${path}: ${message}`, `fix ${path}`);

  const seenHarnesses = new Set<string>();
  const harnesses: CatalogHarness[] = [];
  for (const entry of values.harnesses) {
    if (seenHarnesses.has(entry.harness)) {
      throw fault(`harness "${entry.harness}" appears more than once`);
    }
    seenHarnesses.add(entry.harness);
    harnesses.push(expandHarness(entry, values, fault));
  }
  return { source, path, harnesses };
}

function expandHarness(
  entry: HarnessEntryValues,
  values: CatalogValues,
  fault: (message: string) => CliError,
): CatalogHarness {
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  const add = (model: CatalogModel): void => {
    if (seen.has(model.model)) {
      throw fault(
        `harness "${entry.harness}" offers model "${model.model}" more than once${
          model.family === null ? "" : ` (via family "${model.family}")`
        }`,
      );
    }
    seen.add(model.model);
    models.push(model);
  };

  for (const local of entry.models ?? []) {
    const efforts = local.efforts ?? entry.efforts;
    if (efforts === undefined) {
      throw fault(
        `harness "${entry.harness}" model "${local.model}" has no efforts and the harness declares none`,
      );
    }
    add({
      model: local.model,
      spelling: local.spelling ?? local.model,
      efforts,
      effort: local.defaults?.effort ?? null,
      family: null,
    });
  }

  /** Included families that carry defaults, for defaults resolution below. */
  const familyDefaults: Array<{ family: string; model: string; effort: string }> = [];
  for (const include of entry.families ?? []) {
    const family = values.families?.[include.family];
    if (family === undefined) {
      throw fault(`harness "${entry.harness}" includes unknown family "${include.family}"`);
    }
    const combine = PROVIDER_SPELLINGS[entry.harness];
    if (include.provider !== undefined && combine === null) {
      throw fault(
        `harness "${entry.harness}" has no provider semantics; drop "provider" from its "${include.family}" include`,
      );
    }
    for (const member of family.models) {
      const efforts = member.efforts ?? family.efforts ?? entry.efforts;
      if (efforts === undefined) {
        throw fault(
          `family "${include.family}" model "${member.model}" has no efforts, and neither the family nor harness "${entry.harness}" declares any`,
        );
      }
      add({
        model: member.model,
        spelling:
          include.provider !== undefined && combine !== null
            ? combine(include.provider, member.spelling ?? member.model)
            : (member.spelling ?? member.model),
        efforts,
        effort: member.defaults?.effort ?? null,
        family: include.family,
      });
    }
    if (family.defaults !== undefined) {
      if (!family.models.some((member) => member.model === family.defaults?.model)) {
        throw fault(
          `family "${include.family}" default model "${family.defaults.model}" is not among its models`,
        );
      }
      familyDefaults.push({ family: include.family, ...family.defaults });
    }
  }

  // Defaults resolve from the harness's own entry, else the sole
  // defaults-bearing included family — and are validated where they land,
  // so a contradiction is a load fault rather than a surprise at fill time.
  let defaults: { model: string; effort: string } | undefined = entry.defaults;
  if (defaults === undefined) {
    if (familyDefaults.length === 0) {
      throw fault(
        `harness "${entry.harness}" has no defaults — declare "defaults" on the entry or on an included family`,
      );
    }
    if (familyDefaults.length > 1) {
      throw fault(
        `harness "${entry.harness}" includes ${familyDefaults.length} defaults-bearing families (${familyDefaults
          .map((candidate) => candidate.family)
          .join(", ")}); declare its own "defaults" to disambiguate`,
      );
    }
    defaults = familyDefaults[0]!;
  }
  const defaultModel = models.find((model) => model.model === defaults.model);
  if (defaultModel === undefined) {
    throw fault(
      `harness "${entry.harness}" default model "${defaults.model}" is not among its models (${
        models.map((model) => model.model).join(", ") || "none"
      })`,
    );
  }
  for (const model of models) {
    if (model.effort !== null && !model.efforts.includes(model.effort)) {
      throw fault(
        `harness "${entry.harness}" model "${model.model}" default effort "${model.effort}" is not in its efforts (${model.efforts.join(", ")})`,
      );
    }
  }
  const defaultEffort = defaultModel.effort ?? defaults.effort;
  if (!defaultModel.efforts.includes(defaultEffort)) {
    throw fault(
      `harness "${entry.harness}" default effort "${defaultEffort}" is not allowed by its default model "${defaultModel.model}" (${defaultModel.efforts.join(", ")})`,
    );
  }
  return { harness: entry.harness, models, model: defaults.model, effort: defaults.effort };
}

export interface ModelRequest {
  harness?: HarnessName | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

/** The union value ADR 0018 retired: a colon in the --x-harness value used
 * to carry a model and an effort. Named rather than reported as an unknown
 * harness, because the old spelling is in every operator's muscle memory. */
function assertNotUnionValue(value: string): void {
  if (!value.includes(":")) return;
  const parts = value.split(":");
  const level = parts.length === 3 ? parts.slice(1).join(":") : value;
  const harness = parts.length === 3 ? parts[0] : "<harness>";
  throw new UsageError(
    `the --x-harness union value is retired: pass --x-harness ${harness} --x-level ${level}`,
  );
}

/** The --x-harness value (ADR 0018): a harness name, and nothing else — on
 * a launch and on x-resume alike. */
export function parseHarnessFlag(value: string): HarnessName {
  assertNotUnionValue(value);
  if (isHarnessName(value)) return value;
  throw new UsageError(`"${value}" is not a harness (expected claude, codex, or pi)`);
}

/**
 * The --x-level value (ADR 0018): <model>:<effort>, both parts required. The
 * pair is one decision because the catalog validates it as one — which
 * efforts a model allows is the catalog's to know, not the operator's to
 * remember.
 */
export function parseLevel(value: string): { model: string; effort: string } {
  const parts = value.split(":");
  if (parts.length !== 2) {
    throw new UsageError(
      `"${value}" is not a level: --x-level takes <model>:<effort>${
        parts.length === 3 ? ", and the harness now travels on --x-harness" : ""
      }`,
    );
  }
  const [model, effort] = parts as [string, string];
  if (model === "" || effort === "") {
    throw new UsageError(`"${value}" is not a level: <model>:<effort> needs both parts`);
  }
  return { model, effort };
}

export interface Resolution {
  harness: HarnessName;
  model: CatalogModel;
  effort: string;
  /** True where the catalog's defaults, not the request, chose the value. */
  modelDefaulted: boolean;
  effortDefaulted: boolean;
}

/**
 * Resolve a request against the catalog. The three shapes are the three
 * ways the two flags combine (ADR 0018): {harness} — --x-harness alone —
 * launches that harness's defaults; {model, effort} — --x-level alone —
 * walks the harnesses in catalog order and the earliest one offering that
 * combination wins; {harness, model, effort} — both — validates against the
 * named harness. Model and effort always come in pairs, because a level is
 * one value.
 */
export function resolveRequest(catalog: Catalog, request: ModelRequest): Resolution {
  if (request.harness !== undefined) {
    const entry = catalog.harnesses.find((candidate) => candidate.harness === request.harness);
    if (entry === undefined) {
      throw new UsageError(`the catalog does not list harness "${request.harness}"`);
    }
    if (request.model === undefined) return defaultsOf(entry);
    return resolvePinned(entry, request.model, request.effort ?? "");
  }
  if (request.model === undefined || request.effort === undefined) {
    throw new UsageError("a launch names a harness, a level, or both");
  }
  for (const entry of catalog.harnesses) {
    const model = entry.models.find((candidate) => candidate.model === request.model);
    if (model === undefined || !model.efforts.includes(request.effort)) continue;
    return {
      harness: entry.harness,
      model,
      effort: request.effort,
      modelDefaulted: false,
      effortDefaulted: false,
    };
  }
  throw new UsageError(describeMiss(catalog, request.model, request.effort));
}

/** The name route: the harness's resolved defaults, with the default
 * model's own default effort winning over the harness's. */
function defaultsOf(entry: CatalogHarness): Resolution {
  const model = entry.models.find((candidate) => candidate.model === entry.model);
  if (model === undefined) {
    // Unreachable: expandHarness validated the default model exists.
    throw new UsageError(`the catalog default model "${entry.model}" is missing`);
  }
  return {
    harness: entry.harness,
    model,
    effort: model.effort ?? entry.effort,
    modelDefaulted: true,
    effortDefaulted: true,
  };
}

function resolvePinned(entry: CatalogHarness, requestedModel: string, effort: string): Resolution {
  const model = entry.models.find((candidate) => candidate.model === requestedModel);
  if (model === undefined) {
    throw new UsageError(
      `${entry.harness} does not offer model "${requestedModel}" (it offers ${
        entry.models.map((candidate) => candidate.model).join(", ") || "no models"
      })`,
    );
  }
  if (!model.efforts.includes(effort)) {
    throw new UsageError(
      `${entry.harness} model "${model.model}" does not take effort "${effort}" (allowed: ${model.efforts.join(", ")})`,
    );
  }
  return { harness: entry.harness, model, effort, modelDefaulted: false, effortDefaulted: false };
}

/** Name what was asked and what would have been accepted where. */
function describeMiss(catalog: Catalog, requestedModel: string, effort: string): string {
  const offering = catalog.harnesses.filter((entry) =>
    entry.models.some((model) => model.model === requestedModel),
  );
  if (offering.length === 0) {
    return `no harness in the catalog offers model "${requestedModel}"`;
  }
  const sets = offering
    .map((entry) => {
      const model = entry.models.find((candidate) => candidate.model === requestedModel);
      return `${entry.harness} allows ${(model?.efforts ?? []).join(", ")}`;
    })
    .join("; ");
  return `no harness offers model "${requestedModel}" at effort "${effort}" (${sets})`;
}
