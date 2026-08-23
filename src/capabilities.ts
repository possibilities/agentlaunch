import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CliError, UsageError } from "./errors.ts";
import { codexNonInteractiveCommandIndex, type HarnessName, type LaunchSpec } from "./harness.ts";
import type { Partitioned } from "./partition.ts";
import { dataDirectory, type Environ, stateDirectory } from "./paths.ts";

const MANIFEST_VERSION = 1;
const PACK_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const RESOURCE_KEYS = new Set([
  "skills",
  "guidance",
  "claude",
  "pi_extensions",
  "pi_prompt_templates",
]);

interface CapabilityManifest {
  schema_version: number;
  id: string;
  default: boolean;
  description: string;
  resources: Record<string, string>;
}

interface LoadedPack {
  id: string;
  root: string;
  manifest: CapabilityManifest;
  skillsRoot: string | null;
  skills: Array<{ name: string; path: string }>;
  guidance: string;
  claudeRoot: string | null;
  piExtensions: string[];
  piPromptTemplates: string[];
}

export interface CapabilitySet {
  ids: string[];
  digest: string;
  root: string;
  claudePluginDir: string | null;
  skillRoots: string[];
  skills: Array<{ name: string; path: string }>;
  guidance: string;
  guidanceFile: string | null;
  piExtensions: string[];
  piPromptTemplates: string[];
  receiptRequired: boolean;
}

export const CODEX_DISABLE_COMPATIBILITY_PLUGIN =
  'plugins."agent@agentstart-managed".enabled=false';

export function codexSkillPolicyArguments(skills: CapabilitySet["skills"]): string[] {
  const args = ["-c", CODEX_DISABLE_COMPATIBILITY_PLUGIN];
  if (skills.length > 0) {
    const config = skills
      .map((skill) => `{path=${JSON.stringify(join(skill.path, "SKILL.md"))},enabled=true}`)
      .join(",");
    args.push("-c", `skills.config=[${config}]`);
  }
  return args;
}

interface Receipt {
  schema_version: number;
  harness: HarnessName;
  session_id: string;
  capabilities: string[];
  digest: string;
}

export function capabilitiesRoot(env: Environ, home: string): string {
  const explicit = env["AGENTSTART_CAPABILITIES_ROOT"];
  if (explicit !== undefined && explicit !== "") {
    if (!isAbsolute(explicit)) {
      throw new CliError(
        "capabilities_root_relative",
        `AGENTSTART_CAPABILITIES_ROOT must be absolute: ${explicit}`,
      );
    }
    return explicit;
  }
  return join(dataDirectory(env, home, "agentstart"), "capabilities");
}

export function requestedCapabilityIds(
  parts: Partitioned,
  env: Environ,
  home: string,
  harness: HarnessName,
  sessionId: string | null,
): string[] {
  const explicit = parts.lists["x-capability"] ?? [];
  const noCommon = parts.bools.has("x-no-common");
  if (sessionId !== null && explicit.length === 0 && !noCommon) {
    const receipt = readReceipt(env, home, harness, sessionId);
    if (receipt !== null) return receipt.capabilities;
  }
  const ids = [...(noCommon ? [] : ["common"]), ...explicit];
  const unique: string[] = [];
  for (const id of ids) {
    if (!PACK_ID.test(id)) {
      throw new UsageError(`invalid capability pack name "${id}"`);
    }
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

export function resolveCapabilities(
  ids: string[],
  env: Environ,
  home: string,
  prepare: boolean,
): CapabilitySet {
  const root = capabilitiesRoot(env, home);
  const packs = ids.map((id) => loadPack(root, id));
  assertNoConflicts(packs);
  const digest = digestPacks(packs);
  const projectionRoot = join(root, "projections", digest);
  const guidance = packs
    .filter((pack) => pack.guidance !== "")
    .map((pack) => `<!-- capability:${pack.id} -->\n${pack.guidance.trimEnd()}\n`)
    .join("\n");
  const hasClaudeResources = packs.some(
    (pack) => pack.skills.length > 0 || pack.claudeRoot !== null,
  );
  const projectedSkills = packs.flatMap((pack) =>
    pack.skills.map((skill) => ({
      name: skill.name,
      path: join(projectionRoot, "skills", skill.name),
    })),
  );
  const set: CapabilitySet = {
    ids,
    digest,
    root: projectionRoot,
    claudePluginDir: hasClaudeResources ? join(projectionRoot, "claude", "agent") : null,
    skillRoots: projectedSkills.length === 0 ? [] : [join(projectionRoot, "skills")],
    skills: projectedSkills,
    guidance,
    guidanceFile: guidance === "" ? null : join(projectionRoot, "guidance.md"),
    piExtensions: packs.flatMap((pack) =>
      pack.piExtensions.map((path) =>
        join(projectionRoot, "pi", "extensions", pack.id, basename(path)),
      ),
    ),
    piPromptTemplates: packs.flatMap((pack) =>
      pack.piPromptTemplates.map((path) =>
        join(projectionRoot, "pi", "prompt-templates", pack.id, basename(path)),
      ),
    ),
    receiptRequired: ids.length !== 1 || ids[0] !== "common",
  };
  if (prepare) prepareProjection(set, packs);
  return set;
}

export function applyCapabilityArguments(spec: LaunchSpec, set: CapabilitySet): LaunchSpec {
  const [bin, ...native] = spec.command;
  if (bin === undefined) return spec;
  const args: string[] = [];
  if (spec.harness === "codex") {
    if (spec.transport === "codex-remote") return spec;
    const commandIndex = codexNonInteractiveCommandIndex(native);
    if (commandIndex === null) {
      throw new CliError(
        "codex_launch_shape",
        `native Codex capability launch has no exec, e, or review command: ${spec.command.join(" ")}`,
      );
    }
    args.push(...codexSkillPolicyArguments(set.skills));
    if (set.guidance !== "") {
      args.push("-c", `developer_instructions=${JSON.stringify(set.guidance)}`);
    }
    return {
      ...spec,
      command: [
        bin,
        ...native.slice(0, commandIndex + 1),
        ...args,
        ...native.slice(commandIndex + 1),
      ],
    };
  }
  if (spec.harness === "claude") {
    if (set.claudePluginDir !== null) args.push("--plugin-dir", set.claudePluginDir);
    if (set.guidanceFile !== null) args.push("--append-system-prompt-file", set.guidanceFile);
  } else {
    args.push("--no-skills", "--no-extensions", "--no-prompt-templates");
    for (const skill of set.skills) args.push("--skill", skill.path);
    for (const extension of set.piExtensions) args.push("--extension", extension);
    for (const template of set.piPromptTemplates) {
      args.push("--prompt-template", template);
    }
    if (set.guidanceFile !== null) args.push("--append-system-prompt", set.guidanceFile);
  }
  return { ...spec, command: [bin, ...args, ...native] };
}

export function writeCapabilityReceipt(
  env: Environ,
  home: string,
  harness: HarnessName,
  sessionId: string,
  set: CapabilitySet,
): void {
  if (!set.receiptRequired) return;
  const path = receiptPath(env, home, harness, sessionId);
  const receipt: Receipt = {
    schema_version: MANIFEST_VERSION,
    harness,
    session_id: sessionId,
    capabilities: set.ids,
    digest: set.digest,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.next-${process.pid}`;
  writeFileSync(next, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, path);
}

function loadPack(capabilityRoot: string, id: string): LoadedPack {
  const root = join(capabilityRoot, "packs", id);
  const manifestPath = join(root, "capability.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new CliError(
      "capability_missing",
      `cannot load capability pack "${id}" at ${manifestPath}: ${message(error)}`,
      "run ~/code/agentstart/scripts/sync-skills, or choose an installed pack",
    );
  }
  const manifest = parseManifest(parsed, id, manifestPath);
  if (id === "common" && !manifest.default) {
    throw new CliError("capability_invalid", `${manifestPath}: common must be the default pack`);
  }
  if (id !== "common" && manifest.default) {
    throw new CliError("capability_invalid", `${manifestPath}: only common may be a default pack`);
  }
  const resource = (name: string): string | null => {
    const value = manifest.resources[name];
    return value === undefined ? null : resourcePath(root, value, `${manifestPath}:${name}`);
  };
  const skillsRoot = resource("skills");
  const skills = skillsRoot === null ? [] : discoverSkills(skillsRoot, id);
  const guidancePath = resource("guidance");
  const guidance = guidancePath === null ? "" : readResourceFile(guidancePath, id, "guidance");
  const claudeRoot = optionalDirectory(resource("claude"), id, "claude");
  const piExtensions = discoverFiles(resource("pi_extensions"), id, "pi_extensions");
  const piPromptTemplates = discoverFiles(
    resource("pi_prompt_templates"),
    id,
    "pi_prompt_templates",
  );
  return {
    id,
    root,
    manifest,
    skillsRoot,
    skills,
    guidance,
    claudeRoot,
    piExtensions,
    piPromptTemplates,
  };
}

function parseManifest(value: unknown, id: string, path: string): CapabilityManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("capability_invalid", `${path} must contain a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schema_version", "id", "default", "description", "resources"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new CliError("capability_invalid", `${path}: unknown key ${key}`);
  }
  if (record["schema_version"] !== MANIFEST_VERSION) {
    throw new CliError(
      "capability_version",
      `${path}: expected schema_version ${MANIFEST_VERSION}`,
    );
  }
  if (record["id"] !== id) {
    throw new CliError("capability_invalid", `${path}: id must be "${id}"`);
  }
  if (typeof record["default"] !== "boolean" || typeof record["description"] !== "string") {
    throw new CliError("capability_invalid", `${path}: default and description have wrong types`);
  }
  const resources = record["resources"];
  if (typeof resources !== "object" || resources === null || Array.isArray(resources)) {
    throw new CliError("capability_invalid", `${path}: resources must be an object`);
  }
  const typed: Record<string, string> = {};
  for (const [key, resource] of Object.entries(resources)) {
    if (!RESOURCE_KEYS.has(key)) {
      throw new CliError("capability_invalid", `${path}: unsupported resource ${key}`);
    }
    if (typeof resource !== "string" || resource === "") {
      throw new CliError("capability_invalid", `${path}: resource ${key} must be a path`);
    }
    typed[key] = resource;
  }
  return {
    schema_version: MANIFEST_VERSION,
    id,
    default: record["default"],
    description: record["description"],
    resources: typed,
  };
}

function resourcePath(root: string, value: string, label: string): string {
  if (isAbsolute(value)) throw new CliError("capability_invalid", `${label} must be relative`);
  const target = resolve(root, value);
  const inside = relative(root, target);
  if (inside === "" || inside === "." || inside.startsWith("..") || isAbsolute(inside)) {
    throw new CliError("capability_invalid", `${label} escapes its capability pack`);
  }
  return target;
}

function discoverSkills(root: string, pack: string): Array<{ name: string; path: string }> {
  const directory = optionalDirectory(root, pack, "skills");
  if (directory === null) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: join(directory, entry.name) }))
    .filter((skill) => existsSync(join(skill.path, "SKILL.md")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function discoverFiles(root: string | null, pack: string, resource: string): string[] {
  const directory = optionalDirectory(root, pack, resource);
  if (directory === null) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(directory, entry.name))
    .sort();
}

function optionalDirectory(path: string | null, pack: string, resource: string): string | null {
  if (path === null || !existsSync(path)) return null;
  if (!lstatSync(path).isDirectory()) {
    throw new CliError(
      "capability_invalid",
      `capability pack "${pack}" resource ${resource} is not a directory: ${path}`,
    );
  }
  return path;
}

function readResourceFile(path: string, pack: string, resource: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(
      "capability_invalid",
      `cannot read capability pack "${pack}" resource ${resource}: ${message(error)}`,
    );
  }
}

function assertNoConflicts(packs: LoadedPack[]): void {
  const skillOwners = new Map<string, string>();
  const claudeOwners = new Map<string, string>();
  for (const pack of packs) {
    for (const skill of pack.skills) {
      const owner = skillOwners.get(skill.name);
      if (owner !== undefined) {
        throw new CliError(
          "capability_conflict",
          `skill "${skill.name}" is provided by both ${owner} and ${pack.id}`,
        );
      }
      skillOwners.set(skill.name, pack.id);
    }
    if (pack.claudeRoot === null) continue;
    for (const resource of ["commands", "agents", "hooks", ".mcp.json", "settings.json"]) {
      const path = join(pack.claudeRoot, resource);
      if (!existsSync(path)) continue;
      if (resource.startsWith(".") || resource.endsWith(".json")) {
        const owner = claudeOwners.get(resource);
        if (owner !== undefined) {
          throw new CliError(
            "capability_conflict",
            `Claude resource ${resource} is provided by both ${owner} and ${pack.id}`,
          );
        }
        claudeOwners.set(resource, pack.id);
        continue;
      }
      for (const entry of readdirSync(path)) {
        const key = `${resource}/${entry}`;
        const owner = claudeOwners.get(key);
        if (owner !== undefined) {
          throw new CliError(
            "capability_conflict",
            `Claude resource ${key} is provided by both ${owner} and ${pack.id}`,
          );
        }
        claudeOwners.set(key, pack.id);
      }
    }
  }
}

function digestPacks(packs: LoadedPack[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const pack of packs) hashTree(hasher, pack.root, pack.root);
  return hasher.digest("hex").slice(0, 24);
}

function hashTree(hasher: Bun.CryptoHasher, root: string, path: string): void {
  const stat = lstatSync(path);
  const name = relative(root, path) || ".";
  hasher.update(`${name}\0${stat.mode}\0`);
  if (stat.isSymbolicLink()) {
    hasher.update(`link\0${readlinkSync(path)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path).sort()) hashTree(hasher, root, join(path, entry));
    return;
  }
  hasher.update(readFileSync(path));
}

function prepareProjection(set: CapabilitySet, packs: LoadedPack[]): void {
  if (existsSync(join(set.root, ".complete"))) return;
  const parent = dirname(set.root);
  mkdirSync(parent, { recursive: true });
  const next = mkdtempSync(join(parent, `.${set.digest}.`));
  try {
    if (set.skills.length > 0) {
      const target = join(next, "skills");
      mkdirSync(target, { recursive: true });
      for (const pack of packs) {
        for (const skill of pack.skills) copyResource(skill.path, join(target, skill.name));
      }
    }
    for (const pack of packs) {
      copyProjectedResources(next, "extensions", pack.id, pack.piExtensions);
      copyProjectedResources(next, "prompt-templates", pack.id, pack.piPromptTemplates);
    }
    if (set.claudePluginDir !== null) {
      const plugin = join(next, "claude", "agent");
      mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(plugin, ".claude-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "agent",
            version: "1.0.0",
            description: `AgentLaunch projection: ${set.ids.join(", ")}`,
            author: { name: "AgentStart" },
          },
          null,
          2,
        )}\n`,
      );
      if (set.skills.length > 0) {
        mkdirSync(join(plugin, "skills"), { recursive: true });
        for (const skill of set.skills) {
          symlinkSync(
            join("..", "..", "..", "skills", skill.name),
            join(plugin, "skills", skill.name),
          );
        }
      }
      for (const pack of packs) mergeClaudeResources(plugin, pack);
    }
    if (set.guidance !== "") writeFileSync(join(next, "guidance.md"), set.guidance);
    writeFileSync(join(next, ".complete"), `${set.digest}\n`);
    try {
      renameSync(next, set.root);
    } catch (error) {
      if (!existsSync(join(set.root, ".complete"))) throw error;
      rmSync(next, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(next, { recursive: true, force: true });
    throw error;
  }
}

function copyProjectedResources(
  projection: string,
  kind: "extensions" | "prompt-templates",
  pack: string,
  resources: string[],
): void {
  if (resources.length === 0) return;
  const target = join(projection, "pi", kind, pack);
  mkdirSync(target, { recursive: true });
  for (const resource of resources) copyResource(resource, join(target, basename(resource)));
}

function copyResource(source: string, target: string): void {
  cpSync(source, target, { recursive: true, dereference: true, preserveTimestamps: true });
}

function mergeClaudeResources(plugin: string, pack: LoadedPack): void {
  if (pack.claudeRoot === null) return;
  for (const directory of ["commands", "agents", "hooks"]) {
    const source = join(pack.claudeRoot, directory);
    if (!existsSync(source)) continue;
    const target = join(plugin, directory);
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source).sort()) {
      copyResource(join(source, entry), join(target, entry));
    }
  }
  for (const file of [".mcp.json", "settings.json"]) {
    const source = join(pack.claudeRoot, file);
    if (existsSync(source)) copyResource(source, join(plugin, file));
  }
}

function receiptPath(env: Environ, home: string, harness: HarnessName, sessionId: string): string {
  return join(
    stateDirectory(env, home, "agentlaunch"),
    "capabilities",
    harness,
    `${sessionId}.json`,
  );
}

function readReceipt(
  env: Environ,
  home: string,
  harness: HarnessName,
  sessionId: string,
): Receipt | null {
  const path = receiptPath(env, home, harness, sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Receipt>;
    if (
      parsed.schema_version !== MANIFEST_VERSION ||
      parsed.harness !== harness ||
      parsed.session_id !== sessionId ||
      !Array.isArray(parsed.capabilities) ||
      !parsed.capabilities.every((id) => typeof id === "string" && PACK_ID.test(id)) ||
      typeof parsed.digest !== "string"
    ) {
      throw new Error("receipt fields do not match the native session");
    }
    return parsed as Receipt;
  } catch (error) {
    throw new CliError(
      "capability_receipt_invalid",
      `cannot restore capability receipt ${path}: ${message(error)}`,
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
