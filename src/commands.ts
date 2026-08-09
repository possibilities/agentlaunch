import { existsSync } from "node:fs";
import { type BalanceDecision, balanceDisabled, balanceSpec } from "./balance.ts";
import {
  BUILTIN_CATALOG_PATH,
  catalogPath,
  loadCatalog,
  parseHarnessValue,
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
  HARNESS_NAMES,
  modelArguments,
  modelDimensionToken,
  parseHarnessName,
  sessionStore,
  utilityInvocation,
} from "./harness.ts";
import type { Narrator } from "./narrate.ts";
import { facts, shellLine, tildePath } from "./narrate.ts";
import type { Partitioned } from "./partition.ts";
import type { Environ } from "./paths.ts";
import { assertSessionId, countSessions, findSessions } from "./resolve.ts";

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
  const value = parts.values["x-harness"];
  if (value === undefined) {
    throw new UsageError(
      "a launch names its harness: pass --x-harness <harness>, <model>:<effort>, or <harness>:<model>:<effort>",
    );
  }
  const request = parseHarnessValue(value);
  const catalog = loadCatalog(context.env, context.home);
  const resolution = resolveRequest(catalog, request);
  const harness = resolution.harness;
  context.narrator.row("open", harness);
  context.narrator.row("cwd", tildePath(context.cwd, context.home));

  const utility = utilityInvocation(harness, tokens);
  // Colon forms own both dimensions (ADR 0011): they fault on a forwarded
  // counterpart, and mean nothing on a utility invocation. The name route
  // yields per dimension — the caller's native spelling wins, unjudged.
  const requested = request.model !== undefined;
  if (utility && requested) {
    throw new UsageError(
      `"${head}" is a utility invocation; model and effort do not apply — pass --x-harness ${harness}`,
    );
  }
  let stream = tokens;
  let model: DimensionReport = { value: null, source: null };
  let effort: DimensionReport = { value: null, source: null };
  if (utility) {
    context.narrator.detail("model", "never applied to a utility invocation");
  } else {
    const modelToken = modelDimensionToken(harness, tokens);
    const effortToken = effortDimensionToken(harness, tokens);
    if (requested && modelToken !== null) {
      throw new UsageError(
        `--x-harness ${value} set the model; drop the forwarded "${modelToken}"`,
      );
    }
    if (requested && effortToken !== null) {
      throw new UsageError(
        `--x-harness ${value} set the effort; drop the forwarded "${effortToken}"`,
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
    stream = [
      ...(modelToken === null ? modelArguments(resolution.model.spelling) : []),
      ...(effortToken === null ? effortArguments(harness, resolution.effort) : []),
      ...tokens,
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
  );
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
  const harnessFlag = parts.values["x-harness"];
  let harness: HarnessName;
  let sessionPath: string | null = null;
  if (harnessFlag !== undefined) {
    harness = parseHarnessName(harnessFlag);
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
  return {
    kind: "result",
    data: { harnesses: reports, config, catalog },
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
): Promise<Outcome> {
  const dryRun = parts.bools.has("x-dry-run");
  if (parts.bools.has("x-json") && !dryRun) {
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

  if (!dryRun) {
    context.narrator.row("launch", shellLine(launchSpec.command));
    return { kind: "launch", spec: launchSpec };
  }
  context.narrator.row("dry run", "nothing launched · command on stdout");
  const data = {
    harness: spec.harness,
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
