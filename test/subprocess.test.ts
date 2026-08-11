import { describe, expect, test } from "bun:test";
import { CliError } from "../src/errors.ts";
import { spawnBounded } from "../src/subprocess.ts";

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
