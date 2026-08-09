import { join } from "node:path";
import { UsageError } from "./errors.ts";
import type { Environ } from "./paths.ts";
import { expandTilde } from "./paths.ts";

export type HarnessName = "claude" | "codex" | "pi";

export const HARNESS_NAMES: readonly HarnessName[] = ["claude", "codex", "pi"];

export function parseHarnessName(value: string): HarnessName {
  if ((HARNESS_NAMES as readonly string[]).includes(value)) return value as HarnessName;
  throw new UsageError(`unknown harness "${value}" (expected claude, codex, or pi)`);
}

/** What a launch is, apart from launching it. A surface consumes this same
 * shape later, so nothing in here may assume a live terminal. */
export interface LaunchSpec {
  harness: HarnessName;
  command: string[];
  sessionId: string | null;
}

export interface OpenRequest {
  model?: string | undefined;
  effort?: string | undefined;
  name?: string | undefined;
  prompt?: string | undefined;
  passthrough: string[];
}

/** The flag is canonical; the value sets are per-harness realities — codex
 * has no max, claude has no off or minimal. */
const EFFORT_LEVELS: Record<HarnessName, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

const RUN_NAMES_SUPPORTED: Record<HarnessName, boolean> = {
  claude: true,
  codex: false,
  pi: true,
};

export function buildOpen(harness: HarnessName, request: OpenRequest): LaunchSpec {
  const { model, effort, name, prompt, passthrough } = request;
  if (effort !== undefined && !EFFORT_LEVELS[harness].includes(effort)) {
    throw new UsageError(
      `${harness} effort must be one of ${EFFORT_LEVELS[harness].join(", ")} (got "${effort}")`,
    );
  }
  if (name !== undefined && !RUN_NAMES_SUPPORTED[harness]) {
    throw new UsageError(`${harness} does not support run names; omit --name`);
  }
  const command: string[] = [harness];
  if (model !== undefined) command.push("--model", model);
  if (effort !== undefined) {
    if (harness === "claude") command.push("--effort", effort);
    // Codex has no effort flag; only the TOML config override reaches it.
    if (harness === "codex") command.push("-c", `model_reasoning_effort="${effort}"`);
    if (harness === "pi") command.push("--thinking", effort);
  }
  if (name !== undefined) command.push("--name", name);
  command.push(...passthrough);
  // The prompt stays last so passthrough flags cannot capture it as a value.
  if (prompt !== undefined) command.push(prompt);
  return { harness, command, sessionId: null };
}

export function buildResume(
  harness: HarnessName,
  sessionId: string,
  passthrough: string[],
): LaunchSpec {
  // Pi's --resume is a boolean that opens a picker; --session is its by-id
  // spelling. Emitting pi --resume <id> would strand the id as a prompt.
  const command =
    harness === "claude"
      ? ["claude", "--resume", sessionId, ...passthrough]
      : harness === "codex"
        ? ["codex", "resume", sessionId, ...passthrough]
        : ["pi", "--session", sessionId, ...passthrough];
  return { harness, command, sessionId };
}

export interface SessionStore {
  harness: HarnessName;
  /** Env var that relocates the store; swap tools lean on these, so honoring
   * them is what keeps resume working under per-account profiles. */
  override: string;
  overrideActive: boolean;
  root: string;
  /** Glob patterns, relative to root, naming the session file for an id.
   * The id must already be glob-literal (see assertSessionId); "*" is the
   * one deliberate exception, used to count a whole store. */
  patternsFor(sessionId: string): string[];
}

export function sessionStore(harness: HarnessName, env: Environ, home: string): SessionStore {
  switch (harness) {
    case "claude": {
      const value = env["CLAUDE_CONFIG_DIR"];
      const active = value !== undefined && value !== "";
      const base = active ? expandTilde(value, home) : join(home, ".claude");
      return {
        harness,
        override: "CLAUDE_CONFIG_DIR",
        overrideActive: active,
        root: join(base, "projects"),
        patternsFor: (sessionId) => [`*/${sessionId}.jsonl`],
      };
    }
    case "codex": {
      const value = env["CODEX_HOME"];
      const active = value !== undefined && value !== "";
      const base = active ? expandTilde(value, home) : join(home, ".codex");
      return {
        harness,
        override: "CODEX_HOME",
        overrideActive: active,
        root: base,
        patternsFor: (sessionId) => [
          `sessions/**/rollout-*-${sessionId}.jsonl`,
          `sessions/**/rollout-*-${sessionId}.jsonl.zst`,
          `archived_sessions/rollout-*-${sessionId}.jsonl`,
          `archived_sessions/rollout-*-${sessionId}.jsonl.zst`,
        ],
      };
    }
    case "pi": {
      const value = env["PI_CODING_AGENT_DIR"];
      const active = value !== undefined && value !== "";
      const base = active ? expandTilde(value, home) : join(home, ".pi", "agent");
      return {
        harness,
        override: "PI_CODING_AGENT_DIR",
        overrideActive: active,
        root: join(base, "sessions"),
        patternsFor: (sessionId) => [`*/*_${sessionId}.jsonl`],
      };
    }
  }
}
