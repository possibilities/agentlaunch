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
  yolo?: boolean | undefined;
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

/** One flag per harness that drops its permission gates. Pi has no gates
 * on tools at all; --approve only auto-trusts project-local files. */
export const YOLO_FLAGS: Record<HarnessName, string> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  pi: "--approve",
};

/** Yolo never touches a utility invocation (`codex login` would reject the
 * flag, and a flag ahead of the word would defeat first-token
 * classification) and never duplicates a flag the caller already
 * forwarded. */
function yoloArguments(
  harness: HarnessName,
  yolo: boolean | undefined,
  argvWithoutYolo: string[],
): string[] {
  if (yolo !== true) return [];
  if (utilityInvocation(harness, argvWithoutYolo)) return [];
  const flag = YOLO_FLAGS[harness];
  if (argvWithoutYolo.includes(flag)) return [];
  return [flag];
}

export function buildOpen(harness: HarnessName, request: OpenRequest): LaunchSpec {
  const { model, effort, name, prompt, passthrough, yolo } = request;
  if (effort !== undefined && !EFFORT_LEVELS[harness].includes(effort)) {
    throw new UsageError(
      `${harness} effort must be one of ${EFFORT_LEVELS[harness].join(", ")} (got "${effort}")`,
    );
  }
  if (name !== undefined && !RUN_NAMES_SUPPORTED[harness]) {
    throw new UsageError(`${harness} does not support run names; omit --name`);
  }
  const own: string[] = [];
  if (model !== undefined) own.push("--model", model);
  if (effort !== undefined) {
    if (harness === "claude") own.push("--effort", effort);
    // Codex has no effort flag; only the TOML config override reaches it.
    if (harness === "codex") own.push("-c", `model_reasoning_effort="${effort}"`);
    if (harness === "pi") own.push("--thinking", effort);
  }
  if (name !== undefined) own.push("--name", name);
  // The prompt stays last so passthrough flags cannot capture it as a value.
  const tail = prompt === undefined ? [...passthrough] : [...passthrough, prompt];
  const command = [harness, ...own, ...yoloArguments(harness, yolo, [...own, ...tail]), ...tail];
  return { harness, command, sessionId: null };
}

/**
 * Management and service words per harness — everything in each CLI's
 * command list that opens no account-bound model session. A first token in
 * this set makes the invocation a utility invocation: balancing it is
 * meaningless (no quota is spent on an account) and the swap wrappers
 * reject several outright (codex `login` cannot run under an account pin).
 * Session words stay out: codex exec/e/review/resume/fork, and every
 * prompt/flag launch. Matches each CLI's own parsing — a leading
 * subcommand word already outranks the prompt positional there, so a
 * "prompt" equal to one of these words was never going to be a prompt.
 * Verified against codex-cli 0.147.0, claude 2.x, pi; re-check on harness
 * upgrades.
 */
const UTILITY_WORDS: Record<HarnessName, ReadonlySet<string>> = {
  claude: new Set([
    "agents",
    "auth",
    "auto-mode",
    "doctor",
    "gateway",
    "import",
    "install",
    "mcp",
    "plugin",
    "plugins",
    "project",
    "setup-token",
    "ultrareview",
    "update",
    "upgrade",
    "help",
  ]),
  codex: new Set([
    "login",
    "logout",
    "mcp",
    "plugin",
    "mcp-server",
    "app-server",
    "remote-control",
    "app",
    "completion",
    "update",
    "doctor",
    "sandbox",
    "debug",
    "apply",
    "a",
    "archive",
    "delete",
    "unarchive",
    "cloud",
    "exec-server",
    "features",
    "help",
  ]),
  pi: new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "help"]),
};

const BARE_UTILITY_FLAGS = new Set(["-h", "--help", "-v", "-V", "--version"]);

/**
 * First-token classification of the argv after the binary. Flags ahead of a
 * subcommand (`codex -c k=v login`) classify as a session — the shim path
 * never produces that shape, and misclassifying toward balance fails the
 * same way the raw CLI run would, never the other way around.
 */
export function utilityInvocation(harness: HarnessName, argvAfterBin: string[]): boolean {
  const first = argvAfterBin[0];
  if (first === undefined) return false;
  if (BARE_UTILITY_FLAGS.has(first)) return true;
  return UTILITY_WORDS[harness].has(first);
}

export function buildResume(
  harness: HarnessName,
  sessionId: string,
  passthrough: string[],
  yolo = false,
): LaunchSpec {
  // Pi's --resume is a boolean that opens a picker; --session is its by-id
  // spelling. Emitting pi --resume <id> would strand the id as a prompt.
  const base =
    harness === "claude"
      ? ["claude", "--resume", sessionId]
      : harness === "codex"
        ? ["codex", "resume", sessionId]
        : ["pi", "--session", sessionId];
  const flag = YOLO_FLAGS[harness];
  const inject = yolo && !passthrough.includes(flag);
  const command = [...base, ...(inject ? [flag] : []), ...passthrough];
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
