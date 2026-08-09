import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./errors.ts";
import type { HarnessName } from "./harness.ts";
import { HARNESS_NAMES } from "./harness.ts";
import type { Environ } from "./paths.ts";
import { configDirectory } from "./paths.ts";

/** Per-user launcher configuration. Strictly validated: a config that would
 * be silently misread is worse than none, because yolo opens permission
 * gates — a typo must fail the launch, not quietly launch gated. */
export interface Config {
  yolo: Record<HarnessName, boolean>;
  path: string;
  exists: boolean;
}

const NO_YOLO: Record<HarnessName, boolean> = { claude: false, codex: false, pi: false };

export function configPath(env: Environ, home: string): string {
  return join(configDirectory(env, home, "agentsurface"), "config.json");
}

export function loadConfig(env: Environ, home: string): Config {
  const path = configPath(env, home);
  if (!existsSync(path)) return { yolo: { ...NO_YOLO }, path, exists: false };
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
  const body = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(body).filter((key) => key !== "yolo");
  if (unknownKeys.length > 0) {
    throw new CliError(
      "config_invalid",
      `${path} has unknown key${unknownKeys.length > 1 ? "s" : ""}: ${unknownKeys.join(", ")}`,
      `remove them from ${path}`,
    );
  }
  return { yolo: parseYolo(body["yolo"], path), path, exists: true };
}

function parseYolo(value: unknown, path: string): Record<HarnessName, boolean> {
  if (value === undefined) return { ...NO_YOLO };
  if (typeof value === "boolean") {
    return { claude: value, codex: value, pi: value };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(
      "config_invalid",
      `${path}: "yolo" must be a boolean or an object of per-harness booleans`,
      `fix ${path}`,
    );
  }
  const map = value as Record<string, unknown>;
  const yolo = { ...NO_YOLO };
  for (const [key, flag] of Object.entries(map)) {
    if (!(HARNESS_NAMES as readonly string[]).includes(key)) {
      throw new CliError(
        "config_invalid",
        `${path}: "yolo" names an unknown harness "${key}" (expected claude, codex, pi)`,
        `fix ${path}`,
      );
    }
    if (typeof flag !== "boolean") {
      throw new CliError(
        "config_invalid",
        `${path}: "yolo.${key}" must be a boolean`,
        `fix ${path}`,
      );
    }
    yolo[key as HarnessName] = flag;
  }
  return yolo;
}
