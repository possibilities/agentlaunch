import { existsSync } from "node:fs";
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
  return finishLaunch(context, flags, spec);
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
  }
  return finishLaunch(context, flags, buildResume(harness, sessionId, passthrough));
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

function finishLaunch(context: Context, flags: ParsedFlags, spec: LaunchSpec): Outcome {
  const dryRun = flags.bools.has("dry-run");
  if (flags.bools.has("json") && !dryRun) {
    throw new UsageError("this command launches an interactive harness; --json needs --dry-run");
  }
  if (!dryRun) return { kind: "launch", spec };
  const data = {
    harness: spec.harness,
    session_id: spec.sessionId,
    cwd: context.cwd,
    command: spec.command,
  };
  return { kind: "result", data, human: shellLine(spec.command) };
}

const SHELL_SAFE = /^[A-Za-z0-9@%+=:,./_-]+$/;

function shellLine(command: string[]): string {
  return command
    .map((word) => (SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}
