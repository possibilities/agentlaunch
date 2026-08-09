import { existsSync } from "node:fs";
import { type BalanceDecision, balanceDisabled, balanceSpec } from "./balance.ts";
import { CliError, UsageError } from "./errors.ts";
import type { ParsedFlags } from "./flags.ts";
import type { HarnessName, LaunchSpec } from "./harness.ts";
import {
  buildOpen,
  buildResume,
  HARNESS_NAMES,
  parseHarnessName,
  sessionStore,
} from "./harness.ts";
import type { Environ } from "./paths.ts";
import { assertSessionId, countSessions, findSessions } from "./resolve.ts";

export interface Context {
  env: Environ;
  home: string;
  cwd: string;
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
  const spec = buildOpen(harness, {
    model: flags.values["model"],
    effort: flags.values["effort"],
    name: flags.values["name"],
    prompt,
    passthrough,
  });
  // Shimmed launches carry their model in the passthrough, not our flag;
  // routing must see it either way.
  return finishLaunch(context, flags, spec, flags.values["model"] ?? modelFromArgs(passthrough));
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
  } else {
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
  }
  const model = await resumeRoutingModel(context, harness, sessionId, sessionPath, passthrough);
  return finishLaunch(context, flags, buildResume(harness, sessionId, passthrough), model);
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
  return { kind: "result", data: { harnesses: reports }, human: lines.join("\n") };
}

async function finishLaunch(
  context: Context,
  flags: ParsedFlags,
  spec: LaunchSpec,
  routingModel: string | undefined,
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

  let launchSpec = spec;
  let decision: BalanceDecision | null = null;
  if (!balanceDisabled(context.env, noBalance)) {
    const balanced = await balanceSpec(context.env, spec, {
      account,
      model: routingModel,
      dryRun,
    });
    launchSpec = balanced.spec;
    decision = balanced.decision;
  }

  if (!dryRun) return { kind: "launch", spec: launchSpec };
  const data = {
    harness: spec.harness,
    session_id: spec.sessionId,
    cwd: context.cwd,
    command: launchSpec.command,
    balance: decision,
  };
  return { kind: "result", data, human: shellLine(launchSpec.command) };
}

const SHELL_SAFE = /^[A-Za-z0-9@%+=:,./_-]+$/;

function shellLine(command: string[]): string {
  return command
    .map((word) => (SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}
