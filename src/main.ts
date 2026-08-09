#!/usr/bin/env bun
import type { Context, Outcome } from "./commands.ts";
import { doctorCommand, openCommand, resumeCommand } from "./commands.ts";
import { failure, success } from "./envelope.ts";
import { CliError, UsageError } from "./errors.ts";
import type { FlagSpec, ParsedFlags } from "./flags.ts";
import { parseFlags } from "./flags.ts";
import { AGENT_HELP, AGENT_TEASER, HELP, TOP_HELP, VERSION } from "./help.ts";
import { launch } from "./launch.ts";

const SCHEMA_VERSION = 1;

/** Global flags are legal on every command, so the per-command grammar only
 * has to name what is specific to it. */
const GLOBAL: FlagSpec = {
  value: new Set<string>([]),
  bool: new Set(["--json", "--help"]),
};

interface CommandDefinition {
  value?: string[];
  bool?: string[];
  /** Launch commands split argv at the first "--" and hand the tail to the
   * harness verbatim; the strict parser only ever sees the head. */
  passthrough: boolean;
  run: (context: Context, flags: ParsedFlags, passthrough: string[]) => Promise<Outcome>;
}

const REGISTRY: Record<string, CommandDefinition> = {
  open: {
    value: ["--model", "--effort", "--name", "--x-account"],
    bool: ["--dry-run", "--x-no-balance", "--yolo", "--no-yolo"],
    passthrough: true,
    run: openCommand,
  },
  resume: {
    value: ["--harness", "--x-account"],
    bool: ["--dry-run", "--x-no-balance", "--yolo", "--no-yolo"],
    passthrough: true,
    run: resumeCommand,
  },
  doctor: { passthrough: false, run: doctorCommand },
};

function specFor(definition: CommandDefinition): FlagSpec {
  return {
    value: new Set([...GLOBAL.value, ...(definition.value ?? [])]),
    bool: new Set([...GLOBAL.bool, ...(definition.bool ?? [])]),
  };
}

function helpFor(name: string): string {
  return HELP[name] ?? TOP_HELP;
}

function emit(outcome: Extract<Outcome, { kind: "result" }>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(success(SCHEMA_VERSION, outcome.data)));
    return;
  }
  if (outcome.human !== "") console.log(outcome.human);
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(TOP_HELP);
    return 0;
  }
  if (command === "--version" || command === "-V") {
    console.log(VERSION);
    return 0;
  }
  if (command === "--agent-help") {
    console.log(AGENT_HELP);
    return 0;
  }
  if (command === "--agent-teaser") {
    console.log(AGENT_TEASER);
    return 0;
  }
  if (command === "help") {
    const topic = argv[1];
    console.log(topic === undefined ? TOP_HELP : helpFor(topic));
    return 0;
  }
  const definition = REGISTRY[command];
  if (definition === undefined) {
    console.error(`unknown command "${command}"`);
    console.error(TOP_HELP);
    return 2;
  }
  const rest = argv.slice(1);
  const separator = definition.passthrough ? rest.indexOf("--") : -1;
  const own = separator === -1 ? rest : rest.slice(0, separator);
  const passthrough = separator === -1 ? [] : rest.slice(separator + 1);
  if (own.includes("--help") || own.includes("-h")) {
    console.log(helpFor(command));
    return 0;
  }

  let flags: ParsedFlags;
  try {
    flags = parseFlags(own, specFor(definition));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error(helpFor(command));
    return 2;
  }

  const json = flags.bools.has("json");
  const context: Context = {
    env: process.env,
    home: process.env["HOME"] ?? "",
    cwd: process.cwd(),
  };

  try {
    const outcome = await definition.run(context, flags, passthrough);
    if (outcome.kind === "launch") return await launch(outcome.spec);
    emit(outcome, json);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(helpFor(command));
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
