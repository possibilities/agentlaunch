import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CliError, UsageError } from "./errors.ts";
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

/**
 * Who the enclosing harness says its own tools are running as, read from the
 * environment a harness gives the commands its agent runs. This is how a
 * worker answers "which run am I?" without anything having to be stamped for
 * it — the harness already knows, and says so.
 *
 * Only two of the three say it. Claude pairs its session id with a marker so a
 * stale variable inherited by an unrelated process cannot pass for one. Codex
 * exports the thread id that *is* its session id — and note it comes from the
 * app-server rather than the session's own process, which is exactly why an
 * environment variable stamped on the launch could never be trusted here
 * (ADR 0024). Pi exports nothing usable, so it falls back to the workspace.
 */
export function callerSession(env: Environ): { harness: HarnessName; sessionId: string } | null {
  const claude = env["CLAUDE_CODE_SESSION_ID"];
  if (claude !== undefined && claude !== "" && env["CLAUDECODE"] === "1") {
    return { harness: "claude", sessionId: claude };
  }
  const codex = env["CODEX_THREAD_ID"];
  if (codex !== undefined && codex !== "") return { harness: "codex", sessionId: codex };
  return null;
}

/** The first forwarded token that natively claims the working-directory
 * dimension — codex's `--cd` or its `-C` short. Only codex has one. */
export function workspaceDimensionToken(
  harness: HarnessName,
  tokens: readonly string[],
): string | null {
  if (harness !== "codex") return null;
  for (const token of tokens) {
    if (token === "--cd" || token.startsWith("--cd=")) return token;
    if (token === "-C" || token.startsWith("-C=")) return token;
  }
  return null;
}

/**
 * How a harness is told which directory it is working in, when the workspace
 * is only known after it has been created (ADR 0023). Only codex needs it, and
 * only because of how it reaches its model: a session attached to a shared
 * app-server through `--remote` has its thread created *server-side*, so the
 * thread records the app-server's working directory rather than the terminal's
 * — `/` for a launchd-started one. Everything that identifies a codex session
 * by where it is working then fails: the bus cannot place a peer in a
 * workspace, and session discovery (ADR 0014) matches a cwd that never occurs.
 *
 * An absolute path is required. Verified against codex-cli 0.147.0: `--cd
 * <abs>` reaches the thread through a remote attach, while `--cd .` and the
 * inherited process directory do not. claude and pi take nothing here — they
 * run in the terminal's own directory and record it.
 */
export function workspaceArguments(harness: HarnessName, workspacePath: string): string[] {
  return harness === "codex" ? ["--cd", workspacePath] : [];
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
      if (
        (token.startsWith("-c=") || token.startsWith("--config=")) &&
        token.slice(token.indexOf("=") + 1).startsWith("model_reasoning_effort=")
      ) {
        return token;
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

/**
 * Whether a harness stops to ask about a directory it has not seen, and how to
 * answer that ahead of time for one the operator's own tooling just created
 * (ADR 0021). Only codex needs it: it asks once per directory before doing
 * anything at all, no launch flag skips it (`--dangerously-bypass-approvals-
 * and-sandbox` covers tool approvals, not this), and an unattended Placement
 * simply stops there forever. The answer is written exactly where the dialog
 * itself writes it, and an existing entry is never rewritten — a directory the
 * operator has already judged keeps their judgement, including a refusal.
 *
 * Codex still publishes no trust command: `codex` has no subcommand for it,
 * and the only writer in the app-server protocol is the generic experimental
 * `config/write`, which needs a live server connection at Prepare and knows
 * nothing of never-overwriting an answer. So the file stays the interface,
 * and everything below is what makes writing another program's file safe.
 */
export type TrustOutcome = "trusted" | "already" | "not applicable";

export function ensureWorkspaceTrusted(
  harness: HarnessName,
  env: Environ,
  home: string,
  workspacePath: string,
): TrustOutcome {
  if (harness !== "codex") return "not applicable";
  const root = sessionStore("codex", env, home).root;
  const config = join(root, "config.toml");
  let resolved = workspacePath;
  try {
    resolved = realpathSync(workspacePath);
  } catch {
    // Not yet on disk: the path as given is the best key available.
  }
  mkdirSync(root, { recursive: true });
  return withTrustLock(config, () => {
    const current = existsSync(config) ? readFileSync(config, "utf8") : "";
    if (projectAlreadyJudged(current, resolved, config)) return "already";
    // TOML basic-string quoting; codex keys these tables by the resolved path.
    const header = `[projects.${JSON.stringify(resolved)}]`;
    const body = current === "" || current.endsWith("\n") ? current : `${current}\n`;
    writeConfigAtomically(
      config,
      `${body}${body === "" ? "" : "\n"}${header}\ntrust_level = "trusted"\n`,
    );
    return "trusted";
  });
}

/**
 * The read-check-write above is one critical section across every agentsurface
 * process, because two parallel Placements of the same new Workspace both miss
 * the table and both append it — and a config with two `[projects."<path>"]`
 * tables is TOML no reader accepts, which breaks codex entirely. An in-process
 * mutex cannot say that; a lock file beside the config, created exclusively,
 * can. A lock left behind by a killed writer would otherwise stop every later
 * Placement, so one older than the longest a trust write can plausibly take is
 * treated as debris.
 */
const TRUST_LOCK_STALE_MS = 30_000;
const TRUST_LOCK_WAIT_MS = 10_000;
const TRUST_LOCK_POLL_MS = 25;

function withTrustLock<T>(config: string, operation: () => T): T {
  const lock = `${config}.agentsurface-lock`;
  const deadline = Date.now() + TRUST_LOCK_WAIT_MS;
  for (;;) {
    let handle: number;
    try {
      handle = openSync(lock, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new CliError(
          "codex_trust_unwritable",
          `${lock} could not be created: ${(error as Error).message}`,
          `check that ${dirname(lock)} is writable, then retry`,
        );
      }
      if (Date.now() > deadline) {
        throw new CliError(
          "codex_trust_locked",
          `another agentsurface process has held ${lock} for more than ${TRUST_LOCK_WAIT_MS}ms`,
          `check for a stuck placement, then remove ${lock}`,
        );
      }
      if (lockIsDebris(lock)) {
        try {
          unlinkSync(lock);
        } catch {
          // Another caller reaped the same lock; the retry decides.
        }
        continue;
      }
      Bun.sleepSync(TRUST_LOCK_POLL_MS);
      continue;
    }
    try {
      writeSync(handle, `${process.pid}\n`);
      return operation();
    } finally {
      closeSync(handle);
      try {
        unlinkSync(lock);
      } catch {
        // Reaped as debris while we held it: the next writer already decides.
      }
    }
  }
}

function lockIsDebris(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > TRUST_LOCK_STALE_MS;
  } catch {
    // Gone between the failed create and here: retry rather than reap.
    return false;
  }
}

/**
 * Replace the config as one file, never in place: an appending writer that is
 * killed mid-write leaves a half-written table, and the operator's own content
 * has to survive byte for byte — this is codex's file, holding settings this
 * repository knows nothing about. The lock excludes other agentsurface
 * processes; codex's own writes go through its interactive dialog, whose
 * window this does not share.
 */
function writeConfigAtomically(path: string, contents: string): void {
  const temp = `${path}.agentsurface-${process.pid}.tmp`;
  try {
    const handle = openSync(temp, "w");
    try {
      writeFileSync(handle, contents);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    try {
      chmodSync(temp, statSync(path).mode & 0o777);
    } catch {
      // No previous file, so the default mode is the right one.
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already renamed into place.
    }
    throw new CliError(
      "codex_trust_unwritable",
      `${path} could not be written: ${(error as Error).message}`,
      `check that ${dirname(path)} is writable, then retry`,
    );
  }
}

/**
 * Whether the operator's config already answers for this directory — matched
 * semantically, because `[projects."/p"]`, `[projects.'/p']` and
 * `[ projects . "/p" ]` are one table and only the first is the spelling this
 * file writes. An answer found here is kept whatever it says: a refusal is a
 * judgement too (ADR 0021).
 */
function projectAlreadyJudged(config: string, resolved: string, path: string): boolean {
  let table: string[] = [];
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const inner = tableHeaderText(line);
      if (inner === null) continue;
      const keys = parseDottedKey(inner);
      if (keys === null) {
        // An exotic spelling this parser cannot read: naming the path at all
        // is enough to leave it alone, since appending beside an existing
        // table is what produces invalid TOML.
        if (inner.includes("projects") && inner.includes(resolved)) return true;
        table = [];
        continue;
      }
      table = keys;
      if (keys[0] === "projects" && keys[1] === resolved) return true;
      continue;
    }
    const keys = parseDottedKey(line);
    if (keys === null) continue;
    if (table.length === 0 && keys[0] === "projects") {
      if (keys.length === 1) {
        // `projects = { … }` is an inline table, and TOML forbids extending
        // one with a table header. Refusing is the honest answer: appending
        // would produce a config codex cannot read.
        throw new CliError(
          "codex_trust_unwritable",
          `${path} defines projects as an inline table, which no table header may extend`,
          `add trust_level = "trusted" for ${resolved} to that table by hand, then retry`,
        );
      }
      if (keys[1] === resolved) return true;
      continue;
    }
    if (table.length === 1 && table[0] === "projects" && keys[0] === resolved) return true;
  }
  return false;
}

/** The text between a table header's brackets, array-of-tables included; null
 * when the line is not a header this parser recognizes. */
function tableHeaderText(line: string): string | null {
  const doubled = line.startsWith("[[");
  const open = doubled ? 2 : 1;
  const close = line.lastIndexOf(doubled ? "]]" : "]");
  if (close <= open) return null;
  return line.slice(open, close).trim();
}

/** A TOML dotted key: bare keys, basic strings, and literal strings, with any
 * spacing around the dots. Null when the text is not one, including a
 * key/value line whose key this parser cannot read. */
function parseDottedKey(text: string): string[] | null {
  const keys: string[] = [];
  let index = 0;
  const skipSpace = (): void => {
    while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  };
  for (;;) {
    skipSpace();
    const quote = text[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let value = "";
      let closed = false;
      while (index < text.length) {
        const character = text[index] as string;
        if (character === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (quote === '"' && character === "\\") {
          const escaped = TOML_ESCAPES[text[index + 1] ?? ""];
          if (escaped === undefined) return null;
          value += escaped;
          index += 2;
          continue;
        }
        value += character;
        index += 1;
      }
      if (!closed) return null;
      keys.push(value);
    } else {
      let value = "";
      while (index < text.length && BARE_KEY_CHARACTER.test(text[index] as string)) {
        value += text[index];
        index += 1;
      }
      if (value === "") return null;
      keys.push(value);
    }
    skipSpace();
    if (text[index] === ".") {
      index += 1;
      continue;
    }
    // A key line ends at its `=`; a header's text ends outright.
    if (index === text.length || text[index] === "=") return keys;
    return null;
  }
}

const BARE_KEY_CHARACTER = /[A-Za-z0-9_-]/;

/** Only the escapes a path can plausibly carry; anything else makes the key
 * unreadable rather than misread. */
const TOML_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  n: "\n",
  t: "\t",
  r: "\r",
};
