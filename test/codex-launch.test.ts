import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchSpec } from "../src/harness.ts";
import { launch } from "../src/launch.ts";
import { createNarrator } from "../src/narrate.ts";
import { ROLE_RESOURCES_MARKER, ROLE_RESOURCES_VERSION } from "../src/role-resources.ts";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("native Codex launch", () => {
  test("executes codex directly with no App Server or remote TUI", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlaunch-codex-native-"));
    roots.push(root);
    const bin = join(root, "bin");
    const record = join(root, "argv");
    mkdirSync(bin);
    const binary = join(bin, "codex");
    writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENTLAUNCH_TEST_RECORD"\n');
    chmodSync(binary, 0o755);
    const spec: LaunchSpec = {
      harness: "codex",
      command: ["codex", "resume", "thread-1", "--search"],
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
      "--search",
    ]);
  });

  test("consumes the one-shot role marker but preserves role context", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlaunch-role-env-"));
    roots.push(root);
    const bin = join(root, "bin");
    const record = join(root, "env");
    const role = join(root, "roles", "worker");
    mkdirSync(bin, { recursive: true });
    mkdirSync(role, { recursive: true });
    const binary = join(bin, "codex");
    writeFileSync(
      binary,
      [
        "#!/bin/sh",
        'marker="$AGENTLAUNCH_ROLE_RESOURCES"',
        '[ -n "$marker" ] || marker=unset',
        'printf "%s\\n%s\\n%s\\n%s\\n" "$AGENTLAUNCH_LAUNCH" "$marker" "$AGENTROLES_ROLE" "$AGENTROLES_NAME" > "$AGENTLAUNCH_TEST_RECORD"',
        "",
      ].join("\n"),
    );
    chmodSync(binary, 0o755);
    const code = await launch(
      { harness: "codex", command: ["codex"], sessionId: null },
      createNarrator({ silent: true, verbose: false }),
      {
        PATH: bin,
        AGENTLAUNCH_TEST_RECORD: record,
        [ROLE_RESOURCES_MARKER]: ROLE_RESOURCES_VERSION,
        AGENTROLES_ROLE: role,
        AGENTROLES_NAME: "worker",
      },
    );
    expect(code).toBe(0);
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual(["1", "unset", role, "worker"]);
  });
});
