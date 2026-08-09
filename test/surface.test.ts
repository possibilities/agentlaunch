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
    expect(run(["--agent-teaser"]).stdout).toContain("Open and resume agent harnesses");
    expect(run(["--agent-help"]).stdout).toContain("agent runbook");
    const unknown = run(["land"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown command "land"');
  });

  test("open --dry-run --json emits the launch spec envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-cwd-"));
    roots.push(root);
    const result = run(
      [
        "open",
        "claude",
        "fix the tests",
        "--model",
        "fable",
        "--effort",
        "max",
        "--dry-run",
        "--json",
      ],
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
      command: ["claude", "--model", "fable", "--effort", "max", "fix the tests"],
      balance: null,
      utility: false,
      yolo: false,
    });
  });

  test("config-file yolo injects the flag and per-launch flags override", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-yolo-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "agentsurface"), { recursive: true });
    writeFileSync(
      join(home, ".config", "agentsurface", "config.json"),
      JSON.stringify({ yolo: { claude: true } }),
    );
    const on = run(["open", "claude", "--dry-run", "--json"], { HOME: home });
    expect(envelope(on).data?.["command"]).toEqual(["claude", "--dangerously-skip-permissions"]);
    expect(envelope(on).data?.["yolo"]).toBe(true);
    const off = run(["open", "claude", "--no-yolo", "--dry-run", "--json"], { HOME: home });
    expect(envelope(off).data?.["command"]).toEqual(["claude"]);
    const forced = run(["open", "pi", "--yolo", "--dry-run", "--json"]);
    expect(envelope(forced).data?.["command"]).toEqual(["pi", "--approve"]);
    const both = run(["open", "pi", "--yolo", "--no-yolo", "--dry-run"]);
    expect(both.code).toBe(2);
  });

  test("utility invocations stay bare under yolo", () => {
    const result = run(["open", "codex", "--yolo", "--dry-run", "--json", "--", "login"]);
    const parsed = envelope(result);
    expect(parsed.data?.["command"]).toEqual(["codex", "login"]);
    expect(parsed.data?.["utility"]).toBe(true);
  });

  test("a malformed config fails the launch and doctor reports it", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-badconf-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "agentsurface"), { recursive: true });
    writeFileSync(join(home, ".config", "agentsurface", "config.json"), "not json");
    const launch = run(["open", "claude", "--dry-run", "--json"], { HOME: home });
    expect(launch.code).toBe(1);
    expect(envelope(launch).error?.code).toBe("config_invalid");
    const doctor = run(["doctor", "--json"], { HOME: home });
    expect(doctor.code).toBe(0);
    const config = envelope(doctor).data?.["config"] as { valid: boolean };
    expect(config.valid).toBe(false);
  });

  test("open --dry-run without --json prints a shell line", () => {
    const result = run(["open", "codex", "two words", "--effort", "xhigh", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`codex -c 'model_reasoning_effort="xhigh"' 'two words'`);
  });

  test("passthrough after -- reaches the harness verbatim", () => {
    const result = run([
      "open",
      "claude",
      "--dry-run",
      "--json",
      "--",
      "--permission-mode",
      "plan",
      "-h",
    ]);
    const parsed = envelope(result);
    expect(parsed.data?.["command"]).toEqual(["claude", "--permission-mode", "plan", "-h"]);
  });

  test("launch-command --json without --dry-run is a usage fault", () => {
    const result = run(["open", "claude", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--json needs --dry-run");
  });

  test("per-harness effort validation is a usage fault", () => {
    const result = run(["open", "codex", "--effort", "max"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("codex effort must be one of");
  });

  test("resume detects the owning store and spells pi resume as --session", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-store-"));
    roots.push(root);
    const projects = join(root, "claude", "projects", "-somewhere");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${SESSION_ID}.jsonl`), "{}\n");
    const found = run(["resume", SESSION_ID, "--dry-run", "--json"], {
      CLAUDE_CONFIG_DIR: join(root, "claude"),
    });
    expect(found.code).toBe(0);
    expect(envelope(found).data?.["command"]).toEqual(["claude", "--resume", SESSION_ID]);

    const forced = run(["resume", SESSION_ID, "--harness", "pi", "--dry-run", "--json"]);
    expect(envelope(forced).data?.["command"]).toEqual(["pi", "--session", SESSION_ID]);
  });

  test("resume misses are domain errors, not launches", () => {
    const human = run(["resume", SESSION_ID]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("is not in the claude, codex, or pi session stores");

    const machine = run(["resume", SESSION_ID, "--dry-run", "--json"]);
    expect(machine.code).toBe(1);
    const parsed = envelope(machine);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("session_not_found");
  });

  test("the launch narrative goes to stderr, leaving stdout usable", () => {
    const result = run(["open", "claude", "--model", "fable", "--dry-run"]);
    expect(result.code).toBe(0);
    // stdout stays a runnable shell line, so --dry-run can be piped.
    expect(result.stdout.trim()).toBe("claude --model fable");
    expect(result.stderr).toContain("Opening claude in ");
    expect(result.stderr).toContain("with model fable");
    expect(result.stderr).toContain("Dry run, so nothing is launched");
  });

  test("--json silences the narrative so the envelope stands alone", () => {
    const result = run(["open", "claude", "--dry-run", "--json", "--x-verbose"]);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  test("--x-verbose adds mechanism, default keeps it out", () => {
    const quiet = run(["open", "claude", "--dry-run"]);
    expect(quiet.stderr).not.toContain("No config at");
    const loud = run(["open", "claude", "--dry-run", "--x-verbose"]);
    expect(loud.stderr).toContain("No config at");
    expect(loud.stderr).toContain("Balancing is off on this machine");
  });

  test("the narrative names the yolo and utility decisions", () => {
    const yolo = run(["open", "pi", "--yolo", "--dry-run"]);
    expect(yolo.stderr).toContain("Yolo is on, so pi runs with --approve.");
    const utility = run(["open", "codex", "--yolo", "--dry-run", "--", "login"]);
    expect(utility.stderr).toContain("utility invocation");
    expect(utility.stderr).not.toContain("Yolo is on, so codex runs");
  });

  test("resume narrates which store owned the session", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-narr-"));
    roots.push(root);
    const projects = join(root, "claude", "projects", "-somewhere");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${SESSION_ID}.jsonl`), "{}\n");
    const result = run(["resume", SESSION_ID, "--dry-run"], {
      CLAUDE_CONFIG_DIR: join(root, "claude"),
    });
    expect(result.stderr).toContain(`Resuming session ${SESSION_ID}, which belongs to claude`);
  });

  test("doctor --json reports all three stores", () => {
    const result = run(["doctor", "--json"]);
    expect(result.code).toBe(0);
    const parsed = envelope(result);
    const harnesses = parsed.data?.["harnesses"] as Array<{ harness: string }>;
    expect(harnesses.map((report) => report.harness)).toEqual(["claude", "codex", "pi"]);
  });
});
