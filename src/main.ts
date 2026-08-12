#!/usr/bin/env bun
import type { Context, Outcome } from "./commands.ts";
import {
  doctorCommand,
  landCommand,
  launchCommand,
  resumeCommand,
  runCommand,
  runsCommand,
  whoamiCommand,
} from "./commands.ts";
import { failure, success } from "./envelope.ts";
import { CliError, UsageError } from "./errors.ts";
import { HARNESS_NAMES } from "./harness.ts";
import { AGENT_HELP, AGENT_TEASER, HELP, TOP_HELP, VERSION } from "./help.ts";
import { launch } from "./launch.ts";
import { createNarrator } from "./narrate.ts";
import type { Partitioned, XSpec } from "./partition.ts";
import { partition } from "./partition.ts";
import { BACKEND_NAMES } from "./surface.ts";

const SCHEMA_VERSION = 1;

/** x-flags legal on every command, so the per-route grammar only has to
 * name what is specific to it. */
const GLOBAL: XSpec = {
  value: new Set<string>([]),
  bool: new Set(["--x-json", "--x-help"]),
  scoped: new Map<string, readonly string[]>(),
};

interface RouteFlags {
  value?: string[];
  bool?: string[];
  scoped?: Array<[string, readonly string[]]>;
}

/** Yolo scopes to a harness; the surface flag scopes to a backend. */
const YOLO_SCOPES: Array<[string, readonly string[]]> = [
  ["--x-yolo", HARNESS_NAMES],
  ["--x-no-yolo", HARNESS_NAMES],
];

const SURFACE_FLAGS: RouteFlags = {
  value: ["--x-workspace", "--x-new-workspace", "--x-project", "--x-from"],
  bool: ["--x-no-from"],
  scoped: [["--x-surface", BACKEND_NAMES]],
};

const LAUNCH_FLAGS: RouteFlags = {
  value: ["--x-harness", "--x-level", "--x-account", "--x-name", ...(SURFACE_FLAGS.value ?? [])],
  bool: ["--x-dry-run", "--x-no-balance", "--x-verbose", ...(SURFACE_FLAGS.bool ?? [])],
  scoped: [...YOLO_SCOPES, ...(SURFACE_FLAGS.scoped ?? [])],
};

const LAND_FLAGS: RouteFlags = {
  value: ["--x-into"],
  bool: ["--x-dry-run", "--x-force", "--x-abandon", "--x-verbose"],
  scoped: [["--x-surface", BACKEND_NAMES]],
};

// --x-level is in the grammar here only so a resume can refuse it in its own
// words: a session continues on the model it was started with.
const RESUME_FLAGS: RouteFlags = {
  value: ["--x-account", "--x-harness", "--x-level", "--x-name", ...(SURFACE_FLAGS.value ?? [])],
  bool: ["--x-dry-run", "--x-no-balance", "--x-verbose", ...(SURFACE_FLAGS.bool ?? [])],
  scoped: [...YOLO_SCOPES, ...(SURFACE_FLAGS.scoped ?? [])],
};

function specFor(flags: RouteFlags): XSpec {
  return {
    value: new Set([...GLOBAL.value, ...(flags.value ?? [])]),
    bool: new Set([...GLOBAL.bool, ...(flags.bool ?? [])]),
    scoped: new Map([...GLOBAL.scoped, ...(flags.scoped ?? [])]),
  };
}

/** The pre-ADR-0008 grammar, retired loudly rather than silently misread. */
const RETIRED_SPELLINGS: Record<string, string> = {
  open: "the open command is retired: launches name their harness with --x-harness",
  resume: "resume is now x-resume",
  doctor: "doctor is now x-doctor",
  help: "help is now --x-help on a command, or bare `agentsurface`",
  claude: "the harness moved off the command position: pass --x-harness claude",
  codex: "the harness moved off the command position: pass --x-harness codex",
  pi: "the harness moved off the command position: pass --x-harness pi",
};

function emit(outcome: Extract<Outcome, { kind: "result" }>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(success(SCHEMA_VERSION, outcome.data)));
    return;
  }
  if (outcome.human !== "") console.log(outcome.human);
}

async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  // Top level is agentsurface's own namespace: no harness has been named,
  // so there is nothing these could forward to and the family's
  // conventional spellings stay.
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
  const retired = RETIRED_SPELLINGS[first];
  if (retired !== undefined) {
    console.error(retired);
    console.error(TOP_HELP);
    return 2;
  }

  // Anything that is not an x-command is a launch: the harness arrives as
  // the --x-harness value (ADR 0011), never as a positional, so every
  // remaining token belongs to x-space or the harness.
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
  } else if (first === "x-land") {
    helpTopic = "x-land";
    spec = specFor(LAND_FLAGS);
    own = argv.slice(1);
    run = landCommand;
  } else if (first === "x-runs") {
    helpTopic = "x-runs";
    spec = specFor({ bool: ["--x-closed", "--x-all"] });
    own = argv.slice(1);
    run = runsCommand;
  } else if (first === "x-run") {
    helpTopic = "x-run";
    spec = specFor({ bool: ["--x-verbose"] });
    own = argv.slice(1);
    run = runCommand;
  } else if (first === "x-whoami") {
    helpTopic = "x-whoami";
    spec = specFor({});
    own = argv.slice(1);
    run = whoamiCommand;
  } else {
    helpTopic = "launch";
    spec = specFor(LAUNCH_FLAGS);
    own = argv;
    run = launchCommand;
  }
  const helpText = HELP[helpTopic] ?? TOP_HELP;

  let parts: Partitioned;
  try {
    parts = partition(own, spec);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error(helpText);
    return 2;
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
    // Under --x-json the envelope is the whole story, so narration goes quiet.
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
    if (context.env["AGENTSURFACE_DEBUG"] !== undefined && error instanceof Error) {
      console.error(error.stack ?? "");
    }
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
