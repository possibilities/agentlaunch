#!/usr/bin/env bun
import type { Context, Outcome } from "./commands.ts";
import { doctorCommand, launchCommand, resumeCommand } from "./commands.ts";
import { failure, success } from "./envelope.ts";
import { CliError, UsageError } from "./errors.ts";
import { HARNESS_NAMES, isHarnessName } from "./harness.ts";
import { AGENT_HELP, AGENT_TEASER, HELP, TOP_HELP, VERSION } from "./help.ts";
import { launch } from "./launch.ts";
import { createNarrator } from "./narrate.ts";
import type { Partitioned, XSpec } from "./partition.ts";
import { partition } from "./partition.ts";

const SCHEMA_VERSION = 1;

/** x-flags legal on every command, so the per-route grammar only has to
 * name what is specific to it. */
const GLOBAL: XSpec = {
  value: new Set<string>([]),
  bool: new Set(["--x-json", "--x-help"]),
  scoped: new Set<string>([]),
};

interface RouteFlags {
  value?: string[];
  bool?: string[];
  scoped?: string[];
}

const LAUNCH_FLAGS: RouteFlags = {
  value: ["--x-account"],
  bool: ["--x-dry-run", "--x-no-balance", "--x-verbose"],
  scoped: ["--x-yolo", "--x-no-yolo"],
};

const RESUME_FLAGS: RouteFlags = {
  value: ["--x-account", "--x-harness"],
  bool: ["--x-dry-run", "--x-no-balance", "--x-verbose"],
  scoped: ["--x-yolo", "--x-no-yolo"],
};

function specFor(flags: RouteFlags): XSpec {
  return {
    value: new Set([...GLOBAL.value, ...(flags.value ?? [])]),
    bool: new Set([...GLOBAL.bool, ...(flags.bool ?? [])]),
    scoped: new Set([...GLOBAL.scoped, ...(flags.scoped ?? [])]),
  };
}

/** The pre-ADR-0008 grammar, retired loudly rather than silently misread. */
const RETIRED_SPELLINGS: Record<string, string> = {
  open: "the open command is retired: the harness name is the command — run `agentsurface <harness> …`",
  resume: "resume is now x-resume",
  doctor: "doctor is now x-doctor",
  help: "help is now --x-help on a command, or bare `agentsurface`",
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

  let helpTopic: string;
  let spec: XSpec;
  let run: (context: Context, parts: Partitioned) => Promise<Outcome>;
  if (isHarnessName(first)) {
    const harness = first;
    helpTopic = "launch";
    spec = specFor(LAUNCH_FLAGS);
    run = (context, parts) => launchCommand(context, harness, parts);
  } else if (first === "x-resume") {
    helpTopic = "x-resume";
    spec = specFor(RESUME_FLAGS);
    run = resumeCommand;
  } else if (first === "x-doctor") {
    helpTopic = "x-doctor";
    spec = specFor({});
    run = doctorCommand;
  } else {
    console.error(`unknown command "${first}"`);
    console.error(TOP_HELP);
    return 2;
  }
  const helpText = HELP[helpTopic] ?? TOP_HELP;

  let parts: Partitioned;
  try {
    parts = partition(argv.slice(1), spec, HARNESS_NAMES);
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
    if (outcome.kind === "launch") return await launch(outcome.spec, context.narrator);
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
