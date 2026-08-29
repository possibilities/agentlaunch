import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchSpec } from "../src/harness.ts";
import { launch } from "../src/launch.ts";
import { createNarrator } from "../src/narrate.ts";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("native Codex launch", () => {
  test("executes codex-swap directly with no App Server or remote TUI", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlaunch-codex-native-"));
    roots.push(root);
    const bin = join(root, "bin");
    const record = join(root, "argv");
    mkdirSync(bin);
    const swap = join(bin, "codex-swap");
    writeFileSync(swap, '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENTLAUNCH_TEST_RECORD"\n');
    chmodSync(swap, 0o755);
    const spec: LaunchSpec = {
      harness: "codex",
      command: ["codex-swap", "resume", "thread-1", "--claim", "lease-1", "--", "--search"],
      sessionId: "thread-1",
    };
    const code = await launch(spec, createNarrator({ silent: true, verbose: false }), {
      PATH: bin,
      AGENTLAUNCH_TEST_RECORD: record,
    });
    expect(code).toBe(0);
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual([
      "resume",
      "thread-1",
      "--claim",
      "lease-1",
      "--",
      "--search",
    ]);
  });
});
