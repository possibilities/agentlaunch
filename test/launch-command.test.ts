import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, launchCommand } from "../src/commands.ts";
import { CliError, UsageError } from "../src/errors.ts";
import { HARNESS_NAMES } from "../src/harness.ts";
import { createNarrator } from "../src/narrate.ts";
import { partition, type XSpec } from "../src/partition.ts";
import type { Environ } from "../src/paths.ts";
import { seedCommonCapability } from "./capability-fixture.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlaunch-launch-command-"));
  roots.push(root);
  return root;
}

function contextFor(root: string): Context {
  const env: Environ = {};
  const home = join(root, "home");
  seedCommonCapability(home);
  return { env, home, cwd: home, narrator: createNarrator({ silent: true, verbose: false }) };
}

// Mirrors main.ts LAUNCH_FLAGS plus the globals.
const SPEC: XSpec = {
  value: new Set(["--x-harness", "--x-level", "--x-account", "--x-prompt-file"]),
  bool: new Set(["--x-json", "--x-help", "--x-dry-run", "--x-no-balance", "--x-verbose"]),
  repeatable: new Set(["--x-capability"]),
  scoped: new Map<string, readonly string[]>([
    ["--x-yolo", HARNESS_NAMES],
    ["--x-no-yolo", HARNESS_NAMES],
  ]),
};

async function dryRun(root: string, argv: string[]): Promise<string[]> {
  const outcome = await launchCommand(
    contextFor(root),
    partition([...argv, "--x-dry-run", "--x-no-balance"], SPEC),
  );
  if (outcome.kind !== "result") throw new Error("expected a result outcome");
  return (outcome.data as { command: string[] }).command;
}

describe("launchCommand --x-prompt-file", () => {
  test("appends the file's exact text as the final native token", async () => {
    const root = scratch();
    const text = "Survey the fleet skills.\n\nThen 'quotes', a\ttab, and $dollars.";
    const file = join(root, "prompt.txt");
    writeFileSync(file, text);
    const command = await dryRun(root, ["--x-harness", "claude", "--x-prompt-file", file]);
    expect(command[0]).toBe("claude");
    expect(command[command.length - 1]).toBe(text);
  });

  test("prompt text is never scanned as a forwarded dimension", async () => {
    const root = scratch();
    const file = join(root, "prompt.txt");
    writeFileSync(file, "--model sneaky text that only reads like a flag");
    const command = await dryRun(root, ["--x-level", "fable:xhigh", "--x-prompt-file", file]);
    // An inline "--model" beside --x-level is a usage fault; via the file it
    // is prompt text, appended after the level's own injection.
    expect(command).toContain("fable");
    expect(command[command.length - 1]).toBe("--model sneaky text that only reads like a flag");
  });

  test("a utility invocation takes no prompt", async () => {
    const root = scratch();
    const file = join(root, "prompt.txt");
    writeFileSync(file, "hello");
    const thrown = await dryRun(root, [
      "--x-harness",
      "claude",
      "doctor",
      "--x-prompt-file",
      file,
    ]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(UsageError);
  });

  test("an unreadable file is a domain failure", async () => {
    const root = scratch();
    const missing = join(root, "gone.txt");
    const thrown = await dryRun(root, ["--x-harness", "claude", "--x-prompt-file", missing]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).code).toBe("prompt_file_unreadable");
  });

  test("an empty file is a domain failure", async () => {
    const root = scratch();
    const file = join(root, "empty.txt");
    writeFileSync(file, "");
    const thrown = await dryRun(root, ["--x-harness", "claude", "--x-prompt-file", file]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).code).toBe("prompt_file_empty");
  });

  test("a launch without the flag is unchanged", async () => {
    const root = scratch();
    const command = await dryRun(root, ["--x-harness", "claude", "plain prompt"]);
    expect(command[command.length - 1]).toBe("plain prompt");
  });
});
