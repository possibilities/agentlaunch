#!/usr/bin/env bun
import type { Context, Outcome } from "./commands.ts";
import { catalogCommand, doctorCommand, launchCommand, resumeCommand } from "./commands.ts";
import { failure, success } from "./envelope.ts";
import { CliError, UsageError } from "./errors.ts";
import { HARNESS_NAMES } from "./harness.ts";
import { AGENT_HELP, AGENT_TEASER, HELP, TOP_HELP, VERSION } from "./help.ts";
import { launch } from "./launch.ts";
import { createNarrator } from "./narrate.ts";
import type { Partitioned, XSpec } from "./partition.ts";
import { partition } from "./partition.ts";
import { runSurfaceForm } from "./surface/app.ts";

const SCHEMA_VERSION = 1;

const GLOBAL: XSpec = {
  value: new Set<string>([]),
  bool: new Set(["--x-json", "--x-help"]),
  repeatable: new Set<string>([]),
  scoped: new Map<string, readonly string[]>(),
};

interface RouteFlags {
  value?: string[];
  bool?: string[];
  repeatable?: string[];
  scoped?: Array<[string, readonly string[]]>;
}

const YOLO_SCOPES: Array<[string, readonly string[]]> = [
  ["--x-yolo", HARNESS_NAMES],
  ["--x-no-yolo", HARNESS_NAMES],
];

const LAUNCH_FLAGS: RouteFlags = {
  // --x-resume is x-resume's flag spelling, for invokers that can only
  // append arguments to the bare kind command (a herdr pane typing
  // `claude --x-resume <id>` through the shim).
  value: ["--x-harness", "--x-level", "--x-account", "--x-prompt-file", "--x-resume"],
  bool: ["--x-dry-run", "--x-no-balance", "--x-verbose"],
  scoped: YOLO_SCOPES,
};

const RESUME_FLAGS: RouteFlags = {
  // --x-level is accepted by the partition only so resume can explain why it
  // is invalid in its own terms.
  value: ["--x-account", "--x-harness", "--x-level"],
  bool: ["--x-dry-run", "--x-no-balance", "--x-verbose"],
  scoped: YOLO_SCOPES,
};

function specFor(flags: RouteFlags): XSpec {
  return {
    value: new Set([...GLOBAL.value, ...(flags.value ?? [])]),
    bool: new Set([...GLOBAL.bool, ...(flags.bool ?? [])]),
    repeatable: new Set([...GLOBAL.repeatable, ...(flags.repeatable ?? [])]),
    scoped: new Map([...GLOBAL.scoped, ...(flags.scoped ?? [])]),
  };
}

function emit(outcome: Extract<Outcome, { kind: "result" }>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(success(SCHEMA_VERSION, outcome.data)));
    return;
  }
  if (outcome.human !== "") console.log(outcome.human);
}

async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h") {
    console.log(TOP_HELP);
    return 0;
  }
  if (first === "--version" || first === "-V") {
    console.log(VERSION);
    return 0;
  }
  if (first === "--agent-help") {
    console.log(AGENT_HELP);
    return 0;
  }
  if (first === "--agent-teaser") {
    console.log(AGENT_TEASER);
    return 0;
  }
  const retiredResourceFlag = argv.find(
    (token) => token === "--x-no-common" || token.startsWith("--x-capability"),
  );
  if (retiredResourceFlag !== undefined) {
    console.error(
      `${retiredResourceFlag} is retired: every managed session receives AgentStart's one fixed private fleet resource set`,
    );
    return 2;
  }
  // --x-surface is a launch modality, not a command: AgentLaunch does one
  // thing — launch agents — and this flag redirects the outcome from
  // becoming the harness to describing the session for a surface host as
  // directives on stdout. The same launch, spoken in the surface's
  // language; keeping the two outcomes consistent is this repository's
  // responsibility, which is why the spelling stays a flag rather than a
  // second command.
  if (argv.includes("--x-surface")) {
    const helpText = HELP["x-surface"] ?? TOP_HELP;
    const rest = argv.filter((token) => token !== "--x-surface");
    if (rest.length === 1 && rest[0] === "--x-help") {
      console.log(helpText);
      return 0;
    }
    if (rest.length > 0) {
      console.error("--x-surface takes no other arguments");
      console.error(helpText);
      return 2;
    }
    // The form renders on stderr and reads keys from stdin; stdout is the
    // host's, checked as the surface contract inside the form itself.
    if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
      console.error(
        "error: --x-surface opens an interactive form and needs a terminal on stdin and stderr",
      );
      return 1;
    }
    try {
      return await runSurfaceForm(process.env, process.env["HOME"] ?? "");
    } catch (error) {
      const domain =
        error instanceof CliError
          ? error
          : new CliError("internal_error", (error as Error).message || String(error));
      console.error(`error: ${domain.message}`);
      if (domain.recovery !== undefined) console.error(domain.recovery);
      if (process.env["AGENTLAUNCH_DEBUG"] !== undefined && error instanceof Error) {
        console.error(error.stack ?? "");
      }
      return 1;
    }
  }

  let helpTopic: string;
  let spec: XSpec;
  let own: string[];
  let run: (context: Context, parts: Partitioned) => Promise<Outcome>;
  if (first === "x-resume") {
    helpTopic = "x-resume";
    spec = specFor(RESUME_FLAGS);
    own = argv.slice(1);
    run = resumeCommand;
  } else if (first === "x-doctor") {
    helpTopic = "x-doctor";
    spec = specFor({});
    own = argv.slice(1);
    run = doctorCommand;
  } else if (first === "x-catalog") {
    helpTopic = "x-catalog";
    spec = specFor({});
    own = argv.slice(1);
    run = catalogCommand;
  } else if (first.startsWith("x-")) {
    console.error(`unknown x command "${first}"`);
    console.error(TOP_HELP);
    return 2;
  } else {
    helpTopic = "launch";
    spec = specFor(LAUNCH_FLAGS);
    own = argv;
    run = launchCommand;
  }
  let helpText = HELP[helpTopic] ?? TOP_HELP;

  let parts: Partitioned;
  try {
    parts = partition(own, spec);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error(helpText);
    return 2;
  }
  // The launch route reroutes to resume when --x-resume names a session:
  // the same resume as the x-resume command, reachable where only flags can
  // ride. The session id moves to command position; a prompt file is
  // refused, not ignored — a resumed session has no launch intent.
  if (run === launchCommand && parts.values["x-resume"] !== undefined) {
    if (parts.values["x-prompt-file"] !== undefined) {
      console.error("--x-resume takes no --x-prompt-file: a resumed session has no launch intent");
      console.error(HELP["x-resume"] ?? TOP_HELP);
      return 2;
    }
    const { "x-resume": sessionId, ...values } = parts.values;
    parts = { ...parts, values, harness: [sessionId, ...parts.harness] };
    run = resumeCommand;
    helpText = HELP["x-resume"] ?? TOP_HELP;
  }
  if (parts.bools.has("x-help")) {
    console.log(helpText);
    return 0;
  }

  const json = parts.bools.has("x-json");
  const context: Context = {
    env: process.env,
    home: process.env["HOME"] ?? "",
    cwd: process.cwd(),
    narrator: createNarrator({ silent: json, verbose: parts.bools.has("x-verbose") }),
  };

  try {
    const outcome = await run(context, parts);
    if (outcome.kind === "launch") {
      return await launch(outcome.spec, context.narrator, context.env, outcome.cwd);
    }
    emit(outcome, json);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(helpText);
      return 2;
    }
    const domain =
      error instanceof CliError
        ? error
        : new CliError("internal_error", (error as Error).message || String(error));
    if (json) {
      console.log(JSON.stringify(failure(SCHEMA_VERSION, domain)));
    } else {
      console.error(`error: ${domain.message}`);
      if (domain.recovery !== undefined) console.error(domain.recovery);
    }
    if (context.env["AGENTLAUNCH_DEBUG"] !== undefined && error instanceof Error) {
      console.error(error.stack ?? "");
    }
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
