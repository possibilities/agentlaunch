#!/usr/bin/env bun
import type { Context, Outcome } from "./commands.ts";
import { doctorCommand, launchCommand, resumeCommand } from "./commands.ts";
import { failure, success } from "./envelope.ts";
import { CliError, UsageError } from "./errors.ts";
import { HARNESS_NAMES } from "./harness.ts";
import { AGENT_HELP, AGENT_TEASER, HELP, TOP_HELP, VERSION } from "./help.ts";
import { launch } from "./launch.ts";
import { createNarrator } from "./narrate.ts";
import type { Partitioned, XSpec } from "./partition.ts";
import { partition } from "./partition.ts";

const SCHEMA_VERSION = 1;

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

const YOLO_SCOPES: Array<[string, readonly string[]]> = [
  ["--x-yolo", HARNESS_NAMES],
  ["--x-no-yolo", HARNESS_NAMES],
];

const LAUNCH_FLAGS: RouteFlags = {
  value: ["--x-harness", "--x-level", "--x-account"],
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
