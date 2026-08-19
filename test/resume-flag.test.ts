import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Black-box coverage of --x-resume, x-resume's flag spelling on the launch
// route: the path a herdr pane reaches through the fleet shim, which can
// only append arguments to the bare kind command.

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlaunch-resume-flag-"));
  roots.push(root);
  return root;
}

const SESSION_ID = "05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60";

function seedClaudeStore(root: string): { configDir: string; cwd: string } {
  const configDir = join(root, "claude-config");
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const sessions = join(configDir, "projects", "-project");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${SESSION_ID}.jsonl`), `${JSON.stringify({ cwd })}\n`);
  return { configDir, cwd };
}

function run(root: string, configDir: string, args: string[]) {
  return Bun.spawnSync([process.execPath, "src/main.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: join(root, "home"),
      CLAUDE_CONFIG_DIR: configDir,
    },
  });
}

describe("--x-resume on the launch route", () => {
  test("resolves the same resume as the x-resume command", () => {
    const root = scratch();
    const { configDir, cwd } = seedClaudeStore(root);
    const result = run(root, configDir, [
      "--x-harness",
      "claude",
      "--x-resume",
      SESSION_ID,
      "--x-dry-run",
      "--x-json",
      "--x-no-balance",
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.toString());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.session_id).toBe(SESSION_ID);
    expect(envelope.data.cwd).toBe(cwd);
    expect(envelope.data.command.slice(0, 3)).toEqual(["claude", "--resume", SESSION_ID]);
  });

  test("refuses a prompt file: a resumed session has no launch intent", () => {
    const root = scratch();
    const { configDir } = seedClaudeStore(root);
    const result = run(root, configDir, [
      "--x-harness",
      "claude",
      "--x-resume",
      SESSION_ID,
      "--x-prompt-file",
      join(root, "prompt.txt"),
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("no launch intent");
  });

  test("refuses a level, in resume's own terms", () => {
    const root = scratch();
    const { configDir } = seedClaudeStore(root);
    const result = run(root, configDir, [
      "--x-harness",
      "claude",
      "--x-resume",
      SESSION_ID,
      "--x-level",
      "fable:max",
      "--x-dry-run",
      "--x-json",
    ]);
    expect(result.exitCode).not.toBe(0);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output).toContain("takes no level");
  });
});
