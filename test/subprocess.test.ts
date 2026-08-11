import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/errors.ts";
import { spawnBounded, whichInEnv } from "../src/subprocess.ts";

describe("spawnBounded", () => {
  test("returns the child's code, stdout, and stderr on ordinary exit", async () => {
    const result = await spawnBounded({
      cmd: ["bash", "-c", "echo out; echo err >&2; exit 3"],
      env: process.env,
      timeoutMs: 5000,
      label: "test echo",
    });
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
  });

  test("a child still running past the deadline is killed and reported as a timeout", async () => {
    await expect(
      spawnBounded({
        cmd: ["bash", "-c", "sleep 5"],
        env: process.env,
        timeoutMs: 50,
        label: "test sleep",
      }),
    ).rejects.toThrow(CliError);
    try {
      await spawnBounded({
        cmd: ["bash", "-c", "sleep 5"],
        env: process.env,
        timeoutMs: 50,
        label: "test sleep",
      });
      throw new Error("expected spawnBounded to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("subprocess_timeout");
      expect((error as CliError).message).toContain("test sleep");
    }
  });

  test("stderr is capped rather than growing without bound", async () => {
    const result = await spawnBounded({
      cmd: ["bash", "-c", "head -c 100000 /dev/zero | tr '\\0' 'x' >&2"],
      env: process.env,
      timeoutMs: 5000,
      label: "test large stderr",
    });
    expect(result.stderr.length).toBeLessThanOrEqual(4000);
  });
});

describe("whichInEnv", () => {
  test("resolves against the supplied env's PATH, not the parent process's", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentsurface-which-"));
    const bin = join(dir, "only-in-this-env");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(whichInEnv("only-in-this-env", { PATH: dir })).toBe(bin);
    // Not on the real parent PATH, so a bare Bun.which would miss it — the
    // point of the helper is that the child sees this env, not ours.
    expect(Bun.which("only-in-this-env")).toBeNull();
  });

  test("an env whose PATH omits the binary reports it missing, even if the parent PATH has it", () => {
    expect(whichInEnv("bash", { PATH: "/nonexistent-agentsurface-test-dir" })).toBeNull();
  });

  test("an env with no PATH key falls back to the parent process's PATH", () => {
    expect(whichInEnv("bash", {})).toBe(Bun.which("bash"));
  });
});
