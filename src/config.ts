import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigValues } from "./config-schema.ts";
import { parseConfig } from "./config-schema.ts";
import { CliError } from "./errors.ts";
import type { HarnessName } from "./harness.ts";
import { HARNESS_NAMES } from "./harness.ts";
import type { Environ } from "./paths.ts";
import { configDirectory } from "./paths.ts";

/** Per-user launcher configuration. Yolo defaults on (ADR 0009); the file
 * exists to disable it. Strictly validated against `config-schema.ts`: a
 * config that would be silently misread is worse than none, because a
 * disabling config with a typo would quietly launch with the gates down
 * against the operator's wishes — it must fail the launch instead. */
export interface Config {
  yolo: Record<HarnessName, boolean>;
  path: string;
  exists: boolean;
}

const ALL_YOLO: Record<HarnessName, boolean> = { claude: true, codex: true, pi: true };

export function configPath(env: Environ, home: string): string {
  return join(configDirectory(env, home, "agentsurface"), "config.json");
}

export function loadConfig(env: Environ, home: string): Config {
  const path = configPath(env, home);
  if (!existsSync(path)) return { yolo: { ...ALL_YOLO }, path, exists: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(
      "config_invalid",
      `${path} is not valid JSON: ${(error as Error).message}`,
      `fix or remove ${path}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      "config_invalid",
      `${path} must hold a JSON object`,
      `fix or remove ${path}`,
    );
  }
  const values = parseConfig(parsed as Record<string, unknown>, path);
  return { yolo: resolveYolo(values.yolo), path, exists: true };
}

/** The defaults live here rather than in the schema: an omitted key must
 * survive the parse as omitted, so that what a missing answer means stays
 * one decision stated in one place (ADR 0009). */
function resolveYolo(value: ConfigValues["yolo"]): Record<HarnessName, boolean> {
  if (value === undefined) return { ...ALL_YOLO };
  if (typeof value === "boolean") return { claude: value, codex: value, pi: value };
  const yolo = { ...ALL_YOLO };
  for (const harness of HARNESS_NAMES) {
    const flag = value[harness];
    if (flag !== undefined) yolo[harness] = flag;
  }
  return yolo;
}
