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

  test("help lands on stdout; launches naming neither flag are usage faults", () => {
    expect(run([]).stdout).toContain("agentsurface — one launcher");
    expect(run(["--agent-teaser"]).stdout).toContain("Launch agent harnesses");
    expect(run(["--agent-help"]).stdout).toContain("agent runbook");
    expect(run(["--x-help"]).stdout).toContain("Launch a harness in this terminal");
    const missing = run(["land"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("a launch names what it runs");
  });

  test("the retired grammar is refused loudly, never misread", () => {
    const positional = run(["claude", "--x-dry-run"]);
    expect(positional.code).toBe(2);
    expect(positional.stderr).toContain("pass --x-harness claude");
    expect(run(["open", "claude"]).stderr).toContain("--x-harness");
    expect(run(["resume", SESSION_ID]).stderr).toContain("resume is now x-resume");
    expect(run(["doctor"]).stderr).toContain("doctor is now x-doctor");
  });

  test("a launch resolves the harness value and injects the catalog defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-cwd-"));
    roots.push(root);
    const result = run(
      ["--x-harness", "claude", "fix the tests", "--x-dry-run", "--x-json", "--x-no-yolo"],
      {},
      root,
    );
    expect(result.code).toBe(0);
    const parsed = envelope(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({
      harness: "claude",
      name: null,
      session_id: null,
      cwd: realpathSync(root),
      command: ["claude", "--model", "opus[1m]", "--effort", "medium", "fix the tests"],
      balance: null,
      utility: false,
      yolo: false,
      redactions: [],
      model: "opus-1m",
      model_source: "default",
      effort: "medium",
      effort_source: "default",
    });
  });

  test("every harness injects its own spellings", () => {
    const codex = run(["--x-harness", "codex", "--x-dry-run", "--x-json", "--x-no-yolo"]);
    expect(envelope(codex).data?.["command"]).toEqual([
      "codex",
      "--model",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
    ]);
    const pi = run(["--x-harness", "pi", "--x-dry-run", "--x-json", "--x-no-yolo"]);
    expect(envelope(pi).data?.["command"]).toEqual([
      "pi",
      "--model",
      "openai-codex/gpt-5.6-sol",
      "--thinking",
      "high",
    ]);
  });

  test("a level requests both dimensions and picks by catalog order", () => {
    const walked = run([
      "--x-level",
      "gpt-5.6-sol:ultra",
      "--x-dry-run",
      "--x-json",
      "--x-no-yolo",
    ]);
    const data = envelope(walked).data;
    expect(data?.["harness"]).toBe("codex");
    expect(data?.["model_source"]).toBe("requested");
    expect(data?.["effort"]).toBe("ultra");
    const pinned = run([
      "--x-harness",
      "pi",
      "--x-level",
      "gpt-5.6-luna:max",
      "--x-dry-run",
      "--x-json",
      "--x-no-yolo",
    ]);
    expect(envelope(pinned).data?.["command"]).toEqual([
      "pi",
      "--model",
      "openai-codex/gpt-5.6-luna",
      "--thinking",
      "max",
    ]);
  });

  test("bad values, the retired union, and misses are usage faults", () => {
    expect(run(["--x-harness", "opus"]).code).toBe(2);
    expect(run(["--x-level", "opus"]).code).toBe(2);
    expect(run(["--x-level", "a:b:c:d"]).code).toBe(2);
    expect(run(["--x-harness", "cursor"]).code).toBe(2);
    expect(run(["--x-dry-run"]).stderr).toContain("a launch names what it runs");
    const union = run(["--x-harness", "pi:gpt-5.6-luna:max"]);
    expect(union.code).toBe(2);
    expect(union.stderr).toContain("--x-harness pi --x-level gpt-5.6-luna:max");
    const miss = run(["--x-level", "gpt-5.5:ultra"]);
    expect(miss.code).toBe(2);
    expect(miss.stderr).toContain('no harness offers model "gpt-5.5" at effort "ultra"');
  });

  test("a launch without a level yields per dimension to forwarded native flags", () => {
    const result = run([
      "--x-harness",
      "claude",
      "--model",
      "sonnet",
      "--x-dry-run",
      "--x-json",
      "--x-no-yolo",
    ]);
    const data = envelope(result).data;
    expect(data?.["command"]).toEqual(["claude", "--effort", "medium", "--model", "sonnet"]);
    expect(data?.["model"]).toBe("sonnet");
    expect(data?.["model_source"]).toBe("forwarded");
    expect(data?.["effort_source"]).toBe("default");
  });

  test("a level faults on a forwarded model or effort counterpart", () => {
    const model = run([
      "--x-harness",
      "claude",
      "--x-level",
      "opus:high",
      "--model",
      "sonnet",
      "--x-dry-run",
    ]);
    expect(model.code).toBe(2);
    expect(model.stderr).toContain("set the model");
    const effort = run(["--x-level", "opus:high", "--effort", "low", "--x-dry-run"]);
    expect(effort.code).toBe(2);
    expect(effort.stderr).toContain("set the effort");
    const codex = run([
      "--x-harness",
      "codex",
      "--x-level",
      "gpt-5.5:high",
      "-c",
      'model_reasoning_effort="low"',
      "--x-dry-run",
    ]);
    expect(codex.code).toBe(2);
  });

  test("utility invocations get no injection, and a level refuses them", () => {
    const utility = run(["--x-harness", "codex", "--x-dry-run", "--x-json", "login"]);
    const parsed = envelope(utility);
    expect(parsed.data?.["command"]).toEqual(["codex", "login"]);
    expect(parsed.data?.["utility"]).toBe(true);
    expect(parsed.data?.["model"]).toBeNull();
    const level = run([
      "--x-harness",
      "codex",
      "--x-level",
      "gpt-5.5:high",
      "login",
      "--x-dry-run",
    ]);
    expect(level.code).toBe(2);
    expect(level.stderr).toContain("utility invocation");
  });

  test("yolo is on by default and rides after the injected dimensions", () => {
    const result = run(["--x-harness", "claude", "--x-dry-run", "--x-json"]);
    expect(envelope(result).data?.["command"]).toEqual([
      "claude",
      "--dangerously-skip-permissions",
      "--model",
      "opus[1m]",
      "--effort",
      "medium",
    ]);
  });

  test("--x-no-yolo redacts an explicitly forwarded yolo flag and narrates it", () => {
    const result = run([
      "--x-harness",
      "claude",
      "--dangerously-skip-permissions",
      "--x-no-yolo",
      "--x-dry-run",
      "--x-json",
    ]);
    const parsed = envelope(result);
    expect(parsed.data?.["redactions"]).toEqual(["--dangerously-skip-permissions"]);
    const narrated = run(["--x-harness", "pi", "-a", "--x-no-yolo", "--x-dry-run"]);
    expect(narrated.stderr).toContain("yolo      off · removed -a · explicitly forwarded");
  });

  test("bare x-* words in command position are reserved", () => {
    const result = run(["x-something"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown x command "x-something"');
  });

  test("a malformed config or catalog fails the launch and x-doctor reports both", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-badfiles-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "agentsurface"), { recursive: true });
    writeFileSync(join(home, ".config", "agentsurface", "catalog.json"), "not json");
    const launch = run(["--x-harness", "claude", "--x-dry-run", "--x-json"], { HOME: home });
    expect(launch.code).toBe(1);
    expect(envelope(launch).error?.code).toBe("catalog_invalid");
    const doctor = run(["x-doctor", "--x-json"], { HOME: home });
    expect(doctor.code).toBe(0);
    const catalog = envelope(doctor).data?.["catalog"] as { valid: boolean; source: string };
    expect(catalog.valid).toBe(false);
    expect(catalog.source).toBe("custom");
  });

  test("x-doctor reports the catalog's order, models, and resolved defaults", () => {
    const result = run(["x-doctor", "--x-json"]);
    expect(result.code).toBe(0);
    const catalog = envelope(result).data?.["catalog"] as {
      source: string;
      valid: boolean;
      harnesses: Array<{ harness: string; models: number; defaults: { model: string } }>;
    };
    expect(catalog.source).toBe("built-in");
    expect(catalog.valid).toBe(true);
    expect(catalog.harnesses.map((entry) => entry.harness)).toEqual(["claude", "codex", "pi"]);
    expect(catalog.harnesses[0]?.defaults.model).toBe("opus-1m");
    expect(run(["x-doctor", "stray"]).code).toBe(2);
  });

  test("x-resume detects the owning store and takes no injection", () => {
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

  test("x-resume misses are domain errors, not launches", () => {
    const machine = run(["x-resume", SESSION_ID, "--x-dry-run", "--x-json"]);
    expect(machine.code).toBe(1);
    const parsed = envelope(machine);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("session_not_found");
  });

  test("the launch narrative goes to stderr as aligned rows, leaving stdout usable", () => {
    const result = run(["--x-harness", "claude", "--x-dry-run", "--x-no-yolo"]);
    expect(result.code).toBe(0);
    // stdout stays a runnable shell line, so --x-dry-run can be piped.
    expect(result.stdout.trim()).toBe("claude --model 'opus[1m]' --effort medium");
    const rows = result.stderr.trimEnd().split("\n");
    expect(rows[0]).toBe("open      claude");
    expect(rows[1]).toMatch(/^cwd {7}\S/);
    expect(rows).toContain("model     opus-1m · default");
    expect(rows).toContain("effort    medium · default");
    expect(rows).toContain("yolo      off · permission prompts stay on");
    expect(rows).toContain("account   skipped · balancing off (AGENTSURFACE_NO_BALANCE)");
    expect(rows).toContain("dry run   nothing launched · command on stdout");
    for (const row of rows) expect(row.slice(0, 8)).toMatch(/^\S.{0,6} +$|^\S{8}$/);
  });

  test("--x-json silences the narrative so the envelope stands alone", () => {
    const result = run(["--x-harness", "claude", "--x-dry-run", "--x-json", "--x-verbose"]);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  test("--x-verbose adds mechanism rows, default keeps them out", () => {
    const quiet = run(["--x-harness", "claude", "--x-dry-run"]);
    expect(quiet.stderr).not.toContain("config ");
    const loud = run(["--x-harness", "claude", "--x-dry-run", "--x-verbose"]);
    expect(loud.stderr).toContain("config  ");
    expect(loud.stderr).toContain("missing · yolo on everywhere");
  });
});

describe("run names", () => {
  test("a name is injected in the harness's own spelling", () => {
    const result = run([
      "--x-harness",
      "claude",
      "--x-name",
      "fix the auth flow",
      "--x-dry-run",
      "--x-json",
      "--x-no-yolo",
    ]);
    expect(result.code).toBe(0);
    const data = envelope(result).data as Record<string, unknown>;
    expect(data["name"]).toBe("fix the auth flow");
    expect(data["command"]).toEqual([
      "claude",
      "--model",
      "opus[1m]",
      "--effort",
      "medium",
      "--name",
      "fix the auth flow",
    ]);
  });

  test("codex has no launch-time name, so a runner launch says so and drops it", () => {
    const result = run([
      "--x-harness",
      "codex",
      "--x-name",
      "fix the auth flow",
      "--x-dry-run",
      "--x-no-yolo",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("--name");
    expect(result.stderr).toContain("codex has no launch-time name");
  });

  test("--x-name owns the dimension: a forwarded spelling is a usage fault", () => {
    for (const forwarded of [["--name", "theirs"], ["-n", "theirs"], ["--name=theirs"]]) {
      const result = run([
        "--x-harness",
        "claude",
        "--x-name",
        "ours",
        ...forwarded,
        "--x-dry-run",
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--x-name set the run name");
    }
  });

  test("an empty name and a utility invocation are usage faults", () => {
    expect(run(["--x-harness", "claude", "--x-name", "", "--x-dry-run"]).code).toBe(2);
    const utility = run(["--x-harness", "codex", "--x-name", "x", "login", "--x-dry-run"]);
    expect(utility.code).toBe(2);
    expect(utility.stderr).toContain("opens no session to name");
  });
});
