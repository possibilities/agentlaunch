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

/** How a resolved model is spelled at launch. One spelling everywhere;
 * the per-harness variation lives in the spelling string itself
 * (provider-combined for pi). */
export function modelArguments(spelling: string): string[] {
  return ["--model", spelling];
}

/** How a resolved effort is spelled at launch: claude and pi have flags,
 * codex only takes the TOML config override. */
export function effortArguments(harness: HarnessName, effort: string): string[] {
  switch (harness) {
    case "claude":
      return ["--effort", effort];
    case "codex":
      return ["-c", `model_reasoning_effort="${effort}"`];
    case "pi":
      return ["--thinking", effort];
  }
}

/**
 * How a run name is spelled at launch, or null where the harness has no
 * launch-time name at all. Verified against the live CLIs: claude
 * `-n, --name <name>` (its own help calls it the display name for the
 * session picker and terminal title), pi `--name, -n <name>`, and codex
 * none — its sessions carry names that `codex resume` accepts, but nothing
 * assigns one at launch. The gap is why a name is surface metadata as well
 * as a harness flag.
 */
export function nameArguments(harness: HarnessName, name: string): string[] | null {
  switch (harness) {
    case "claude":
    case "pi":
      return ["--name", name];
    case "codex":
      return null;
  }
}

/** The first forwarded token that natively claims the name dimension —
 * `--name`, `--name=…`, or the `-n` alias claude and pi share — or null.
 * Codex has none, so nothing there can conflict. */
export function nameDimensionToken(harness: HarnessName, tokens: readonly string[]): string | null {
  if (harness === "codex") return null;
  for (const token of tokens) {
    if (token === "--name" || token.startsWith("--name=")) return token;
    if (token === "-n" || token.startsWith("-n=")) return token;
  }
  return null;
}

/** The first forwarded token that natively claims the model dimension —
 * `--model`, `--model=…`, codex's `-m` — or null. Read for conflict and
 * yield decisions; the tokens themselves are never edited. */
export function modelDimensionToken(
  harness: HarnessName,
  tokens: readonly string[],
): string | null {
  for (const token of tokens) {
    if (token === "--model" || token.startsWith("--model=")) return token;
    if (harness === "codex" && (token === "-m" || token.startsWith("-m="))) return token;
  }
  return null;
}

/** The first forwarded token that natively claims the effort dimension —
 * claude `--effort`, pi `--thinking`, codex `-c|--config` whose value sets
 * model_reasoning_effort — or null. */
export function effortDimensionToken(
  harness: HarnessName,
  tokens: readonly string[],
): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (harness === "claude" && (token === "--effort" || token.startsWith("--effort="))) {
      return token;
    }
    if (harness === "pi" && (token === "--thinking" || token.startsWith("--thinking="))) {
      return token;
    }
    if (harness === "codex") {
      if (
        (token === "-c" || token === "--config") &&
        tokens[i + 1]?.startsWith("model_reasoning_effort=")
      ) {
        return `${token} ${tokens[i + 1]}`;
      }
    }
  }
  return null;
}

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

export interface SessionFileFacts {
  cwd: string | null;
  sessionId: string | null;
}

/**
 * What a session file says about itself, per store layout: codex and pi
 * carry cwd and id in their first line (session_meta / session header);
 * claude files scatter cwd through the records and put the id only in the
 * filename. Read bounded — a session transcript can be huge, and these
 * facts live at the head.
 */
export async function sessionFileFacts(
  harness: HarnessName,
  path: string,
): Promise<SessionFileFacts> {
  let head: string;
  try {
    head = await readHead(path, 262_144);
  } catch {
    return { cwd: null, sessionId: null };
  }
  if (harness === "claude") {
    const cwd = head.match(/"cwd"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    const base = path.slice(path.lastIndexOf("/") + 1);
    const sessionId = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : null;
    return { cwd, sessionId };
  }
  const firstLine = head.split("\n", 1)[0] ?? "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return { cwd: null, sessionId: null };
  }
  if (harness === "codex") {
    const payload = parsed["payload"];
    const record =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : parsed;
    return {
      cwd: stringField(record, "cwd"),
      sessionId: stringField(record, "session_id") ?? stringField(record, "id"),
    };
  }
  return { cwd: stringField(parsed, "cwd"), sessionId: stringField(parsed, "id") };
}

async function readHead(path: string, bytes: number): Promise<string> {
  const file = Bun.file(path);
  return await file.slice(0, Math.min(bytes, file.size)).text();
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
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
