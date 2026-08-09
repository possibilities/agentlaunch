import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageDefinition from "../package.json";
import type { Envelope } from "../src/envelope.ts";
import { VERSION } from "../src/help.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const SESSION_ID = "05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every spawn gets a private HOME and empty session stores, so no test can
 * see this machine's real sessions — or launch a real harness. */
function run(args: string[], extraEnv: Record<string, string> = {}, cwd?: string): RunResult {
  const root = mkdtempSync(join(tmpdir(), "agentsurface-cli-"));
  roots.push(root);
  const result = Bun.spawnSync({
    cmd: ["bun", MAIN, ...args],
    cwd: cwd ?? root,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: join(root, "home"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      // These tests assert the raw launch grammar; balanced composition has
      // its own suite (balance.test.ts) with a fake stack.
      AGENTSURFACE_NO_BALANCE: "1",
      ...extraEnv,
    },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function envelope(result: RunResult): Envelope<Record<string, unknown>> {
  return JSON.parse(result.stdout) as Envelope<Record<string, unknown>>;
}

describe("surface", () => {
  test("VERSION is pinned to package.json", () => {
    expect(VERSION).toBe(packageDefinition.version);
    expect(run(["--version"]).stdout.trim()).toBe(VERSION);
  });

  test("help lands on stdout and unknown commands are usage faults", () => {
    expect(run([]).stdout).toContain("agentsurface — one launcher");
    expect(run(["--agent-teaser"]).stdout).toContain("Launch agent harnesses");
    expect(run(["--agent-help"]).stdout).toContain("agent runbook");
    expect(run(["claude", "--x-help"]).stdout).toContain("Launch the harness in this terminal");
    const unknown = run(["land"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown command "land"');
  });

  test("the retired grammar is refused loudly, never misread", () => {
    const open = run(["open", "claude", "--x-dry-run"]);
    expect(open.code).toBe(2);
    expect(open.stderr).toContain("the harness name is the command");
    expect(run(["resume", SESSION_ID]).stderr).toContain("resume is now x-resume");
    expect(run(["doctor"]).stderr).toContain("doctor is now x-doctor");
    expect(run(["help"]).stderr).toContain("--x-help");
  });

  test("every unprefixed token forwards verbatim, in the order typed", () => {
    const result = run([
      "claude",
      "fix the tests",
      "--model",
      "fable",
      "--x-dry-run",
      "--x-json",
      "--x-no-yolo",
      "--totally-unknown-flag",
    ]);
    expect(result.code).toBe(0);
    const parsed = envelope(result);
    expect(parsed.data?.["command"]).toEqual([
      "claude",
      "fix the tests",
      "--model",
      "fable",
      "--totally-unknown-flag",
    ]);
  });

  test("a literal -- has no meaning and forwards like any token", () => {
    const result = run(["claude", "--x-dry-run", "--x-json", "--x-no-yolo", "--", "--weird"]);
    expect(envelope(result).data?.["command"]).toEqual(["claude", "--", "--weird"]);
  });

  test("bare x-* words in command position are reserved", () => {
    const result = run(["claude", "x-something"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown x command "x-something"');
  });

  test("--x-dry-run --x-json emits the launch spec envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-cwd-"));
    roots.push(root);
    const result = run(
      ["claude", "--model", "fable", "fix the tests", "--x-dry-run", "--x-json", "--x-no-yolo"],
      {},
      root,
    );
    expect(result.code).toBe(0);
    const parsed = envelope(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({
      harness: "claude",
      session_id: null,
      cwd: realpathSync(root),
      command: ["claude", "--model", "fable", "fix the tests"],
      balance: null,
      utility: false,
      yolo: false,
      redactions: [],
    });
  });

  test("yolo is on by default and injects the harness's own flag", () => {
    const claude = run(["claude", "--x-dry-run", "--x-json"]);
    expect(envelope(claude).data?.["command"]).toEqual([
      "claude",
      "--dangerously-skip-permissions",
    ]);
    expect(envelope(claude).data?.["yolo"]).toBe(true);
    const codex = run(["codex", "--x-dry-run", "--x-json"]);
    expect(envelope(codex).data?.["command"]).toEqual([
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    const pi = run(["pi", "--x-dry-run", "--x-json"]);
    expect(envelope(pi).data?.["command"]).toEqual(["pi", "--approve"]);
  });

  test("the config file disables yolo, and --x-yolo forces it back per launch", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-yolo-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "agentsurface"), { recursive: true });
    writeFileSync(
      join(home, ".config", "agentsurface", "config.json"),
      JSON.stringify({ yolo: { claude: false } }),
    );
    const off = run(["claude", "--x-dry-run", "--x-json"], { HOME: home });
    expect(envelope(off).data?.["command"]).toEqual(["claude"]);
    expect(envelope(off).data?.["yolo"]).toBe(false);
    const forced = run(["claude", "--x-yolo", "--x-dry-run", "--x-json"], { HOME: home });
    expect(envelope(forced).data?.["command"]).toEqual([
      "claude",
      "--dangerously-skip-permissions",
    ]);
    const both = run(["pi", "--x-yolo", "--x-no-yolo", "--x-dry-run"]);
    expect(both.code).toBe(2);
  });

  test("a scoped --x-no-yolo only bites its own harness", () => {
    const other = run(["claude", "--x-no-yolo", "codex", "--x-dry-run", "--x-json"]);
    expect(envelope(other).data?.["command"]).toEqual(["claude", "--dangerously-skip-permissions"]);
    const scoped = run(["claude", "--x-no-yolo", "claude", "--x-dry-run", "--x-json"]);
    expect(envelope(scoped).data?.["command"]).toEqual(["claude"]);
  });

  test("--x-no-yolo redacts an explicitly forwarded yolo flag and narrates it", () => {
    const result = run([
      "claude",
      "--dangerously-skip-permissions",
      "--model",
      "fable",
      "--x-no-yolo",
      "--x-dry-run",
      "--x-json",
    ]);
    const parsed = envelope(result);
    expect(parsed.data?.["command"]).toEqual(["claude", "--model", "fable"]);
    expect(parsed.data?.["redactions"]).toEqual(["--dangerously-skip-permissions"]);
    const narrated = run(["pi", "-a", "--x-no-yolo", "--x-dry-run"]);
    expect(narrated.stdout.trim()).toBe("pi");
    expect(narrated.stderr).toContain("yolo    off · removed -a · explicitly forwarded");
  });

  test("pi's own --no-approve wins over default-on injection", () => {
    const result = run(["pi", "--no-approve", "--x-dry-run", "--x-json"]);
    expect(envelope(result).data?.["command"]).toEqual(["pi", "--no-approve"]);
  });

  test("utility invocations stay bare under yolo, x-flags anywhere", () => {
    const result = run(["codex", "--x-dry-run", "--x-json", "login"]);
    const parsed = envelope(result);
    expect(parsed.data?.["command"]).toEqual(["codex", "login"]);
    expect(parsed.data?.["utility"]).toBe(true);
  });

  test("a malformed config fails the launch and x-doctor reports it", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-badconf-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "agentsurface"), { recursive: true });
    writeFileSync(join(home, ".config", "agentsurface", "config.json"), "not json");
    const launch = run(["claude", "--x-dry-run", "--x-json"], { HOME: home });
    expect(launch.code).toBe(1);
    expect(envelope(launch).error?.code).toBe("config_invalid");
    const doctor = run(["x-doctor", "--x-json"], { HOME: home });
    expect(doctor.code).toBe(0);
    const config = envelope(doctor).data?.["config"] as { valid: boolean };
    expect(config.valid).toBe(false);
  });

  test("an explicit --x-yolo still works while the config is malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-badconf2-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "agentsurface"), { recursive: true });
    writeFileSync(join(home, ".config", "agentsurface", "config.json"), "not json");
    const result = run(["claude", "--x-no-yolo", "--x-dry-run", "--x-json"], { HOME: home });
    expect(result.code).toBe(0);
    expect(envelope(result).data?.["command"]).toEqual(["claude"]);
  });

  test("--x-dry-run without --x-json prints a shell line", () => {
    const result = run(["codex", "two words", "--x-dry-run", "--x-no-yolo"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("codex 'two words'");
  });

  test("launch-command --x-json without --x-dry-run is a usage fault", () => {
    const result = run(["claude", "--x-json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--x-json needs --x-dry-run");
  });

  test("unknown --x-* flags are usage faults", () => {
    const result = run(["claude", "--x-bogus"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown option "--x-bogus"');
  });

  test("x-resume detects the owning store and spells pi resume as --session", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-store-"));
    roots.push(root);
    const projects = join(root, "claude", "projects", "-somewhere");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${SESSION_ID}.jsonl`), "{}\n");
    const found = run(["x-resume", SESSION_ID, "--x-dry-run", "--x-json", "--x-no-yolo"], {
      CLAUDE_CONFIG_DIR: join(root, "claude"),
    });
    expect(found.code).toBe(0);
    expect(envelope(found).data?.["command"]).toEqual(["claude", "--resume", SESSION_ID]);

    const forced = run([
      "x-resume",
      SESSION_ID,
      "--x-harness",
      "pi",
      "--x-dry-run",
      "--x-json",
      "--x-no-yolo",
    ]);
    expect(envelope(forced).data?.["command"]).toEqual(["pi", "--session", SESSION_ID]);
  });

  test("x-resume injects yolo like a launch and forwards extra tokens", () => {
    const result = run([
      "x-resume",
      SESSION_ID,
      "--x-harness",
      "claude",
      "--continue-ish",
      "--x-dry-run",
      "--x-json",
    ]);
    expect(envelope(result).data?.["command"]).toEqual([
      "claude",
      "--resume",
      SESSION_ID,
      "--dangerously-skip-permissions",
      "--continue-ish",
    ]);
  });

  test("x-resume misses are domain errors, not launches", () => {
    const human = run(["x-resume", SESSION_ID]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("is not in the claude, codex, or pi session stores");
    expect(human.stderr).toContain("--x-harness");

    const machine = run(["x-resume", SESSION_ID, "--x-dry-run", "--x-json"]);
    expect(machine.code).toBe(1);
    const parsed = envelope(machine);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("session_not_found");
  });

  test("the launch narrative goes to stderr as aligned rows, leaving stdout usable", () => {
    const result = run(["claude", "--model", "fable", "--x-dry-run", "--x-no-yolo"]);
    expect(result.code).toBe(0);
    // stdout stays a runnable shell line, so --x-dry-run can be piped.
    expect(result.stdout.trim()).toBe("claude --model fable");
    const rows = result.stderr.trimEnd().split("\n");
    expect(rows[0]).toBe("open    claude");
    expect(rows[1]).toMatch(/^cwd {5}\S/);
    expect(rows).toContain("yolo    off · permission prompts stay on");
    expect(rows).toContain("account skipped · balancing off (AGENTSURFACE_NO_BALANCE)");
    expect(rows).toContain("dry run nothing launched · command on stdout");
    // Every row shares one value column.
    for (const row of rows) expect(row.slice(0, 8)).toMatch(/^\S.{0,6} +$|^\S{8}$/);
  });

  test("--x-json silences the narrative so the envelope stands alone", () => {
    const result = run(["claude", "--x-dry-run", "--x-json", "--x-verbose"]);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  test("--x-verbose adds mechanism rows, default keeps them out", () => {
    const quiet = run(["claude", "--x-dry-run"]);
    expect(quiet.stderr).not.toContain("config ");
    const loud = run(["claude", "--x-dry-run", "--x-verbose"]);
    expect(loud.stderr).toContain("config  ");
    expect(loud.stderr).toContain("missing · yolo on everywhere");
  });

  test("the narrative names the yolo and utility decisions", () => {
    const yolo = run(["pi", "--x-dry-run"]);
    expect(yolo.stderr).toContain("yolo    on · --approve");
    const utility = run(["codex", "--x-dry-run", "login"]);
    expect(utility.stderr).toContain("account skipped · login is a utility invocation");
    expect(utility.stderr).not.toContain("yolo    on · --dangerously");
  });

  test("x-resume narrates which store owned the session", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-narr-"));
    roots.push(root);
    const projects = join(root, "claude", "projects", "-somewhere");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${SESSION_ID}.jsonl`), "{}\n");
    const result = run(["x-resume", SESSION_ID, "--x-dry-run"], {
      CLAUDE_CONFIG_DIR: join(root, "claude"),
    });
    expect(result.stderr).toContain(`resume  claude · ${SESSION_ID}`);
  });

  test("x-doctor --x-json reports all three stores and refuses arguments", () => {
    const result = run(["x-doctor", "--x-json"]);
    expect(result.code).toBe(0);
    const parsed = envelope(result);
    const harnesses = parsed.data?.["harnesses"] as Array<{ harness: string }>;
    expect(harnesses.map((report) => report.harness)).toEqual(["claude", "codex", "pi"]);
    expect(run(["x-doctor", "stray"]).code).toBe(2);
  });

  test("x-doctor reports the catalog, downgrading a malformed custom one", () => {
    const clean = envelope(run(["x-doctor", "--x-json"]));
    const catalog = clean.data?.["catalog"] as {
      source: string;
      valid: boolean;
      harnesses: Array<{ harness: string; models: number }>;
    };
    expect(catalog.source).toBe("built-in");
    expect(catalog.valid).toBe(true);
    expect(catalog.harnesses.map((entry) => entry.harness)).toEqual(["claude", "codex", "pi"]);

    const root = mkdtempSync(join(tmpdir(), "agentsurface-badcat-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "agentsurface"), { recursive: true });
    writeFileSync(join(home, ".config", "agentsurface", "catalog.json"), "not json");
    const doctor = run(["x-doctor", "--x-json"], { HOME: home });
    expect(doctor.code).toBe(0);
    const bad = envelope(doctor).data?.["catalog"] as { source: string; valid: boolean };
    expect(bad.valid).toBe(false);
    expect(bad.source).toBe("custom");
  });
});
