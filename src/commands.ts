import { existsSync } from "node:fs";
import { type BalanceDecision, balanceDisabled, balanceSpec } from "./balance.ts";
import {
  BUILTIN_CATALOG_PATH,
  catalogPath,
  loadCatalog,
  parseHarnessFlag,
  parseLevel,
  resolveRequest,
} from "./catalog.ts";
import { configPath, loadConfig } from "./config.ts";
import { CliError, UsageError } from "./errors.ts";
import type { HarnessName, LaunchSpec, YoloApplication, YoloDecision } from "./harness.ts";
import {
  applyYolo,
  buildOpen,
  buildResume,
  effortArguments,
  effortDimensionToken,
  ensureWorkspaceTrusted,
  HARNESS_NAMES,
  modelArguments,
  modelDimensionToken,
  nameArguments,
  nameDimensionToken,
  sessionFileFacts,
  sessionStore,
  utilityInvocation,
} from "./harness.ts";
import { landWorkspace } from "./land.ts";
import type { Narrator } from "./narrate.ts";
import { facts, shellLine, tildePath } from "./narrate.ts";
import type { Partitioned } from "./partition.ts";
import type { Environ } from "./paths.ts";
import { assertSessionId, countSessions, findSessions } from "./resolve.ts";
import type { LandingLease, RunRecord } from "./runs.ts";
import {
  acquireLandingLease,
  assertRunNameAvailable,
  listRunRecords,
  resolveRun,
  resolveRunReference,
  runsDirectory,
  stampClosedRuns,
  writeRunRecord,
} from "./runs.ts";
import type { Provenance, SurfaceBackend, WorkspaceIntent } from "./surface.ts";
import { BACKENDS, DEFAULT_BACKEND, surfaceBackend } from "./surface.ts";

export interface Context {
  env: Environ;
  home: string;
  cwd: string;
  narrator: Narrator;
}

export type Outcome =
  | { kind: "launch"; spec: LaunchSpec }
  | { kind: "result"; data: unknown; human: string };

/** A launch dimension as the narrative and envelope report it: what value
 * applies and whose decision it was. */
interface DimensionReport {
  value: string | null;
  source: "requested" | "default" | "forwarded" | null;
}

export async function launchCommand(context: Context, parts: Partitioned): Promise<Outcome> {
  const tokens = parts.harness;
  const head = tokens[0];
  if (head?.startsWith("x-")) {
    throw new UsageError(
      `unknown x command "${head}" — bare x-* words in command position are agentsurface's own; a prompt starting with "x-" needs the harness's -p spelling`,
    );
  }
  const harnessFlag = parts.values["x-harness"];
  const levelFlag = parts.values["x-level"];
  if (harnessFlag === undefined && levelFlag === undefined) {
    throw new UsageError(
      "a launch names what it runs: pass --x-harness <harness>, --x-level <model>:<effort>, or both",
    );
  }
  const level = levelFlag === undefined ? null : parseLevel(levelFlag);
  const catalog = loadCatalog(context.env, context.home);
  const resolution = resolveRequest(catalog, {
    harness: harnessFlag === undefined ? undefined : parseHarnessFlag(harnessFlag),
    model: level?.model,
    effort: level?.effort,
  });
  const harness = resolution.harness;
  context.narrator.row("open", harness);
  context.narrator.row("cwd", tildePath(context.cwd, context.home));

  const utility = utilityInvocation(harness, tokens);
  const name = runName(parts);
  // A named run's terminal reads as the operator's own label; without one it
  // keeps saying what was launched.
  const surface = surfaceRequest(
    parts,
    context.cwd,
    name ?? (levelFlag === undefined ? harness : `${harness} ${levelFlag}`),
    name,
  );
  if (utility && surface !== null) {
    throw new UsageError(
      `"${head}" is a utility invocation; it passes through and cannot be placed on a surface`,
    );
  }
  // A level owns both dimensions (ADR 0011, on --x-level since 0018): it
  // faults on a forwarded counterpart, and means nothing on a utility
  // invocation. Without one the launch yields per dimension — the caller's
  // native spelling wins, unjudged.
  const requested = level !== null;
  if (utility && requested) {
    throw new UsageError(
      `"${head}" is a utility invocation; model and effort do not apply — drop --x-level`,
    );
  }
  if (utility && name !== null) {
    throw new UsageError(
      `"${head}" is a utility invocation; it opens no session to name — drop --x-name`,
    );
  }
  let stream = tokens;
  if (name !== null) {
    const nameToken = nameDimensionToken(harness, tokens);
    if (nameToken !== null) {
      throw new UsageError(`--x-name set the run name; drop the forwarded "${nameToken}"`);
    }
    const args = nameArguments(harness, name);
    if (args === null) {
      // Codex has no launch-time name. A placed run keeps the name anyway —
      // terminal title, card, and record — so on a surface this is mechanism
      // rather than loss, and only a runner launch really drops it.
      context.narrator.row(
        "name",
        facts(
          name,
          surface === null
            ? "not passed · codex has no launch-time name"
            : "surface only · codex has no launch-time name",
        ),
      );
    } else {
      stream = [...args, ...tokens];
      context.narrator.row("name", facts(name, args.join(" ")));
    }
  }
  let model: DimensionReport = { value: null, source: null };
  let effort: DimensionReport = { value: null, source: null };
  if (utility) {
    context.narrator.detail("model", "never applied to a utility invocation");
  } else {
    const modelToken = modelDimensionToken(harness, tokens);
    const effortToken = effortDimensionToken(harness, tokens);
    if (requested && modelToken !== null) {
      throw new UsageError(
        `--x-level ${levelFlag} set the model; drop the forwarded "${modelToken}"`,
      );
    }
    if (requested && effortToken !== null) {
      throw new UsageError(
        `--x-level ${levelFlag} set the effort; drop the forwarded "${effortToken}"`,
      );
    }
    model =
      modelToken === null
        ? {
            value: resolution.model.model,
            source: resolution.modelDefaulted ? "default" : "requested",
          }
        : { value: modelFromArgs(tokens) ?? null, source: "forwarded" };
    effort =
      effortToken === null
        ? { value: resolution.effort, source: resolution.effortDefaulted ? "default" : "requested" }
        : { value: null, source: "forwarded" };
    // Onto the stream, not the raw tokens: the name may already have been
    // injected ahead of them.
    stream = [
      ...(modelToken === null ? modelArguments(resolution.model.spelling) : []),
      ...(effortToken === null ? effortArguments(harness, resolution.effort) : []),
      ...stream,
    ];
    context.narrator.row("model", facts(model.value ?? undefined, model.source ?? undefined));
    context.narrator.row("effort", facts(effort.value ?? undefined, effort.source ?? undefined));
  }

  const yolo = resolveYolo(context, parts, harness);
  const applied = applyYolo(harness, stream, yolo, utility);
  return finishLaunch(
    context,
    parts,
    buildOpen(harness, applied.tokens),
    model.value ?? undefined,
    yolo,
    applied,
    utility,
    model,
    effort,
    surface === null ? null : { ...surface, kind: "open", level: levelFlag ?? null },
  );
}

/** The surface flags as one decision: which backend, and the workspace
 * intent the placement should satisfy. The anchor path — the invocation cwd
 * on a launch, the session's own cwd on a resume — is what "current" means
 * and what a new workspace's project is inferred from. Null anchor happens
 * only on a resume whose session file is nowhere local. */
function surfaceRequest(
  parts: Partitioned,
  anchor: string | null,
  title: string,
  name: string | null,
): {
  backend: SurfaceBackend;
  intent: WorkspaceIntent;
  title: string;
  name: string | null;
  from: FromRequest;
} | null {
  const scopes = parts.scoped.get("x-surface");
  const workspace = parts.values["x-workspace"];
  const newWorkspace = parts.values["x-new-workspace"];
  const project = parts.values["x-project"];
  const from = parts.values["x-from"];
  const noFrom = parts.bools.has("x-no-from");
  if (scopes === undefined) {
    const stray =
      workspace !== undefined
        ? "--x-workspace"
        : newWorkspace !== undefined
          ? "--x-new-workspace"
          : project !== undefined
            ? "--x-project"
            : from !== undefined
              ? "--x-from"
              : noFrom
                ? "--x-no-from"
                : null;
    if (stray !== null) {
      throw new UsageError(`${stray} says where a placed launch lives; add --x-surface`);
    }
    return null;
  }
  if (from !== undefined && noFrom) {
    throw new UsageError("--x-from names what this run came from and --x-no-from says nothing did");
  }
  // Lineage is set when a workspace is created, so naming it for a workspace
  // that already exists would mean rewriting history the placement did not make.
  if ((from !== undefined || noFrom) && newWorkspace === undefined) {
    throw new UsageError(
      `${from !== undefined ? "--x-from" : "--x-no-from"} only qualifies --x-new-workspace; an existing workspace keeps the provenance it has`,
    );
  }
  const names = [...new Set(scopes.filter((scope) => scope !== "all"))];
  if (names.length > 1) {
    throw new UsageError(`--x-surface names more than one backend (${names.join(", ")}); pick one`);
  }
  const backend = surfaceBackend(names[0] ?? DEFAULT_BACKEND);
  if (workspace !== undefined && newWorkspace !== undefined) {
    throw new UsageError(
      "--x-workspace picks an existing workspace and --x-new-workspace creates one; pick one",
    );
  }
  if (project !== undefined && newWorkspace === undefined) {
    throw new UsageError("--x-project only qualifies --x-new-workspace");
  }
  if (newWorkspace !== undefined) {
    if (anchor === null && project === undefined) {
      throw new CliError(
        "workspace_not_found",
        "the session's cwd is unknown locally, so no project can be inferred",
        "pass --x-project <selector> to name one",
      );
    }
    return {
      backend,
      title,
      name,
      intent: { kind: "new", name: newWorkspace, project: project ?? null, path: anchor ?? "" },
      // Omission is a decision, not a gap (ADR 0015): a backend that would
      // otherwise infer gets told there is nothing to descend from.
      from: from === undefined ? { kind: "none" } : { kind: "ref", ref: from },
    };
  }
  if (workspace !== undefined) {
    return {
      backend,
      title,
      name,
      intent: { kind: "existing", selector: workspace },
      from: { kind: "none" },
    };
  }
  if (anchor === null) {
    throw new CliError(
      "workspace_not_found",
      "the session's cwd is unknown locally, so the current workspace cannot be resolved",
      "pass --x-workspace <selector> or --x-new-workspace <name>",
    );
  }
  return {
    backend,
    title,
    name,
    intent: { kind: "current", path: anchor },
    from: { kind: "none" },
  };
}

/** The operator's own label for a run, as typed. Free text — it names
 * nothing on disk, so it needs no id alphabet — but an empty one would
 * label nothing while looking deliberate. */
function runName(parts: Partitioned): string | null {
  const name = parts.values["x-name"];
  if (name === undefined) return null;
  if (name.trim() === "") throw new UsageError("--x-name needs a name");
  return name;
}

/** The provenance flags as typed, before the run registry is consulted:
 * resolving a `run:` reference is a read, so it waits for the launch build. */
type FromRequest = { kind: "none" } | { kind: "ref"; ref: string };

const RUN_REF = "run:";

/** Our own vocabulary first (ADR 0015): a `run:` reference resolves through
 * the run registry, so an agent naming what it spawned from never has to know
 * the backend's selector spelling. Anything else is the backend's own
 * selector, carried opaquely the way --x-workspace already is. */
async function resolveProvenance(
  context: Context,
  from: FromRequest,
  backend: string,
): Promise<Provenance> {
  if (from.kind === "none") return { kind: "none" };
  if (!from.ref.startsWith(RUN_REF)) {
    if (!from.ref.includes(":")) {
      throw new UsageError(
        `--x-from "${from.ref}" is neither run:<run-id-or-name> nor a backend workspace selector (orca takes name:, path:, branch:, id:)`,
      );
    }
    return { kind: "selector", selector: from.ref };
  }
  const record = await resolveRunReference(
    context.env,
    context.home,
    from.ref.slice(RUN_REF.length),
  );
  if (record.backend !== backend) {
    context.narrator.detail(
      "from",
      `run ${record.run_id} landed on ${record.backend} · matching by path on ${backend}`,
    );
  }
  return {
    kind: "run",
    runId: record.run_id,
    backend: record.backend,
    workspace: record.workspace,
  };
}

/** First model value in the forwarded tokens — --model, --model=, or
 * codex's -m short. Read for account routing only; the tokens themselves
 * are forwarded untouched. */
function modelFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--model" || arg === "-m") return args[i + 1];
    if (arg.startsWith("--model=")) return arg.slice("--model=".length);
  }
  return undefined;
}

export async function resumeCommand(context: Context, parts: Partitioned): Promise<Outcome> {
  const [sessionId, ...forwarded] = parts.harness;
  if (sessionId === undefined) throw new UsageError("x-resume requires a session id");
  assertSessionId(sessionId);
  if (parts.values["x-level"] !== undefined) {
    throw new UsageError(
      "x-resume takes no level: a session continues on the model and effort it was started with",
    );
  }
  const harnessFlag = parts.values["x-harness"];
  let harness: HarnessName;
  let sessionPath: string | null = null;
  if (harnessFlag !== undefined) {
    harness = parseHarnessFlag(harnessFlag);
    context.narrator.row("resume", facts(harness, sessionId, "by --x-harness"));
    context.narrator.row("cwd", tildePath(context.cwd, context.home));
  } else {
    context.narrator.detail("scan", "claude, codex, and pi session stores");
    const matches = await findSessions(sessionId, context.env, context.home);
    const first = matches[0];
    if (first === undefined) {
      throw new CliError(
        "session_not_found",
        `session "${sessionId}" is not in the claude, codex, or pi session stores`,
        `pass --x-harness claude|codex|pi to skip detection`,
      );
    }
    if (matches.length > 1) {
      throw new CliError(
        "session_ambiguous",
        `session "${sessionId}" exists in more than one store: ${matches
          .map((match) => match.harness)
          .join(", ")}`,
        `pass --x-harness to pick one`,
      );
    }
    harness = first.harness;
    sessionPath = first.path;
    context.narrator.row("resume", facts(harness, sessionId));
    context.narrator.row("cwd", tildePath(context.cwd, context.home));
    context.narrator.detail("session", tildePath(first.path, context.home));
  }
  // A surface resume lands where the conversation lived: the session's own
  // cwd (every store records it) anchors the current-workspace default and
  // the project inference. Only looked up when a surface is asked for.
  let anchor: string | null = null;
  if (parts.scoped.get("x-surface") !== undefined) {
    const path =
      sessionPath ??
      (await findSessions(sessionId, context.env, context.home)).find(
        (match) => match.harness === harness,
      )?.path ??
      null;
    anchor = path === null ? null : (await sessionFileFacts(harness, path)).cwd;
    if (anchor !== null) context.narrator.detail("anchor", `${anchor} · the session's cwd`);
  }
  // A resume takes no injection ever, so a name here is purely the surface's
  // and the record's: it labels where the conversation was picked up, and
  // never renames the session the harness already knows.
  const resumeName = runName(parts);
  if (resumeName !== null) {
    context.narrator.row(
      "name",
      facts(resumeName, "surface and record · a resume injects nothing"),
    );
  }
  const surface = surfaceRequest(parts, anchor, resumeName ?? `${harness} resume`, resumeName);

  const model = await resumeRoutingModel(context, harness, sessionId, sessionPath, forwarded);
  if (model !== undefined) context.narrator.detail("model", `${model} · drives routing`);
  const yolo = resolveYolo(context, parts, harness);
  const applied = applyYolo(harness, forwarded, yolo, false);
  return finishLaunch(
    context,
    parts,
    buildResume(harness, sessionId, applied.tokens),
    model,
    yolo,
    applied,
    false,
    NO_DIMENSION,
    NO_DIMENSION,
    surface === null ? null : { ...surface, kind: "resume", level: null },
  );
}

/** Per-launch flags beat the config; without either, yolo is on (ADR 0009).
 * Explicit flags skip the config read, so --x-no-yolo (and --x-yolo) still
 * work while the file is malformed. */
function resolveYolo(context: Context, parts: Partitioned, harness: HarnessName): YoloDecision {
  const on = scopeApplies(parts, "x-yolo", harness);
  const off = scopeApplies(parts, "x-no-yolo", harness);
  if (on && off) {
    throw new UsageError(`--x-yolo conflicts with --x-no-yolo for ${harness}; pick one`);
  }
  if (on || off) {
    context.narrator.detail("config", "not consulted · yolo set by flag");
    return { on, explicitOff: off };
  }
  const config = loadConfig(context.env, context.home);
  context.narrator.detail(
    "config",
    facts(
      tildePath(config.path, context.home),
      config.exists ? describeYolo(config.yolo) : "missing · yolo on everywhere",
    ),
  );
  return { on: config.yolo[harness], explicitOff: false };
}

/** A bare occurrence covers every harness; a scoped one only its own. */
function scopeApplies(parts: Partitioned, flag: string, harness: HarnessName): boolean {
  const scopes = parts.scoped.get(flag) ?? [];
  return scopes.includes("all") || scopes.includes(harness);
}

function describeYolo(yolo: Record<HarnessName, boolean>): string {
  return HARNESS_NAMES.map((harness) => `${harness} ${yolo[harness] ? "on" : "off"}`).join(", ");
}

/**
 * The model that should drive account routing for a resume: an explicit
 * model in the forwarded tokens wins; otherwise, for claude, the session
 * file's last-used model (a resume continues on it, so its quota window is
 * the one being spent). Best-effort — balance treats null as no model
 * workload, which is the conservation default.
 */
async function resumeRoutingModel(
  context: Context,
  harness: HarnessName,
  sessionId: string,
  sessionPath: string | null,
  forwarded: string[],
): Promise<string | undefined> {
  const explicit = modelFromArgs(forwarded);
  if (explicit !== undefined) return explicit;
  if (harness !== "claude") return undefined;
  const path =
    sessionPath ??
    (await findSessions(sessionId, context.env, context.home)).find(
      (match) => match.harness === "claude",
    )?.path ??
    null;
  if (path === null) return undefined;
  try {
    const text = await Bun.file(path).text();
    const at = text.lastIndexOf('"model"');
    if (at === -1) return undefined;
    return text.slice(at).match(/^"model"\s*:\s*"([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

export async function doctorCommand(context: Context, parts: Partitioned): Promise<Outcome> {
  if (parts.harness.length > 0) throw new UsageError("x-doctor takes no arguments");
  const reports = [];
  const lines: string[] = [];
  for (const harness of HARNESS_NAMES) {
    const store = sessionStore(harness, context.env, context.home);
    const bin = Bun.which(harness);
    const exists = existsSync(store.root);
    const sessions = await countSessions(store);
    reports.push({
      harness,
      bin,
      store: {
        root: store.root,
        override: store.override,
        override_active: store.overrideActive,
        exists,
        sessions,
      },
    });
    lines.push(
      harness,
      `  bin    ${bin ?? "not on PATH"}`,
      `  store  ${store.root} — ${exists ? `${sessions} sessions` : "missing"}`,
      `  env    ${store.override} ${store.overrideActive ? "(active)" : "(not set)"}`,
    );
  }
  const config = configReport(context);
  lines.push(
    "config",
    `  path   ${config.path} ${config.exists ? "" : "(missing — yolo on everywhere)"}`.trimEnd(),
    config.valid
      ? `  yolo   ${HARNESS_NAMES.map((h) => `${h} ${config.yolo?.[h] ? "on" : "off"}`).join(", ")}`
      : `  yolo   INVALID: ${config.error}`,
  );
  const catalog = catalogReport(context);
  lines.push("catalog", `  path   ${catalog.path} (${catalog.source})`);
  if (catalog.valid && catalog.harnesses !== null) {
    lines.push(
      `  order  ${catalog.harnesses.map((entry) => entry.harness).join(", ")}`,
      `  models ${catalog.harnesses.map((entry) => `${entry.harness} ${entry.models}`).join(", ")}`,
      `  defaults ${catalog.harnesses
        .map((entry) => `${entry.harness} ${entry.defaults.model}:${entry.defaults.effort}`)
        .join(", ")}`,
    );
  } else {
    lines.push(`  order  INVALID: ${catalog.error}`);
  }
  const backends = [];
  lines.push("surface");
  for (const backend of Object.values(BACKENDS)) {
    const health = await backend.doctor(context.env);
    backends.push({ backend: backend.name, ...health });
    lines.push(
      `  ${backend.name.padEnd(6)} ${health.reachable ? "reachable" : "unreachable"} · ${health.detail}`,
    );
  }
  const runs = await listRunRecords(context.env, context.home);
  lines.push(
    `  runs   ${runs.length} recorded · ${tildePath(runsDirectory(context.env, context.home), context.home)}`,
  );
  return {
    kind: "result",
    data: { harnesses: reports, config, catalog, surface: { backends, runs: runs.length } },
    human: lines.join("\n"),
  };
}

interface ConfigReport {
  path: string;
  exists: boolean;
  valid: boolean;
  yolo: Record<HarnessName, boolean> | null;
  error: string | null;
}

interface CatalogReport {
  source: "built-in" | "custom";
  path: string;
  valid: boolean;
  harnesses: Array<{
    harness: HarnessName;
    models: number;
    defaults: { model: string; effort: string };
  }> | null;
  error: string | null;
}

/** Doctor reports a malformed catalog instead of dying on it — same
 * downgrade as the config. */
function catalogReport(context: Context): CatalogReport {
  const custom = catalogPath(context.env, context.home);
  try {
    const catalog = loadCatalog(context.env, context.home);
    return {
      source: catalog.source,
      path: catalog.path,
      valid: true,
      harnesses: catalog.harnesses.map((entry) => ({
        harness: entry.harness,
        models: entry.models.length,
        defaults: { model: entry.model, effort: entry.effort },
      })),
      error: null,
    };
  } catch (error) {
    const isCustom = existsSync(custom);
    return {
      source: isCustom ? "custom" : "built-in",
      path: isCustom ? custom : BUILTIN_CATALOG_PATH,
      valid: false,
      harnesses: null,
      error: (error as Error).message,
    };
  }
}

export async function runsCommand(context: Context, parts: Partitioned): Promise<Outcome> {
  if (parts.harness.length > 0) throw new UsageError("x-runs takes no arguments");
  const records = await listRunRecords(context.env, context.home);
  const lines = records.map((record) =>
    facts(
      record.run_id,
      record.name ?? undefined,
      record.backend,
      record.harness,
      record.workspace.name,
      record.session_id ?? "session not yet discovered",
      record.created_at,
    ),
  );
  return {
    kind: "result",
    data: { runs: records },
    human: lines.length > 0 ? lines.join("\n") : "no recorded runs",
  };
}

export async function runCommand(context: Context, parts: Partitioned): Promise<Outcome> {
  const [reference, ...rest] = parts.harness;
  if (reference === undefined) throw new UsageError("x-run requires a run id or name");
  if (rest.length > 0) throw new UsageError("x-run takes exactly one run id or name");
  const { record, discovered } = await resolveRun(context.env, context.home, reference);
  if (discovered) {
    context.narrator.row(
      "session",
      `${record.session_id} · discovered from the ${record.harness} store`,
    );
  }
  const label = (name: string, value: string): string => `${name.padEnd(10)}${value}`;
  const lines = [
    label("run", record.run_id),
    label("name", record.name ?? "unnamed"),
    label("created", record.created_at),
    label("kind", record.kind),
    label("backend", record.backend),
    label("harness", facts(record.harness, record.level ?? record.harness_value ?? undefined)),
    label(
      "workspace",
      facts(record.workspace.name, tildePath(record.workspace.path, context.home)),
    ),
    label("from", describeProvenance(record.from ?? null)),
    label("terminal", record.terminal ?? "none recorded"),
    label("session", record.session_id ?? "not yet discovered"),
    label("command", shellLine(record.command)),
  ];
  return { kind: "result", data: record, human: lines.join("\n") };
}

/**
 * x-land (ADR 0016): merge a workspace's work back to the main line, let the
 * surface go, and reconcile the registry. The ref vocabulary is the one
 * --x-from already established — `run:<run-id>` resolves through our own
 * registry, anything else is the backend's selector — so an agent that can
 * say where a run came from can say which workspace to land without learning
 * a second grammar.
 */
export async function landCommand(context: Context, parts: Partitioned): Promise<Outcome> {
  const [ref, ...rest] = parts.harness;
  if (ref === undefined) throw new UsageError("x-land requires a workspace reference");
  if (rest.length > 0) throw new UsageError("x-land takes exactly one workspace reference");
  // Same scoped spelling as a launch's --x-surface: bare means the default
  // backend, a vocabulary word names one.
  const scopes = [...new Set((parts.scoped.get("x-surface") ?? []).filter((s) => s !== "all"))];
  if (scopes.length > 1) {
    throw new UsageError(
      `--x-surface names more than one backend (${scopes.join(", ")}); pick one`,
    );
  }
  const backend = surfaceBackend(scopes[0] ?? DEFAULT_BACKEND);
  const dryRun = parts.bools.has("x-dry-run");
  const force = parts.bools.has("x-force");
  const abandon = parts.bools.has("x-abandon");
  const selector = await resolveWorkspaceRef(context, ref, backend.name);

  context.narrator.row("land", facts(backend.name, selector, dryRun ? "dry run" : undefined));
  const result = await landWorkspace(
    { env: context.env, home: context.home, narrator: context.narrator },
    backend,
    { selector, into: parts.values["x-into"], force, abandon, dryRun },
    (workspacePath, closedAs) =>
      stampClosedRuns(context.env, context.home, workspacePath, closedAs),
  );

  // On a dry run the survey *is* the result, and it goes to stdout — so the
  // narrative says only which workspace was read, and never restates it
  // (ADR 0007). A real land's stdout is one line, so its decisions are rows.
  if (!dryRun) {
    context.narrator.row(
      "workspace",
      facts(result.workspace.name, tildePath(result.workspace.path, context.home)),
    );
    context.narrator.row(
      "branch",
      facts(
        result.branch ?? "detached",
        result.into === null ? "abandoned" : `into ${result.into}`,
        result.unpushed === null || result.unpushed === 0
          ? undefined
          : `${result.unpushed} unpushed`,
      ),
    );
    context.narrator.row(
      "release",
      facts(
        result.removed ? "workspace removed" : "workspace kept",
        result.stopped.length > 0 ? `${result.stopped.length} terminal(s) stopped` : undefined,
        result.branch_deleted ? "branch deleted" : "branch kept",
      ),
    );
    if (result.runs.length > 0) {
      context.narrator.row("runs", facts(`${result.runs.length} stamped`, ...result.runs));
    }
  }

  const lines = dryRun
    ? [
        `${"workspace".padEnd(10)}${facts(result.workspace.name, result.workspace.path)}`,
        `${"branch".padEnd(10)}${facts(result.branch ?? "detached", result.into === null ? "abandon" : `into ${result.into}`)}`,
        `${"commits".padEnd(10)}${facts(
          result.commits === null ? "not counted" : `${result.commits} to merge`,
          result.behind === null || result.behind === 0 ? undefined : `${result.behind} behind`,
          result.unpushed === null || result.unpushed === 0
            ? undefined
            : `${result.unpushed} unpushed`,
        )}`,
        `${"terminals".padEnd(10)}${
          result.attachments.length === 0
            ? "none"
            : result.attachments.map((a) => facts(a.title, a.live ? "live" : "stopped")).join(" · ")
        }`,
        `${"blockers".padEnd(10)}${
          result.blockers.length === 0
            ? "none · ready to land"
            : result.blockers
                .map((b) => facts(b.code, b.detail, b.cleared_by ?? "no override"))
                .join(`\n${" ".repeat(10)}`)
        }`,
      ]
    : [
        `${"landed".padEnd(10)}${facts(result.workspace.name, result.branch ?? "detached", result.merge ?? "")}`,
      ];
  return { kind: "result", data: result, human: lines.join("\n") };
}

/** The --x-from vocabulary, reused: ours before anyone's, and a ref with no
 * colon is a fault rather than a guess at which namespace was meant. */
async function resolveWorkspaceRef(
  context: Context,
  ref: string,
  backend: string,
): Promise<string> {
  if (ref.startsWith(RUN_REF)) {
    const record = await resolveRunReference(context.env, context.home, ref.slice(RUN_REF.length));
    if (record.backend !== backend) {
      context.narrator.detail(
        "land",
        `run ${record.run_id} landed on ${record.backend} · matching by path on ${backend}`,
      );
    }
    return record.workspace.id !== null && record.backend === backend
      ? `id:${record.workspace.id}`
      : `path:${record.workspace.path}`;
  }
  if (!ref.includes(":")) {
    throw new UsageError(
      `x-land "${ref}" is neither run:<run-id-or-name> nor a backend workspace selector (orca takes name:, path:, branch:, id:)`,
    );
  }
  return ref;
}

/** A record written before provenance existed has no field at all, which
 * reads the same as one that stated nothing — neither descends from a run. */
function describeProvenance(provenance: Provenance | null): string {
  if (provenance === null) return "none";
  switch (provenance.kind) {
    case "none":
      return "none";
    case "selector":
      return provenance.selector;
    case "run":
      return facts(`run ${provenance.runId}`, provenance.workspace.name);
  }
}

/** Doctor reports a malformed config instead of dying on it — diagnosis is
 * its whole job. */
function configReport(context: Context): ConfigReport {
  try {
    const config = loadConfig(context.env, context.home);
    return {
      path: config.path,
      exists: config.exists,
      valid: true,
      yolo: config.yolo,
      error: null,
    };
  } catch (error) {
    return {
      path: configPath(context.env, context.home),
      exists: true,
      valid: false,
      yolo: null,
      error: (error as Error).message,
    };
  }
}

const NO_DIMENSION: DimensionReport = { value: null, source: null };

/** A launch that lands on a surface instead of becoming the harness. */
interface SurfaceLaunch {
  backend: SurfaceBackend;
  intent: WorkspaceIntent;
  title: string;
  name: string | null;
  kind: "open" | "resume";
  /** The --x-level value as typed, null when the launch took the harness's
   * defaults — and always on a resume, which takes no level. */
  level: string | null;
  from: FromRequest;
}

async function finishLaunch(
  context: Context,
  parts: Partitioned,
  spec: LaunchSpec,
  routingModel: string | undefined,
  yolo: YoloDecision,
  applied: YoloApplication,
  utility: boolean,
  model: DimensionReport = NO_DIMENSION,
  effort: DimensionReport = NO_DIMENSION,
  surface: SurfaceLaunch | null = null,
): Promise<Outcome> {
  const dryRun = parts.bools.has("x-dry-run");
  // A placed launch returns instead of becoming the harness, so its
  // envelope needs no dry run.
  if (parts.bools.has("x-json") && !dryRun && surface === null) {
    throw new UsageError(
      "this command launches an interactive harness; --x-json needs --x-dry-run",
    );
  }
  const noBalance = parts.bools.has("x-no-balance");
  const account = parts.values["x-account"];
  if (noBalance && account !== undefined) {
    throw new UsageError("--x-account pins a balanced launch; drop --x-no-balance");
  }

  // A utility invocation passes through unwrapped (ADR 0005): no account is
  // spent, and the swap wrappers reject several of these commands outright.
  // The launch sentinel still makes PATH shims exec the real binary.
  if (utility && account !== undefined) {
    throw new UsageError(
      `--x-account pins a session launch; "${spec.command[1]}" is a utility invocation that passes through`,
    );
  }

  narrateYolo(context, yolo, applied, utility);

  let launchSpec = spec;
  let decision: BalanceDecision | null = null;
  if (utility) {
    context.narrator.row("account", `skipped · ${spec.command[1]} is a utility invocation`);
  } else if (balanceDisabled(context.env, noBalance)) {
    context.narrator.row(
      "account",
      `skipped · balancing off ${noBalance ? "for this launch" : "(AGENTSURFACE_NO_BALANCE)"}`,
    );
  } else {
    if (account !== undefined) context.narrator.detail("pin", `${account} · still gated`);
    const balanced = await balanceSpec(context.env, spec, {
      account,
      model: routingModel,
      dryRun,
      narrator: context.narrator,
    });
    launchSpec = balanced.spec;
    decision = balanced.decision;
    context.narrator.row("account", describeAccount(balanced.decision));
  }

  const data = {
    harness: spec.harness,
    // What was asked for, whether or not the harness had a spelling for it:
    // on codex a runner launch drops it, and the narrative says so.
    name: runName(parts),
    session_id: spec.sessionId,
    cwd: context.cwd,
    command: launchSpec.command,
    balance: decision,
    utility,
    yolo: yolo.on,
    redactions: applied.redacted,
    model: model.value,
    model_source: model.source,
    effort: effort.value,
    effort_source: effort.source,
  };

  if (surface !== null) {
    const provenance = await resolveProvenance(context, surface.from, surface.backend.name);
    if (!dryRun && surface.name !== null) {
      await assertRunNameAvailable(context.env, context.home, surface.name);
    }
    // Held rather than bound, because the lease is taken inside the backend's
    // own call and has to survive back out here to be released on failure.
    const held: { lease: LandingLease | null } = { lease: null };
    const placement = await surface.backend
      .place({
        spec: launchSpec,
        intent: surface.intent,
        title: surface.title,
        name: surface.name,
        provenance,
        dryRun,
        prepare: (workspacePath) => {
          const trust = ensureWorkspaceTrusted(
            spec.harness,
            context.env,
            context.home,
            workspacePath,
          );
          if (trust !== "not applicable") {
            context.narrator.row("trust", facts(spec.harness, `workspace ${trust}`));
          }
          if (spec.harness === "codex") {
            held.lease = acquireLandingLease(context.env, context.home, workspacePath);
          }
        },
        narrator: context.narrator,
        env: context.env,
      })
      .catch((error: unknown) => {
        // Nothing started in the workspace, so the slot goes back immediately
        // rather than blocking the retry this failure is about to prompt.
        held.lease?.release();
        throw error;
      });
    context.narrator.row("surface", surface.backend.name);
    if (placement.project !== null) {
      context.narrator.row(
        "project",
        facts(
          placement.project.name,
          placement.project.created ? (dryRun ? "would register" : "registered") : "existing",
        ),
      );
    }
    context.narrator.row(
      "workspace",
      facts(
        placement.workspace.name,
        placement.workspace.created
          ? "created"
          : dryRun && surface.intent.kind === "new"
            ? "would create"
            : "existing",
        placement.workspace.path === null
          ? undefined
          : tildePath(placement.workspace.path, context.home),
      ),
    );
    // Provenance is decided only where a workspace is created; an existing
    // one keeps what it had, so there is no decision to report.
    if (surface.intent.kind === "new") {
      // A dry run records nothing by definition, so the note is reserved for
      // a backend that could not express what was asked.
      const unrecorded = !placement.provenance.recorded && !dryRun;
      context.narrator.row(
        "from",
        facts(placement.provenance.detail, unrecorded ? "not recorded" : undefined),
      );
    }
    let runId: string | null = null;
    if (!dryRun) {
      runId = crypto.randomUUID();
      const record: RunRecord = {
        run_id: runId,
        created_at: new Date().toISOString(),
        kind: surface.kind,
        backend: surface.backend.name,
        harness: spec.harness,
        level: surface.level,
        name: surface.name,
        workspace: {
          name: placement.workspace.name,
          // Outside a dry run a landed workspace always has its path.
          path: placement.workspace.path ?? context.cwd,
          id: placement.workspace.id,
        },
        terminal: placement.terminal,
        command: launchSpec.command,
        session_id: spec.sessionId,
        from: provenance.kind === "none" ? null : provenance,
      };
      const recordPath = writeRunRecord(context.env, context.home, record);
      context.narrator.detail("record", tildePath(recordPath, context.home));
      context.narrator.row("run", runId);
      context.narrator.row(
        "launch",
        facts(shellLine(launchSpec.command), `on ${surface.backend.name}`),
      );
    } else {
      context.narrator.row("dry run", "nothing landed · command on stdout");
    }
    const surfaceData = {
      ...data,
      run_id: runId,
      surface: {
        backend: surface.backend.name,
        project: placement.project,
        workspace: placement.workspace,
        terminal: placement.terminal,
        provenance: {
          requested: provenance,
          recorded: placement.provenance.recorded,
          detail: placement.provenance.detail,
        },
      },
    };
    return {
      kind: "result",
      data: surfaceData,
      human: runId ?? shellLine(launchSpec.command),
    };
  }

  if (!dryRun) {
    context.narrator.row("launch", shellLine(launchSpec.command));
    return { kind: "launch", spec: launchSpec };
  }
  context.narrator.row("dry run", "nothing launched · command on stdout");
  return { kind: "result", data, human: shellLine(launchSpec.command) };
}

/** Yolo changes what the harness will let the model do, and --x-no-yolo can
 * remove a flag the caller explicitly forwarded — both land in the
 * narrative, on stderr with every other row (ADR 0007). */
function narrateYolo(
  context: Context,
  yolo: YoloDecision,
  applied: YoloApplication,
  utility: boolean,
): void {
  if (applied.redacted.length > 0) {
    context.narrator.row(
      "yolo",
      facts(
        "off",
        `removed ${applied.redacted.join(" ")}`,
        "explicitly forwarded · --x-no-yolo wins",
      ),
    );
    return;
  }
  if (utility) {
    context.narrator.detail("yolo", yolo.on ? "on · never applied to a utility invocation" : "off");
    return;
  }
  if (applied.presentNegative) {
    context.narrator.row(
      "yolo",
      facts("off", `${applied.present} forwarded · the caller's spelling wins`),
    );
    return;
  }
  if (!yolo.on) {
    context.narrator.row("yolo", "off · permission prompts stay on");
    return;
  }
  context.narrator.row(
    "yolo",
    applied.injected !== null
      ? facts("on", applied.injected)
      : facts("on", `${applied.present} already forwarded`),
  );
}

function describeAccount(decision: BalanceDecision): string {
  return facts(
    decision.route !== null
      ? `claude-swap slot ${decision.route.slot}`
      : (decision.accountKey ?? "chosen by the swap tool"),
    decision.leaseId === null ? undefined : `lease ${decision.leaseId}`,
    decision.reason ?? undefined,
  );
}
