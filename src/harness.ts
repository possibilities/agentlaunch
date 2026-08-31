import { join } from "node:path";
import { UsageError } from "./errors.ts";
import type { Environ } from "./paths.ts";
import { expandTilde } from "./paths.ts";

export type HarnessName = "claude" | "codex";

export const HARNESS_NAMES: readonly HarnessName[] = ["claude", "codex"];

export function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value);
}

export function parseHarnessName(value: string): HarnessName {
  if (isHarnessName(value)) return value;
  throw new UsageError(`unknown harness "${value}" (expected claude or codex)`);
}

/** How a resolved model is spelled at launch. */
export function modelArguments(spelling: string): string[] {
  return ["--model", spelling];
}

/** How a resolved effort is spelled at launch. */
export function effortArguments(harness: HarnessName, effort: string): string[] {
  switch (harness) {
    case "claude":
      return ["--effort", effort];
    case "codex":
      return ["-c", `model_reasoning_effort="${effort}"`];
  }
}

/** The first forwarded token that natively claims the working-directory
 * dimension — codex's `--cd` or its `-C` short. Only codex has one. */
export function cwdDimensionToken(harness: HarnessName, tokens: readonly string[]): string | null {
  if (harness !== "codex") return null;
  for (const token of tokens) {
    if (token === "--cd" || token.startsWith("--cd=")) return token;
    if (token === "-C" || token.startsWith("-C=")) return token;
  }
  return null;
}

/** Explicitly anchor a new Codex native session to the launch cwd. Claude
 * inherits its process cwd and needs no argument. */
export function cwdArguments(harness: HarnessName, cwd: string): string[] {
  return harness === "codex" ? ["--cd", cwd] : [];
}

/** The first forwarded token that natively claims the model dimension —
 * `--model`, `--model=…`, codex's `-m` in its split, inline, and attached
 * shapes, and codex's `model=` config spelling through `-c`/`--config` —
 * or null. Read for conflict and yield decisions; the tokens themselves are
 * never edited. */
export function modelDimensionToken(
  harness: HarnessName,
  tokens: readonly string[],
): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--model" || token.startsWith("--model=")) return token;
    if (harness !== "codex") continue;
    if (token === "-m" || token.startsWith("-m=")) return token;
    // The attached short form: clap takes `-mgpt-x` with no separator, and it
    // reaches the model exactly as `-m gpt-x` does — the same one-fewer-space
    // bypass the effort detection below already refuses.
    if (token.startsWith("-m") && token.length > 2) return token;
    // The config spelling: `model=` through -c/--config sets this dimension
    // just as the -m flag does, in any of clap's three shapes.
    if ((token === "-c" || token === "--config") && tokens[i + 1]?.startsWith("model=")) {
      return `${token} ${tokens[i + 1]}`;
    }
    if (
      (token.startsWith("-c=") || token.startsWith("--config=")) &&
      token.slice(token.indexOf("=") + 1).startsWith("model=")
    ) {
      return token;
    }
    if (
      token.startsWith("-c") &&
      token.length > 2 &&
      token[2] !== "=" &&
      token.slice(2).startsWith("model=")
    ) {
      return token;
    }
  }
  return null;
}

/** The first forwarded token that natively claims the effort dimension —
 * claude `--effort`, or codex `-c|--config` whose value sets
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
    if (harness === "codex") {
      if (
        (token === "-c" || token === "--config") &&
        tokens[i + 1]?.startsWith("model_reasoning_effort=")
      ) {
        return `${token} ${tokens[i + 1]}`;
      }
      if (
        (token.startsWith("-c=") || token.startsWith("--config=")) &&
        token.slice(token.indexOf("=") + 1).startsWith("model_reasoning_effort=")
      ) {
        return token;
      }
      // The attached short form: codex's clap parser takes `-cKEY=VAL` with no
      // separator at all, and it reaches the config exactly as the split form
      // does — so a conflict spelled this way has to be seen here, or the
      // refusal is bypassable by typing one fewer space.
      if (
        token.startsWith("-c") &&
        token.length > 2 &&
        token[2] !== "=" &&
        token.slice(2).startsWith("model_reasoning_effort=")
      ) {
        return token;
      }
    }
  }
  return null;
}

export interface LaunchSpec {
  harness: HarnessName;
  command: string[];
  sessionId: string | null;
}

/**
 * Every spelling each harness accepts for the unattended end of its own
 * permission gates; the first is canonical and is what injection emits. A
 * spelling is a token sequence because claude's is a pair (ADR 0031):
 * `--dangerously-skip-permissions` drops the gates and
 * `--allow-dangerously-skip-permissions` is what lets the session offer
 * that bypass at all, so an unattended claude needs both. Verified against
 * claude 2.1.227 and codex-cli 0.147.0; re-check on harness upgrades.
 */
export const YOLO_SPELLINGS: Record<HarnessName, readonly (readonly string[])[]> = {
  claude: [
    ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"],
    ["--dangerously-skip-permissions"],
  ],
  codex: [["--dangerously-bypass-approvals-and-sandbox"]],
};

/** A harness's own negative spelling. A caller who typed it has decided, so
 * yolo never injects over it. */
const NATIVE_NO_YOLO: Record<HarnessName, readonly string[]> = {
  claude: [],
  codex: [],
};

/** A flag whose *value* settles the gates, so typing it at all is the
 * caller's decision however it is set — including `auto`, which is a mode
 * the caller chose rather than the one this launcher injects. Only claude
 * has one. */
const GATE_FLAG: Record<HarnessName, string | null> = {
  claude: "--permission-mode",
  codex: null,
};

interface GateMatch {
  /** Where it sits in the stream, and how many tokens it occupies. */
  at: number;
  span: number;
  /** The spelling as the caller wrote it, for narration and redactions. */
  display: string;
  negative: boolean;
}

/** The first gate spelling in a forwarded stream, however it is written:
 * a bare flag, a `--flag value` pair, or a `--flag=value` single token. */
function findGate(harness: HarnessName, tokens: readonly string[]): GateMatch | null {
  const spellings = YOLO_SPELLINGS[harness];
  const negatives = NATIVE_NO_YOLO[harness];
  const gateFlag = GATE_FLAG[harness];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at]!;
    if (negatives.includes(token)) {
      return { at, span: 1, display: token, negative: true };
    }
    const spelling = spellings.find((candidate) =>
      candidate.every((word, offset) => tokens[at + offset] === word),
    );
    if (spelling !== undefined) {
      return { at, span: spelling.length, display: spelling.join(" "), negative: false };
    }
    if (gateFlag === null) continue;
    // The same flag set any other way: the caller has decided the gates.
    if (token === gateFlag && at + 1 < tokens.length) {
      return { at, span: 2, display: `${gateFlag} ${tokens[at + 1]}`, negative: true };
    }
    if (token.startsWith(`${gateFlag}=`)) {
      return { at, span: 1, display: token, negative: true };
    }
  }
  return null;
}

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
  const redacted: string[] = [];
  let kept = [...tokens];
  if (decision.explicitOff) {
    // Past a negative the caller typed, not through it: only yolo spellings
    // are ever removed.
    let cursor = 0;
    for (;;) {
      const found = findGate(harness, kept.slice(cursor));
      if (found === null) break;
      const at = cursor + found.at;
      if (found.negative) {
        cursor = at + found.span;
        continue;
      }
      redacted.push(found.display);
      kept = [...kept.slice(0, at), ...kept.slice(at + found.span)];
      cursor = at;
    }
  }
  const match = findGate(harness, kept);
  const present = match?.display ?? null;
  const presentNegative = match?.negative ?? false;
  if (!decision.on || utility || match !== null) {
    return { tokens: kept, injected: null, redacted, present, presentNegative };
  }
  // A canonical pair can be half-typed — claude's permitting flag says
  // nothing about the gates on its own — so inject only what is missing.
  const canonical = YOLO_SPELLINGS[harness][0]!.filter((word) => !kept.includes(word));
  if (canonical.length === 0) {
    return { tokens: kept, injected: null, redacted, present, presentNegative };
  }
  return {
    tokens: [...canonical, ...kept],
    injected: canonical.join(" "),
    redacted,
    present: null,
    presentNegative: false,
  };
}

const CODEX_NON_INTERACTIVE_COMMANDS = new Set(["exec", "e", "review"]);
const CODEX_GLOBAL_VALUE_FLAGS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
]);
const CODEX_ATTACHED_VALUE_FLAGS = ["-c", "-i", "-m", "-p", "-s", "-C", "-a"];

/** Index of Codex's non-interactive top-level command after global options.
 * The launcher calls this both before and after its own global injections, so
 * `codex exec`, `codex -m gpt-x exec`, and the fully resolved command agree. */
export function codexNonInteractiveCommandIndex(tokens: readonly string[]): number | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") return null;
    if (CODEX_GLOBAL_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("--") || token === "-V" || token === "-h") continue;
    if (
      CODEX_ATTACHED_VALUE_FLAGS.some(
        (flag) => token.startsWith(flag) && token.length > flag.length,
      )
    ) {
      continue;
    }
    return CODEX_NON_INTERACTIVE_COMMANDS.has(token) ? index : null;
  }
  return null;
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
 * Verified against codex-cli 0.147.0 and claude 2.x; re-check on harness
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
  const base =
    harness === "claude" ? ["claude", "--resume", sessionId] : ["codex", "resume", sessionId];
  return {
    harness,
    command: [...base, ...tokens],
    sessionId,
  };
}

export interface SessionFileFacts {
  cwd: string | null;
  sessionId: string | null;
}

/**
 * What a session file says about itself, per store layout: codex carries cwd
 * and id in its first session_meta line; claude files scatter cwd through
 * the records and put the id only in the filename. Read bounded — a session
 * transcript can be huge, and these facts live at the head.
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
  const payload = parsed["payload"];
  const record =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : parsed;
  return {
    cwd: stringField(record, "cwd"),
    sessionId: stringField(record, "session_id") ?? stringField(record, "id"),
  };
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
  }
}
