import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogValues, HarnessEntryValues } from "./catalog-schema.ts";
import { catalogParseError, catalogValuesSchema } from "./catalog-schema.ts";
import { CliError, UsageError } from "./errors.ts";
import type { HarnessName } from "./harness.ts";
import { PROVIDER_SPELLINGS } from "./harness.ts";
import type { Environ } from "./paths.ts";
import { configDirectory } from "./paths.ts";

/**
 * The catalog: the ordered description of harnesses, their models, and
 * their effort sets (ADR 0010). The built-in `catalog.json` ships with the
 * checkout; a custom file at ~/.config/agentsurface/catalog.json REPLACES it
 * outright — no merging, so what will happen is answerable by reading one
 * file. A malformed custom catalog is a `catalog_invalid` fault, never a
 * silent fall-back to the built-in: a catalog written to constrain must not
 * quietly stop constraining.
 */

export interface CatalogModel {
  /** The name the operator types; identical across every harness that
   * offers the model. */
  model: string;
  /** What the harness's native model flag receives — provider-combined for
   * family includes, `spelling` for local models, the name itself
   * otherwise. */
  spelling: string;
  /** Effective effort set: the model's own, or the harness's. */
  efforts: readonly string[];
  /** Default effort when the model is chosen without one; overrides the
   * harness default. Null falls through to the harness. */
  effort: string | null;
  /** The family that contributed the model, null for a local one. */
  family: string | null;
}

export interface CatalogHarness {
  harness: HarnessName;
  efforts: readonly string[];
  /** Default effort, filled when the chosen model has no default of its
   * own. */
  effort: string;
  models: CatalogModel[];
  /** Default model, filled into a request that named none. */
  model: string;
}

export interface Catalog {
  source: "built-in" | "custom";
  path: string;
  /** The default harness: what nothing-requested resolves to. */
  harness: HarnessName;
  /** In priority order. */
  harnesses: CatalogHarness[];
}

export function catalogPath(env: Environ, home: string): string {
  return join(configDirectory(env, home, "agentsurface"), "catalog.json");
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
        ? "reinstall agentsurface; the built-in catalog ships with the checkout"
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
  if (!seenHarnesses.has(values.harness)) {
    throw fault(`default harness "${values.harness}" is not listed in "harnesses"`);
  }
  return { source, path, harness: values.harness, harnesses };
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
    add({
      model: local.model,
      spelling: local.spelling ?? local.model,
      efforts: local.efforts ?? entry.efforts,
      effort: local.effort ?? null,
      family: null,
    });
  }
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
      add({
        model: member.model,
        spelling:
          include.provider !== undefined && combine !== null
            ? combine(include.provider, member.model)
            : member.model,
        efforts: member.efforts ?? entry.efforts,
        effort: member.effort ?? null,
        family: include.family,
      });
    }
  }

  // Defaults are validated where they are declared, so a contradiction is a
  // load fault rather than a surprise at fill time.
  if (!entry.efforts.includes(entry.effort)) {
    throw fault(
      `harness "${entry.harness}" default effort "${entry.effort}" is not in its efforts (${entry.efforts.join(", ")})`,
    );
  }
  if (!models.some((model) => model.model === entry.model)) {
    throw fault(
      `harness "${entry.harness}" default model "${entry.model}" is not among its models (${models.map((model) => model.model).join(", ") || "none"})`,
    );
  }
  for (const model of models) {
    if (model.effort !== null && !model.efforts.includes(model.effort)) {
      throw fault(
        `harness "${entry.harness}" model "${model.model}" default effort "${model.effort}" is not in its efforts (${model.efforts.join(", ")})`,
      );
    }
    if (model.effort === null && !model.efforts.includes(entry.effort)) {
      throw fault(
        `harness "${entry.harness}" default effort "${entry.effort}" is not allowed by model "${model.model}"; give that model its own "effort"`,
      );
    }
  }
  return {
    harness: entry.harness,
    efforts: entry.efforts,
    effort: entry.effort,
    models,
    model: entry.model,
  };
}

export interface ModelRequest {
  harness?: HarnessName | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

export interface Resolution {
  harness: HarnessName;
  /** Null only when an explicitly requested effort ruled the harness's
   * default model out. */
  model: CatalogModel | null;
  /** Requested, or defaulted from the model, or from the harness. */
  effort: string;
  /** True where the catalog's defaults, not the request, chose the value. */
  modelDefaulted: boolean;
  effortDefaulted: boolean;
}

/**
 * Resolve a model/effort request against the catalog. With the harness
 * pinned the catalog validates; without it the catalog selects — harnesses
 * in order, earliest match wins, and the effort participates in the match,
 * so a model+effort lands on the earliest harness whose offering allows
 * both. Nothing requested at all resolves to the default harness. Defaults
 * fill what the request left unspecified after selection; they never
 * participate in it.
 */
export function resolveRequest(catalog: Catalog, request: ModelRequest): Resolution {
  if (request.harness !== undefined) {
    const entry = catalog.harnesses.find((candidate) => candidate.harness === request.harness);
    if (entry === undefined) {
      throw new UsageError(`the catalog does not list harness "${request.harness}"`);
    }
    return resolvePinned(entry, request);
  }
  if (request.model === undefined && request.effort === undefined) {
    const entry = catalog.harnesses.find((candidate) => candidate.harness === catalog.harness);
    if (entry === undefined) {
      throw new UsageError(`the catalog does not list harness "${catalog.harness}"`);
    }
    return fill(entry, request, null);
  }
  for (const entry of catalog.harnesses) {
    const resolved = matchEntry(entry, request);
    if (resolved !== null) return resolved;
  }
  throw new UsageError(describeMiss(catalog, request));
}

/** Defaults fill what the request left unspecified; the default model steps
 * aside rather than contradict an explicitly requested effort. */
function fill(
  entry: CatalogHarness,
  request: ModelRequest,
  requested: CatalogModel | null,
): Resolution {
  let model = requested;
  let modelDefaulted = false;
  if (model === null && request.model === undefined) {
    const candidate = entry.models.find((offered) => offered.model === entry.model) ?? null;
    if (
      candidate !== null &&
      (request.effort === undefined || candidate.efforts.includes(request.effort))
    ) {
      model = candidate;
      modelDefaulted = true;
    }
  }
  return {
    harness: entry.harness,
    model,
    effort: request.effort ?? model?.effort ?? entry.effort,
    modelDefaulted,
    effortDefaulted: request.effort === undefined,
  };
}

function resolvePinned(entry: CatalogHarness, request: ModelRequest): Resolution {
  let model: CatalogModel | null = null;
  if (request.model !== undefined) {
    model = entry.models.find((candidate) => candidate.model === request.model) ?? null;
    if (model === null) {
      throw new UsageError(
        `${entry.harness} does not offer model "${request.model}" (it offers ${listModels(entry)})`,
      );
    }
  }
  if (request.effort !== undefined) {
    const allowed = model === null ? entry.efforts : model.efforts;
    if (!allowed.includes(request.effort)) {
      throw new UsageError(
        `${entry.harness}${model === null ? "" : ` model "${model.model}"`} does not take effort "${request.effort}" (allowed: ${allowed.join(", ")})`,
      );
    }
  }
  return fill(entry, request, model);
}

function matchEntry(entry: CatalogHarness, request: ModelRequest): Resolution | null {
  if (request.model !== undefined) {
    const model = entry.models.find((candidate) => candidate.model === request.model);
    if (model === undefined) return null;
    if (request.effort !== undefined && !model.efforts.includes(request.effort)) return null;
    return fill(entry, request, model);
  }
  if (request.effort === undefined || !entry.efforts.includes(request.effort)) return null;
  return fill(entry, request, null);
}

/** Name what was asked and what would have been accepted where. */
function describeMiss(catalog: Catalog, request: ModelRequest): string {
  if (request.model === undefined) {
    const sets = catalog.harnesses
      .map((entry) => `${entry.harness} takes ${entry.efforts.join(", ")}`)
      .join("; ");
    return `no harness in the catalog takes effort "${request.effort}" (${sets})`;
  }
  const offering = catalog.harnesses.filter((entry) =>
    entry.models.some((model) => model.model === request.model),
  );
  if (offering.length === 0) {
    return `no harness in the catalog offers model "${request.model}"`;
  }
  const sets = offering
    .map((entry) => {
      const model = entry.models.find((candidate) => candidate.model === request.model);
      return `${entry.harness} allows ${(model?.efforts ?? entry.efforts).join(", ")}`;
    })
    .join("; ");
  return `no harness offers model "${request.model}" at effort "${request.effort}" (${sets})`;
}

function listModels(entry: CatalogHarness): string {
  return entry.models.map((model) => model.model).join(", ") || "no models";
}
