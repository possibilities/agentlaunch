import { statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { CliError } from "./errors.ts";
import type { Environ } from "./paths.ts";

/** One-shot producer contract from AgentRoles to the immediate AgentLaunch shim. */
export const ROLE_RESOURCES_MARKER = "AGENTLAUNCH_ROLE_RESOURCES";
export const ROLE_RESOURCES_VERSION = "agentroles-v1";

export interface ExplicitRoleResources {
  name: string;
  root: string;
}

/**
 * An explicit role is a complete skill/MCP layer, including deliberate
 * omissions. The marker alone is insufficient: bind it to the exact role
 * directory and name AgentRoles already passes to the child.
 */
export function explicitRoleResources(env: Environ): ExplicitRoleResources | null {
  const marker = env[ROLE_RESOURCES_MARKER];
  if (marker === undefined) return null;
  if (marker !== ROLE_RESOURCES_VERSION) invalid("has an unsupported value");

  const root = env["AGENTROLES_ROLE"];
  const name = env["AGENTROLES_NAME"];
  if (root === undefined || root === "" || !isAbsolute(root))
    invalid("requires an absolute AGENTROLES_ROLE");
  if (name === undefined || name === "" || basename(root) !== name)
    invalid("requires AGENTROLES_NAME to match the role directory");
  let directory: boolean;
  try {
    directory = statSync(root).isDirectory();
  } catch {
    invalid("names an unreadable role source");
  }
  if (!directory) invalid("names a role source that is not a directory");
  return { name, root };
}

function invalid(detail: string): never {
  throw new CliError(
    "role_resources_invalid",
    `${ROLE_RESOURCES_MARKER} ${detail}`,
    "run the invocation through agentroles again; do not set its private AgentLaunch marker by hand",
  );
}
