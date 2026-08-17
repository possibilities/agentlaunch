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
  cwdArguments,
  cwdDimensionToken,
  effortArguments,
  effortDimensionToken,
  HARNESS_NAMES,
  modelArguments,
  modelDimensionToken,
  sessionFileFacts,
  sessionStore,
  utilityInvocation,
} from "./harness.ts";
import type { Narrator } from "./narrate.ts";
import { facts, shellLine, tildePath } from "./narrate.ts";
import type { Partitioned } from "./partition.ts";
import type { Environ } from "./paths.ts";
import { assertSessionId, countSessions, findSessions } from "./resolve.ts";
import { whichInEnv } from "./subprocess.ts";

export interface Context {
  env: Environ;
  home: string;
  cwd: string;
  narrator: Narrator;
}

export type Outcome =
  | { kind: "launch"; spec: LaunchSpec; cwd: string | null }
  | { kind: "result"; data: unknown; human: string };

interface DimensionReport {
  value: string | null;
  source: "requested" | "default" | "forwarded" | null;
}

const NO_DIMENSION: DimensionReport = { value: null, source: null };

export async function launchCommand(context: Context, parts: Partitioned): Promise<Outcome> {
  const tokens = parts.harness;
  const head = tokens[0];
  if (head?.startsWith("x-")) {
    throw new UsageError(
      `unknown x command "${head}" — bare x-* words in command position are agentlaunch's own; a prompt starting with "x-" needs the harness's native prompt flag`,
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
  const utility = utilityInvocation(harness, tokens);
  const requested = level !== null;

  context.narrator.row("open", harness);
  context.narrator.row("cwd", tildePath(context.cwd, context.home));

  if (utility && requested) {
    throw new UsageError(
      `"${head}" is a utility invocation; model and effort do not apply — drop --x-level`,
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
    stream = [
      ...(modelToken === null ? modelArguments(resolution.model.spelling) : []),
      ...(effortToken === null ? effortArguments(harness, resolution.effort) : []),
      ...stream,
    ];
    context.narrator.row("model", facts(model.value ?? undefined, model.source ?? undefined));
    context.narrator.row("effort", facts(effort.value ?? undefined, effort.source ?? undefined));

    // Codex records the explicitly anchored directory. A native --cd/-C from
    // the caller owns this dimension and is forwarded untouched.
    if (cwdDimensionToken(harness, tokens) === null) {
      const anchored = cwdArguments(harness, context.cwd);
      if (anchored.length > 0) {
        stream = [...anchored, ...stream];
        context.narrator.row("anchor", facts(tildePath(context.cwd, context.home), "--cd"));
      }
    }
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
    null,
  );
}

function modelFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--model" || arg === "-m") return args[i + 1];
    if (arg.startsWith("--model=")) return arg.slice("--model=".length);
    if (arg.startsWith("-m=")) return arg.slice("-m=".length);
    if (arg.startsWith("-m") && arg.length > 2) return arg.slice(2);
  }
  return undefined;
}

export async function resumeCommand(context: Context, parts: Partitioned): Promise<Outcome> {
  const [sessionId, ...forwarded] = parts.harness;
  if (sessionId === undefined) throw new UsageError("x-resume requires a native session id");
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
    sessionPath =
      (await findSessions(sessionId, context.env, context.home)).find(
        (match) => match.harness === harness,
      )?.path ?? null;
    context.narrator.row("resume", facts(harness, sessionId, "by --x-harness"));
  } else {
    context.narrator.detail("scan", "claude, codex, and pi native session stores");
    const matches = await findSessions(sessionId, context.env, context.home);
    const first = matches[0];
    if (first === undefined) {
      throw new CliError(
        "session_not_found",
        `session "${sessionId}" is not in the claude, codex, or pi session stores`,
        "pass --x-harness claude|codex|pi to skip detection",
      );
    }
    if (matches.length > 1) {
      throw new CliError(
        "session_ambiguous",
        `session "${sessionId}" exists in more than one store: ${matches
          .map((match) => match.harness)
          .join(", ")}`,
        "pass --x-harness to pick one",
      );
    }
    harness = first.harness;
    sessionPath = first.path;
    context.narrator.row("resume", facts(harness, sessionId));
    context.narrator.detail("session", tildePath(first.path, context.home));
  }

  const lived = await sessionCwd(context, harness, sessionId, sessionPath);
  const cwd = lived !== null && existsSync(lived) ? lived : null;
  context.narrator.row(
    "cwd",
    cwd !== null
      ? facts(tildePath(cwd, context.home), "the native session's directory")
      : facts(
          tildePath(context.cwd, context.home),
          lived === null
            ? "the native session's directory is unknown"
            : `${tildePath(lived, context.home)} is gone`,
        ),
  );

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
    cwd,
  );
}

async function sessionCwd(
  context: Context,
  harness: HarnessName,
  sessionId: string,
  known: string | null,
): Promise<string | null> {
  const path =
    known ??
    (await findSessions(sessionId, context.env, context.home)).find(
      (match) => match.harness === harness,
    )?.path ??
    null;
  if (path === null) return null;
  return (await sessionFileFacts(harness, path)).cwd;
}

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
      (match) => match.harness === harness,
    )?.path ??
    null;
  if (path === null) return undefined;
  try {
    const text = await Bun.file(path).slice(0, 262_144).text();
    let model: string | undefined;
    for (const match of text.matchAll(/"model"\s*:\s*"([^"]+)"/g)) model = match[1];
    return model;
  } catch {
    return undefined;
  }
}

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

function scopeApplies(parts: Partitioned, flag: string, harness: HarnessName): boolean {
  const scopes = parts.scoped.get(flag) ?? [];
  return scopes.includes("all") || scopes.includes(harness);
}

function describeYolo(yolo: Record<HarnessName, boolean>): string {
  return HARNESS_NAMES.map((harness) => `${harness} ${yolo[harness] ? "on" : "off"}`).join(", ");
}

export async function doctorCommand(context: Context, parts: Partitioned): Promise<Outcome> {
  if (parts.harness.length > 0) throw new UsageError("x-doctor takes no arguments");

  const harnesses = [];
  const lines = ["harnesses"];
  for (const harness of HARNESS_NAMES) {
    const store = sessionStore(harness, context.env, context.home);
    const binary = whichInEnv(harness, context.env);
    const sessions = await countSessions(store);
    harnesses.push({
      harness,
      binary,
      store: store.root,
      store_exists: existsSync(store.root),
      sessions,
      override: store.override,
      override_active: store.overrideActive,
    });
    lines.push(
      `  ${harness.padEnd(7)} ${binary ?? "not on PATH"} · ${sessions} session(s) · ${tildePath(store.root, context.home)}${store.overrideActive ? ` · ${store.override}` : ""}`,
    );
  }

  const config = configReport(context);
  lines.push("config");
  lines.push(
    `  ${config.valid ? (config.exists ? "valid" : "missing · defaults active") : `invalid · ${config.error}`} · ${tildePath(config.path, context.home)}`,
  );
  const catalog = catalogReport(context);
  lines.push("catalog");
  lines.push(
    `  ${catalog.valid ? `${catalog.source} · ${catalog.harnesses.map((one) => `${one.harness} ${one.models}`).join(", ")}` : `invalid · ${catalog.error}`} · ${tildePath(catalog.path, context.home)}`,
  );

  return { kind: "result", data: { harnesses, config, catalog }, human: lines.join("\n") };
}

interface ConfigReport {
  path: string;
  exists: boolean;
  valid: boolean;
  yolo: Record<HarnessName, boolean> | null;
  error: string | null;
}

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

interface CatalogReport {
  path: string;
  valid: boolean;
  source: "built-in" | "custom" | null;
  harnesses: Array<{ harness: HarnessName; models: number; model: string; effort: string }>;
  error: string | null;
}

function catalogReport(context: Context): CatalogReport {
  try {
    const catalog = loadCatalog(context.env, context.home);
    return {
      path: catalog.path,
      valid: true,
      source: catalog.source,
      harnesses: catalog.harnesses.map((one) => ({
        harness: one.harness,
        models: one.models.length,
        model: one.model,
        effort: one.effort,
      })),
      error: null,
    };
  } catch (error) {
    const custom = catalogPath(context.env, context.home);
    return {
      path: existsSync(custom) ? custom : BUILTIN_CATALOG_PATH,
      valid: false,
      source: null,
      harnesses: [],
      error: (error as Error).message,
    };
  }
}

export async function catalogCommand(context: Context, parts: Partitioned): Promise<Outcome> {
  if (parts.harness.length > 0) throw new UsageError("x-catalog takes no arguments");

  const catalog = loadCatalog(context.env, context.home);
  const harnesses = catalog.harnesses.map((entry) => ({
    harness: entry.harness,
    default_model: entry.model,
    default_effort: entry.effort,
    metadata_level:
      entry.metadata === null ? null : `${entry.metadata.model}:${entry.metadata.effort}`,
    models: entry.models.map((model) => ({
      model: model.model,
      efforts: model.efforts,
      default_effort: model.effort,
      family: model.family,
    })),
  }));

  const lines = [`catalog  ${catalog.source} · ${tildePath(catalog.path, context.home)}`];
  for (const entry of catalog.harnesses) {
    const metadata =
      entry.metadata === null ? "" : ` · metadata ${entry.metadata.model}:${entry.metadata.effort}`;
    lines.push(`  ${entry.harness.padEnd(7)} default ${entry.model}:${entry.effort}${metadata}`);
    for (const model of entry.models) {
      lines.push(`    ${model.model.padEnd(20)} ${model.efforts.join(", ")}`);
    }
  }

  return {
    kind: "result",
    data: { source: catalog.source, path: catalog.path, harnesses },
    human: lines.join("\n"),
  };
}

async function finishLaunch(
  context: Context,
  parts: Partitioned,
  spec: LaunchSpec,
  routingModel: string | undefined,
  yolo: YoloDecision,
  applied: YoloApplication,
  utility: boolean,
  model: DimensionReport,
  effort: DimensionReport,
  launchCwd: string | null,
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
      `skipped · balancing off ${noBalance ? "for this launch" : "(AGENTLAUNCH_NO_BALANCE)"}`,
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

  const effectiveCwd = launchCwd ?? context.cwd;
  const data = {
    harness: spec.harness,
    session_id: spec.sessionId,
    cwd: effectiveCwd,
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

  if (!dryRun) {
    context.narrator.row("launch", shellLine(launchSpec.command));
    return { kind: "launch", spec: launchSpec, cwd: launchCwd };
  }
  context.narrator.row("dry run", "nothing launched · command on stdout");
  return { kind: "result", data, human: shellLine(launchSpec.command) };
}

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
