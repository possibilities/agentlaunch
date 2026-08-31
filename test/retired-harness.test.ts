import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function run(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "agentlaunch-retired-harness-"));
  roots.push(root);
  return Bun.spawnSync([process.execPath, MAIN, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: join(root, "home"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      AGENTLAUNCH_NO_BALANCE: "1",
    },
  });
}

describe("retired harness CLI grammar", () => {
  test("spaced and inline retired yolo scopes are usage faults", () => {
    for (const flag of ["--x-yolo", "--x-no-yolo"]) {
      for (const args of [[flag, "pi"], [`${flag}=pi`]]) {
        const result = run(["--x-harness", "codex", ...args, "--x-dry-run"]);
        expect(result.exitCode).toBe(2);
        expect(result.stdout.toString()).toBe("");
        expect(result.stderr.toString()).toContain(`"${flag}" scope "pi" names a retired harness`);
      }
    }
  });

  test("a retired union harness has valid recovery", () => {
    const result = run(["--x-harness", "pi:gpt-5.6-sol:high", "--x-dry-run"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain('harness "pi" is retired; choose claude or codex');
    expect(result.stderr.toString()).not.toContain("--x-harness pi --x-level");
  });
});
