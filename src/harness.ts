import { join } from "node:path";
import { UsageError } from "./errors.ts";
import type { Environ } from "./paths.ts";
import { expandTilde } from "./paths.ts";

export type HarnessName = "claude" | "codex" | "pi";

export const HARNESS_NAMES: readonly HarnessName[] = ["claude", "codex", "pi"];

export function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value);
}

export function parseHarnessName(value: string): HarnessName {
  if (isHarnessName(value)) return value;
  throw new UsageError(`unknown harness "${value}" (expected claude, codex, or pi)`);
}

/**
 * How a provider name from the catalog combines with a model name when the
 * harness emits its model argument. Null means the harness has no provider
 * semantics, and a provider on its catalog include is a catalog fault. Pi
 * spells providers as a path prefix: openai-codex + gpt-5.6 →
 * openai-codex/gpt-5.6.
 */
export const PROVIDER_SPELLINGS: Record<
  HarnessName,
  ((provider: string, model: string) => string) | null
> = {
  claude: null,
  codex: null,
  pi: (provider, model) => `${provider}/${model}`,
};

/** What a launch is, apart from launching it. A surface consumes this same
 * shape later, so nothing in here may assume a live terminal. */
export interface LaunchSpec {
  harness: HarnessName;
  command: string[];
  sessionId: string | null;
}

/**
 * Every spelling each harness accepts for its own permission bypass; the
 * first is canonical and is what injection emits. Pi has no gates on tools
 * at all — `--approve` (and its `-a` short) only auto-trusts project-local
 * files. Verified against claude 2.1.x, codex-cli 0.147.0, pi 0.84.1;
 * re-check on harness upgrades.
 */
export const YOLO_SPELLINGS: Record<HarnessName, readonly string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  pi: ["--approve", "-a"],
};

/** A harness's own negative spelling. A caller who typed it has decided, so
 * yolo never injects over it. Only pi has one. */
const NATIVE_NO_YOLO: Record<HarnessName, readonly string[]> = {
  claude: [],
  codex: [],
  pi: ["--no-approve", "-na"],
};

export interface YoloDecision {
  /** Resolved state: per-launch flags beat the config; no config means on
   * (ADR 0009). */
  on: boolean;
  /** An explicit --x-no-yolo redacts forwarded yolo spellings; a config
   * that says off only declines to inject. */
  explicitOff: boolean;
}

export interface YoloApplication {
  /** The harness stream after redaction and injection. */
  tokens: string[];
  injected: string | null;
  redacted: string[];
  /** A yolo (or native no-yolo) spelling the caller forwarded themselves. */
  present: string | null;
  presentNegative: boolean;
}

/** Yolo never touches a utility invocation (`codex login` rejects the flag)
 * and never duplicates or contradicts a spelling the caller forwarded. The
 * one edit it makes against the caller's argv — --x-no-yolo removing an
 * explicitly forwarded yolo flag — is reported for the narrative. */
export function applyYolo(
  harness: HarnessName,
  tokens: string[],
  decision: YoloDecision,
  utility: boolean,
): YoloApplication {
  const spellings = YOLO_SPELLINGS[harness];
  const negatives = NATIVE_NO_YOLO[harness];
  const redacted: string[] = [];
  let kept = tokens;
  if (decision.explicitOff) {
    kept = tokens.filter((token) => {
      if (!spellings.includes(token)) return true;
      redacted.push(token);
      return false;
    });
  }
  const present =
    kept.find((token) => spellings.includes(token) || negatives.includes(token)) ?? null;
  const presentNegative = present !== null && negatives.includes(present);
  if (!decision.on || utility || present !== null) {
    return { tokens: kept, injected: null, redacted, present, presentNegative };
  }
  const canonical = spellings[0]!;
  return {
    tokens: [canonical, ...kept],
    injected: canonical,
    redacted,
    present: null,
    presentNegative: false,
  };
}

export function buildOpen(harness: HarnessName, tokens: string[]): LaunchSpec {
  return { harness, command: [harness, ...tokens], sessionId: null };
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
 * First-token classification of the harness stream. Flags ahead of a
 * subcommand (`codex -c k=v login`) classify as a session — misclassifying
 * toward balance fails the same way the raw CLI run would, never the other
 * way around. The stream is partitioned before this runs, so x-flags can
 * sit anywhere in the typed command without defeating it.
 */
export function utilityInvocation(harness: HarnessName, argvAfterBin: string[]): boolean {
  const first = argvAfterBin[0];
  if (first === undefined) return false;
  if (BARE_UTILITY_FLAGS.has(first)) return true;
  return UTILITY_WORDS[harness].has(first);
}

export function buildResume(harness: HarnessName, sessionId: string, tokens: string[]): LaunchSpec {
  // Pi's --resume is a boolean that opens a picker; --session is its by-id
  // spelling. Emitting pi --resume <id> would strand the id as a prompt.
  const base =
    harness === "claude"
      ? ["claude", "--resume", sessionId]
      : harness === "codex"
        ? ["codex", "resume", sessionId]
        : ["pi", "--session", sessionId];
  return { harness, command: [...base, ...tokens], sessionId };
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
