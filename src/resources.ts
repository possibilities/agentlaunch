import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CliError } from "./errors.ts";
import { codexNonInteractiveCommandIndex, type LaunchSpec } from "./harness.ts";
import { dataDirectory, type Environ } from "./paths.ts";

export interface FleetResources {
  root: string;
  claudePluginDir: string;
  skills: Array<{ name: string; path: string }>;
  codexSkillNames: string[];
  mcpServers: FleetMcpServer[];
}

export interface FleetMcpServer {
  name: string;
  command: string;
  args: string[];
}

export function fleetResourcesRoot(env: Environ, home: string): string {
  const explicit = env["AGENTSTART_RESOURCES_ROOT"];
  if (explicit !== undefined && explicit !== "") {
    if (!isAbsolute(explicit)) {
      throw new CliError(
        "resources_root_relative",
        `AGENTSTART_RESOURCES_ROOT must be absolute: ${explicit}`,
      );
    }
    return explicit;
  }
  return join(dataDirectory(env, home, "agentstart"), "resources");
}

export function loadFleetResources(env: Environ, home: string): FleetResources {
  const root = fleetResourcesRoot(env, home);
  const skillsRoot = join(root, "skills");
  const namesPath = join(root, "managed-skills.txt");
  let names: string[];
  try {
    names = readFileSync(namesPath, "utf8")
      .split("\n")
      .filter((name) => name !== "")
      .sort();
  } catch (error) {
    throw missingResources(root, error);
  }
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new CliError("resources_invalid", `${namesPath} is empty or contains duplicate names`);
  }
  const skills = names.map((name) => {
    const path = join(skillsRoot, name);
    if (!existsSync(join(path, "SKILL.md"))) {
      throw new CliError("resources_invalid", `managed skill is missing: ${path}/SKILL.md`);
    }
    return { name, path };
  });
  const claudePluginDir = join(root, "claude", "agent");
  if (!existsSync(join(claudePluginDir, ".claude-plugin", "plugin.json"))) {
    throw missingResources(root);
  }
  const mcpConfigPath = join(root, "mcp-servers.json");
  const claudeMcpConfigPath = join(claudePluginDir, ".mcp.json");
  let mcpConfig: string;
  let claudeMcpConfig: string;
  try {
    mcpConfig = readFileSync(mcpConfigPath, "utf8");
    claudeMcpConfig = readFileSync(claudeMcpConfigPath, "utf8");
  } catch (error) {
    throw missingResources(root, error);
  }
  if (mcpConfig !== claudeMcpConfig) {
    throw new CliError(
      "resources_invalid",
      `${claudeMcpConfigPath} does not match ${mcpConfigPath}`,
    );
  }
  return {
    root,
    claudePluginDir,
    skills,
    codexSkillNames: names.map((name) => `agent:${name}`),
    mcpServers: parseMcpServers(mcpConfigPath, mcpConfig),
  };
}

export function codexSkillPolicyArguments(names: string[]): string[] {
  const config = names.map((name) => `{name=${JSON.stringify(name)},enabled=true}`).join(",");
  return config === "" ? [] : ["-c", `skills.config=[${config}]`];
}

export function codexMcpArguments(servers: FleetMcpServer[]): string[] {
  return servers.flatMap((server) => [
    "-c",
    `mcp_servers.${server.name}={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)}}`,
  ]);
}

export function applyFleetResourceArguments(
  spec: LaunchSpec,
  resources: FleetResources,
): LaunchSpec {
  const [bin, ...native] = spec.command;
  if (bin === undefined) return spec;
  if (spec.harness === "claude") {
    return { ...spec, command: [bin, "--plugin-dir", resources.claudePluginDir, ...native] };
  }
  const policy = [
    ...codexSkillPolicyArguments(resources.codexSkillNames),
    ...codexMcpArguments(resources.mcpServers),
  ];
  const commandIndex = codexNonInteractiveCommandIndex(native);
  if (commandIndex !== null) {
    return {
      ...spec,
      command: [
        bin,
        ...native.slice(0, commandIndex + 1),
        ...policy,
        ...native.slice(commandIndex + 1),
      ],
    };
  }
  if (native[0] === "resume" && native[1] !== undefined) {
    return { ...spec, command: [bin, native[0], native[1], ...policy, ...native.slice(2)] };
  }
  return { ...spec, command: [bin, ...policy, ...native] };
}

function parseMcpServers(path: string, text: string): FleetMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new CliError("resources_invalid", `${path} is not valid JSON${detail}`);
  }
  if (!isObject(parsed) || Object.keys(parsed).length !== 1 || !isObject(parsed["mcpServers"])) {
    throw new CliError("resources_invalid", `${path} must contain only an mcpServers object`);
  }
  const entries = Object.entries(parsed["mcpServers"]).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) {
    throw new CliError("resources_invalid", `${path} contains no MCP servers`);
  }
  return entries.map(([name, value]) => {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new CliError(
        "resources_invalid",
        `${path} contains an invalid MCP server name: ${name}`,
      );
    }
    if (
      !isObject(value) ||
      Object.keys(value).some((key) => key !== "command" && key !== "args") ||
      typeof value["command"] !== "string" ||
      value["command"] === "" ||
      !Array.isArray(value["args"]) ||
      !value["args"].every((arg) => typeof arg === "string")
    ) {
      throw new CliError(
        "resources_invalid",
        `${path} MCP server ${name} must contain only a command and string args`,
      );
    }
    return { name, command: value["command"], args: value["args"] };
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingResources(root: string, error?: unknown): CliError {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return new CliError(
    "resources_missing",
    `AgentStart's fixed fleet resources are missing at ${root}${detail}`,
    "run ~/code/agentstart/scripts/sync-skills",
  );
}
