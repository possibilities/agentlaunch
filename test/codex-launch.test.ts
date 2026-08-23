import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilitySet } from "../src/capabilities.ts";
import type { LaunchSpec } from "../src/harness.ts";
import {
  codexAppServerCommand,
  codexAppServerEnvironment,
  codexRemoteCommand,
  launch,
} from "../src/launch.ts";
import { createNarrator } from "../src/narrate.ts";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function codexPath(): { root: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "agentlaunch-codex-launch-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n");
  chmodSync(codex, 0o755);
  return { root, bin };
}

describe("Codex App Server supervision", () => {
  test("a capability-bearing Codex exec bypasses the remote App Server", async () => {
    const world = codexPath();
    const record = join(world.root, "argv");
    const swap = join(world.bin, "codex-swap");
    writeFileSync(swap, '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENTLAUNCH_TEST_RECORD"\n');
    chmodSync(swap, 0o755);
    const capabilities: CapabilitySet = {
      ids: ["common"],
      digest: "test-digest",
      root: join(world.root, "projection"),
      claudePluginDir: null,
      skillRoots: [],
      skills: [],
      guidance: "",
      guidanceFile: null,
      piExtensions: [],
      piPromptTemplates: [],
      receiptRequired: false,
    };
    const spec: LaunchSpec = {
      harness: "codex",
      command: ["codex-swap", "run", "--claim", "lease-1", "--", "exec", "hello"],
      sessionId: null,
      transport: "native",
    };
    const code = await launch(
      spec,
      createNarrator({ silent: true, verbose: false }),
      { PATH: world.bin, AGENTLAUNCH_TEST_RECORD: record },
      null,
      world.root,
      capabilities,
    );
    expect(code).toBe(0);
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual([
      "run",
      "--claim",
      "lease-1",
      "--",
      "exec",
      "hello",
    ]);
  });

  test("replaces an unbalanced native launch with a disabled-compatibility App Server", () => {
    const spec: LaunchSpec = {
      harness: "codex",
      command: ["codex", "--model", "gpt-x"],
      sessionId: null,
      transport: "codex-remote",
    };
    expect(
      codexAppServerCommand(spec, "unix:///tmp/c.sock", [
        { name: "build", path: "/capabilities/build" },
      ]),
    ).toEqual([
      "codex",
      "-c",
      'plugins."agent@agentstart-managed".enabled=false',
      "-c",
      'skills.config=[{path="/capabilities/build/SKILL.md",enabled=true}]',
      "app-server",
      "--listen",
      "unix:///tmp/c.sock",
    ]);
  });

  test("retains a balanced account pin but turns resume into a server run", () => {
    const spec: LaunchSpec = {
      harness: "codex",
      command: ["codex-swap", "resume", "thread-1", "--claim", "lease-1", "--", "--search"],
      sessionId: "thread-1",
      transport: "codex-remote",
    };
    expect(codexAppServerCommand(spec, "unix:///tmp/c.sock", []).slice(0, 6)).toEqual([
      "codex-swap",
      "run",
      "--claim",
      "lease-1",
      "--",
      "-c",
    ]);
  });

  test("a stale sidecar environment cannot disable account pinning", () => {
    expect(
      codexAppServerEnvironment({
        PATH: "/bin",
        CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
        CODEX_MULTI_AUTH_BYPASS: "1",
      }),
    ).toEqual({ PATH: "/bin" });
  });

  test("the native remote TUI carries resume tokens and merged guidance", () => {
    const world = codexPath();
    const spec: LaunchSpec = {
      harness: "codex",
      command: ["codex-swap", "resume", "thread-1", "--account", "work", "--", "--search"],
      sessionId: "thread-1",
      transport: "codex-remote",
    };
    const command = codexRemoteCommand(spec, "unix:///tmp/c.sock", "line one\nline two", {
      PATH: world.bin,
    });
    expect(command).toEqual([
      join(world.bin, "codex"),
      "--remote",
      "unix:///tmp/c.sock",
      "-c",
      'model_provider="agentlaunch-remote"',
      "-c",
      'model_providers.agentlaunch-remote.name="AgentLaunch remote"',
      "-c",
      'model_providers.agentlaunch-remote.base_url="http://127.0.0.1"',
      "-c",
      'model_providers.agentlaunch-remote.wire_api="responses"',
      "-c",
      "model_providers.agentlaunch-remote.requires_openai_auth=false",
      "-c",
      'developer_instructions="line one\\nline two"',
      "resume",
      "thread-1",
      "--search",
    ]);
  });

  test("the native remote TUI carries a fresh initial prompt unchanged", () => {
    const world = codexPath();
    const spec: LaunchSpec = {
      harness: "codex",
      command: ["codex", "--search", "line one\nline two"],
      sessionId: null,
      transport: "codex-remote",
    };
    expect(codexRemoteCommand(spec, "unix:///tmp/c.sock", "", { PATH: world.bin })).toEqual([
      join(world.bin, "codex"),
      "--remote",
      "unix:///tmp/c.sock",
      "-c",
      'model_provider="agentlaunch-remote"',
      "-c",
      'model_providers.agentlaunch-remote.name="AgentLaunch remote"',
      "-c",
      'model_providers.agentlaunch-remote.base_url="http://127.0.0.1"',
      "-c",
      'model_providers.agentlaunch-remote.wire_api="responses"',
      "-c",
      "model_providers.agentlaunch-remote.requires_openai_auth=false",
      "--search",
      "line one\nline two",
    ]);
  });
});
