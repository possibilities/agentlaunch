import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchSpec } from "../src/harness.ts";
import {
  codexAppServerCommand,
  codexAppServerEnvironment,
  codexRemoteCommand,
} from "../src/launch.ts";

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
  test("replaces an unbalanced native launch with a disabled-compatibility App Server", () => {
    const spec: LaunchSpec = {
      harness: "codex",
      command: ["codex", "--model", "gpt-x"],
      sessionId: null,
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
      'skills.config=[{"path":"/capabilities/build/SKILL.md","enabled":true}]',
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
