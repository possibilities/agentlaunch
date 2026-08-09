import { existsSync } from "node:fs";
import { type BalanceDecision, balanceDisabled, balanceSpec } from "./balance.ts";
import { configPath, loadConfig } from "./config.ts";
import { CliError, UsageError } from "./errors.ts";
import type { ParsedFlags } from "./flags.ts";
import type { HarnessName, LaunchSpec } from "./harness.ts";
import {
  buildOpen,
  buildResume,
  HARNESS_NAMES,
  parseHarnessName,
  sessionStore,
  utilityInvocation,
  YOLO_FLAGS,
} from "./harness.ts";
import type { Narrator } from "./narrate.ts";
import { shellLine, tildePath } from "./narrate.ts";
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

export async function openCommand(
  context: Context,
  flags: ParsedFlags,
  passthrough: string[],
): Promise<Outcome> {
  const [harnessName, prompt, ...extra] = flags.positional;
  if (harnessName === undefined) {
    throw new UsageError("open requires a harness: claude, codex, or pi");
  }
  if (extra.length > 0) {
    throw new UsageError("open takes at most one prompt; quote it, and put harness flags after --");
  }
  const harness = parseHarnessName(harnessName);
  narrateOpening(context, harness, flags, prompt);
  const yolo = resolveYolo(context, flags, harness);
  const spec = buildOpen(harness, {
    model: flags.values["model"],
    effort: flags.values["effort"],
    name: flags.values["name"],
    prompt,
    yolo,
    passthrough,
  });
  // Shimmed launches carry their model in the passthrough, not our flag;
  // routing must see it either way.
  return finishLaunch(
    context,
    flags,
    spec,
    flags.values["model"] ?? modelFromArgs(passthrough),
    yolo,
  );
}

function narrateOpening(
  context: Context,
  harness: HarnessName,
  flags: ParsedFlags,
  prompt: string | undefined,
): void {
  const qualifiers: string[] = [];
  const model = flags.values["model"];
  const effort = flags.values["effort"];
  const name = flags.values["name"];
  if (model !== undefined) qualifiers.push(`model ${model}`);
  if (effort !== undefined) qualifiers.push(`effort ${effort}`);
  if (name !== undefined) qualifiers.push(`named ${name}`);
  const tail = qualifiers.length > 0 ? ` with ${joinWords(qualifiers)}` : "";
  context.narrator.say(`Opening ${harness} in ${tildePath(context.cwd, context.home)}${tail}.`);
  if (prompt !== undefined) {
    context.narrator.detail(`Starting prompt: ${truncate(prompt, 60)}`);
  }
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function truncate(text: string, limit: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** First --model value in forwarded args, either spelling; else undefined. */
function modelFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--model") return args[i + 1];
    if (arg.startsWith("--model=")) return arg.slice("--model=".length);
  }
  return undefined;
}

export async function resumeCommand(
  context: Context,
  flags: ParsedFlags,
  passthrough: string[],
): Promise<Outcome> {
  const [sessionId, ...extra] = flags.positional;
  if (sessionId === undefined) throw new UsageError("resume requires a session id");
  if (extra.length > 0) {
    throw new UsageError("resume takes one session id; harness flags go after --");
  }
  assertSessionId(sessionId);
  const harnessFlag = flags.values["harness"];
  let harness: HarnessName;
  let sessionPath: string | null = null;
  if (harnessFlag !== undefined) {
    harness = parseHarnessName(harnessFlag);
    context.narrator.say(`Resuming session ${sessionId} as ${harness}, named by --harness.`);
  } else {
    context.narrator.detail(
      `Looking for session ${sessionId} in the claude, codex, and pi session stores.`,
    );
    const matches = await findSessions(sessionId, context.env, context.home);
    const first = matches[0];
    if (first === undefined) {
      throw new CliError(
        "session_not_found",
        `session "${sessionId}" is not in the claude, codex, or pi session stores`,
        `pass --harness claude|codex|pi to skip detection`,
      );
    }
    if (matches.length > 1) {
      throw new CliError(
        "session_ambiguous",
        `session "${sessionId}" exists in more than one store: ${matches
          .map((match) => match.harness)
          .join(", ")}`,
        `pass --harness to pick one`,
      );
    }
    harness = first.harness;
    sessionPath = first.path;
    context.narrator.say(
      `Resuming session ${sessionId}, which belongs to ${harness}, in ${tildePath(context.cwd, context.home)}.`,
    );
    context.narrator.detail(`Session file: ${tildePath(first.path, context.home)}`);
  }
  const model = await resumeRoutingModel(context, harness, sessionId, sessionPath, passthrough);
  if (model !== undefined) {
    context.narrator.detail(`Routing on model ${model}.`);
  }
  const yolo = resolveYolo(context, flags, harness);
  return finishLaunch(
    context,
    flags,
    buildResume(harness, sessionId, passthrough, yolo),
    model,
    yolo,
  );
}

/** Per-launch flags beat the config; the config file decides the default.
 * Explicit flags also skip the config read, so --no-yolo (and --yolo) still
 * work while the file is malformed. */
function resolveYolo(context: Context, flags: ParsedFlags, harness: HarnessName): boolean {
  const on = flags.bools.has("yolo");
  const off = flags.bools.has("no-yolo");
  if (on && off) throw new UsageError("--yolo conflicts with --no-yolo; pick one");
  if (on || off) {
    context.narrator.detail(`Yolo ${on ? "on" : "off"} by flag, so the config is not consulted.`);
    return on;
  }
  const config = loadConfig(context.env, context.home);
  context.narrator.detail(
    config.exists
      ? `Config ${tildePath(config.path, context.home)}: yolo ${describeYolo(config.yolo)}.`
      : `No config at ${tildePath(config.path, context.home)}, so yolo is off everywhere.`,
  );
  return config.yolo[harness];
}

function describeYolo(yolo: Record<HarnessName, boolean>): string {
  return HARNESS_NAMES.map((harness) => `${harness} ${yolo[harness] ? "on" : "off"}`).join(", ");
}

/**
 * The model that should drive account routing for a resume: an explicit
 * `--model` in the forwarded args wins; otherwise, for claude, the session
 * file's last-used model (a resume continues on it, so its quota window is
 * the one being spent). Best-effort — balance treats null as no model
 * workload, which is the conservation default.
 */
async function resumeRoutingModel(
  context: Context,
  harness: HarnessName,
  sessionId: string,
  sessionPath: string | null,
  passthrough: string[],
): Promise<string | undefined> {
  const explicit = modelFromArgs(passthrough);
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

export async function doctorCommand(context: Context, flags: ParsedFlags): Promise<Outcome> {
  if (flags.positional.length > 0) throw new UsageError("doctor takes no positional arguments");
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
    `  path   ${config.path} ${config.exists ? "" : "(missing)"}`.trimEnd(),
    config.valid
      ? `  yolo   ${HARNESS_NAMES.map((h) => `${h} ${config.yolo?.[h] ? "on" : "off"}`).join(", ")}`
      : `  yolo   INVALID: ${config.error}`,
  );
  return { kind: "result", data: { harnesses: reports, config }, human: lines.join("\n") };
}

interface ConfigReport {
  path: string;
  exists: boolean;
  valid: boolean;
  yolo: Record<HarnessName, boolean> | null;
  error: string | null;
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

async function finishLaunch(
  context: Context,
  flags: ParsedFlags,
  spec: LaunchSpec,
  routingModel: string | undefined,
  yolo: boolean,
): Promise<Outcome> {
  const dryRun = flags.bools.has("dry-run");
  if (flags.bools.has("json") && !dryRun) {
    throw new UsageError("this command launches an interactive harness; --json needs --dry-run");
  }
  const noBalance = flags.bools.has("x-no-balance");
  const account = flags.values["x-account"];
  if (noBalance && account !== undefined) {
    throw new UsageError("--x-account pins a balanced launch; drop --x-no-balance");
  }

  // A utility invocation passes through unwrapped (ADR 0005): no account is
  // spent, and the swap wrappers reject several of these commands outright.
  // The launch sentinel still makes PATH shims exec the real binary.
  const utility = utilityInvocation(spec.harness, spec.command.slice(1));
  if (utility && account !== undefined) {
    throw new UsageError(
      `--x-account pins a session launch; "${spec.command[1]}" is a utility invocation that passes through`,
    );
  }

  narrateYolo(context, spec, yolo, utility);

  let launchSpec = spec;
  let decision: BalanceDecision | null = null;
  if (utility) {
    context.narrator.say(
      `${spec.harness} ${spec.command[1]} is a utility invocation, so it launches unwrapped.`,
    );
  } else if (balanceDisabled(context.env, noBalance)) {
    context.narrator.say(
      noBalance
        ? "Balancing is off for this launch, so the harness runs on whatever account it already has."
        : "Balancing is off on this machine (AGENTSURFACE_NO_BALANCE), so the harness runs unwrapped.",
    );
  } else {
    context.narrator.detail(
      account === undefined
        ? "Asking agentusage which account has capacity."
        : `Pinning the launch to ${account}; the swap tool still judges it.`,
    );
    const balanced = await balanceSpec(context.env, spec, {
      account,
      model: routingModel,
      dryRun,
      narrator: context.narrator,
    });
    launchSpec = balanced.spec;
    decision = balanced.decision;
    context.narrator.say(describeAccount(balanced.decision));
  }

  if (!dryRun) {
    context.narrator.say(`Launching: ${shellLine(launchSpec.command)}`);
    return { kind: "launch", spec: launchSpec };
  }
  context.narrator.say("Dry run, so nothing is launched; the command follows on stdout.");
  const data = {
    harness: spec.harness,
    session_id: spec.sessionId,
    cwd: context.cwd,
    command: launchSpec.command,
    balance: decision,
    utility,
    yolo,
  };
  return { kind: "result", data, human: shellLine(launchSpec.command) };
}

/** Yolo is the one decision that changes what the harness will let the model
 * do, so it is narrated even when nothing was injected. */
function narrateYolo(context: Context, spec: LaunchSpec, yolo: boolean, utility: boolean): void {
  if (!yolo) {
    context.narrator.detail(`Yolo is off, so ${spec.harness} keeps its permission prompts.`);
    return;
  }
  if (utility) {
    context.narrator.detail("Yolo is on, but a utility invocation never carries the flag.");
    return;
  }
  const injected = YOLO_FLAGS[spec.harness];
  context.narrator.say(
    spec.command.includes(injected)
      ? `Yolo is on, so ${spec.harness} runs with ${injected}.`
      : `Yolo is on for ${spec.harness}, but ${injected} was already forwarded, so nothing was added.`,
  );
}

function describeAccount(decision: BalanceDecision): string {
  const where =
    decision.route !== null
      ? `claude-swap slot ${decision.route.slot}`
      : (decision.accountKey ?? "an account the swap tool picked");
  const lease = decision.leaseId === null ? "" : ` on lease ${decision.leaseId}`;
  const why = decision.reason === null ? "" : ` (${decision.reason})`;
  return `Balanced onto ${where}${lease}${why}.`;
}
