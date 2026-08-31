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
  return {
    root,
    claudePluginDir,
    skills,
    codexSkillNames: names.map((name) => `agent:${name}`),
  };
}

export function codexSkillPolicyArguments(names: string[]): string[] {
  const config = names.map((name) => `{name=${JSON.stringify(name)},enabled=true}`).join(",");
  return config === "" ? [] : ["-c", `skills.config=[${config}]`];
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
  const policy = codexSkillPolicyArguments(resources.codexSkillNames);
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

function missingResources(root: string, error?: unknown): CliError {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return new CliError(
    "resources_missing",
    `AgentStart's fixed fleet resources are missing at ${root}${detail}`,
    "run ~/code/agentstart/scripts/sync-skills",
  );
}
