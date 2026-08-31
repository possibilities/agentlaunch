import type { ContractArgument, ContractCommand, ContractConstraint } from "./contract.ts";
import { COMMANDS, GLOBAL_ARGUMENTS, GUIDANCE, TEASER } from "./contract.ts";

/**
 * --help, --agent-help, and --agent-teaser are renders of contract.ts, never
 * a second authorship of it. Everything here reads COMMANDS/GLOBAL_ARGUMENTS/
 * GUIDANCE and formats them; no command name, argument fact, or judgment
 * about a command is written in this file.
 */

function flagToken(arg: ContractArgument): string {
  if (arg.positional) {
    const base = arg.repeatable ? `${arg.name}...` : arg.name;
    return arg.required === true ? `<${base}>` : `[${base}]`;
  }
  const placeholder = arg.type === "boolean" ? "" : ` <${arg.choices ? "choice" : "value"}>`;
  return arg.required === true ? `${arg.name}${placeholder}` : `[${arg.name}${placeholder}]`;
}

function argDetail(arg: ContractArgument): string {
  const bits: string[] = [];
  if (arg.choices) bits.push(`one of ${arg.choices.join("|")}`);
  if (arg.format) bits.push(`format ${arg.format}${arg.direction ? ` (${arg.direction})` : ""}`);
  if (arg.repeatable === true) bits.push("repeatable");
  if (arg.default !== undefined) bits.push(`default ${JSON.stringify(arg.default)}`);
  if (arg.aliases) bits.push(`aka ${arg.aliases.join(", ")}`);
  const suffix = bits.length > 0 ? ` (${bits.join("; ")})` : "";
  return `  ${arg.name.padEnd(18)} ${arg.description}${suffix}`;
}

function constraintLine(constraint: ContractConstraint): string {
  const list = constraint.arguments.join(", ");
  const head =
    constraint.kind === "one_of"
      ? `${constraint.required === true ? "exactly" : "at most"} one of: ${list}`
      : constraint.kind === "conflicts"
        ? `may not combine: ${list}`
        : `${constraint.arguments[0]} requires: ${constraint.arguments.slice(1).join(", ")}`;
  return `  - ${head}${constraint.description ? ` — ${constraint.description}` : ""}`;
}

function isLeaf(command: ContractCommand): boolean {
  return command.subcommands === undefined;
}

function findCommand(path: string[]): ContractCommand | undefined {
  let level = COMMANDS;
  let found: ContractCommand | undefined;
  for (const segment of path) {
    found = level.find((command) => command.name === segment);
    if (found === undefined) return undefined;
    level = found.subcommands ?? [];
  }
  return found;
}

function renderUsage(path: string[], command: ContractCommand): string {
  const tokens = (command.arguments ?? []).map(flagToken);
  return `agentlaunch ${path.join(" ")}${tokens.length > 0 ? ` ${tokens.join(" ")}` : ""}`.trim();
}

/** The detailed per-command help printed by `--x-help` and `<command> --x-help`. */
export function renderCommandHelp(path: string[]): string {
  const command = findCommand(path);
  if (command === undefined || !isLeaf(command)) return renderTopHelp();
  const lines: string[] = [renderUsage(path, command), ""];
  if (command.guidance !== undefined) lines.push(command.guidance, "");
  const args = command.arguments ?? [];
  if (args.length > 0) {
    lines.push("Arguments:");
    for (const arg of args) lines.push(argDetail(arg));
    lines.push("");
  }
  if (command.stdin !== undefined) {
    lines.push(
      `Stdin: accepts ${command.stdin.accepts}${command.stdin.required === true ? " (required)" : ""} — ${command.stdin.description}`,
      "",
    );
  }
  if (command.constraints !== undefined && command.constraints.length > 0) {
    lines.push("Constraints:");
    for (const constraint of command.constraints) lines.push(constraintLine(constraint));
    lines.push("");
  }
  lines.push("Global flags:");
  for (const arg of GLOBAL_ARGUMENTS) lines.push(argDetail(arg));
  return lines.join("\n");
}

/** The `--help` / no-argument top-level render. */
export function renderTopHelp(): string {
  const lines: string[] = [
    "agentlaunch — resolve, balance, and launch claude, codex, or pi",
    "",
    "Usage:",
  ];
  for (const command of COMMANDS) {
    if (command.audience === "internal") continue;
    lines.push(`  ${renderUsage([command.name], command)}`);
  }
  lines.push("", "Commands:");
  for (const command of COMMANDS) {
    if (command.audience === "internal") continue;
    lines.push(`  ${command.name.padEnd(12)} ${command.summary}`);
  }
  lines.push(
    "",
    "Extension flags are the reserved --x-* namespace. Every other token is",
    "forwarded in order and interpreted only by the native harness.",
    "",
    "Global flags:",
  );
  for (const arg of GLOBAL_ARGUMENTS) lines.push(argDetail(arg));
  lines.push(
    "",
    "Other:",
    "  --version, -V          Print the version",
    "  --agent-help           Print the agent-oriented runbook",
    "  --agent-teaser         Print the one-line agent summary",
    "  guide --x-json         Print the machine-readable fleet agent contract",
    "",
    "Config and catalog:",
    "  ~/.config/agentlaunch/config.json",
    "  ~/.config/agentlaunch/catalog.json",
    "",
    "Environment:",
    "  AGENTLAUNCH_NO_BALANCE=1   Default launches to unbalanced",
    "  AGENTLAUNCH_LAUNCH=1       Recursion sentinel used by bare harness shims",
    "  AGENTSTART_RESOURCES_ROOT     Override the fixed AgentStart resource root",
    "",
    "Examples:",
    '  agentlaunch --x-harness claude "fix the failing tests"',
    '  agentlaunch --x-level gpt-5.6-sol:ultra "hard problem"',
    "  agentlaunch --x-harness pi --x-level gpt-5.6-luna:max --x-dry-run --x-json",
    "  agentlaunch x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60",
  );
  return lines.join("\n");
}

export function renderAgentHelp(): string {
  const lines: string[] = ["agentlaunch agent runbook", "", GUIDANCE, "", "Commands:"];
  for (const command of COMMANDS) {
    lines.push(`  ${command.name.padEnd(10)} [${command.audience}]  ${command.summary}`);
  }
  return lines.join("\n");
}

export function renderAgentTeaser(): string {
  return TEASER;
}
