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
      codexCompatibilitySkillNames: [],
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

  test("name-disables compatibility aliases only on the managed App Server", () => {
    const spec: LaunchSpec = {
      harness: "codex",
      command: ["codex", "--model", "gpt-x"],
      sessionId: null,
      transport: "codex-remote",
    };
    const server = codexAppServerCommand(
      spec,
      "unix:///tmp/c.sock",
      [{ name: "build", path: "/capabilities/build" }],
      ["agent:build", "agent:collab"],
    );
    const world = codexPath();
    const client = codexRemoteCommand(spec, "unix:///tmp/c.sock", "", { PATH: world.bin });

    // The policy has to follow the subcommand: codex drops every global `-c`
    // as soon as the subcommand carries one of its own, and codex-swap appends
    // the runtime proxy's `-c` flags after everything we pass.
    expect(server).toEqual([
      "codex",
      "app-server",
      "--listen",
      "unix:///tmp/c.sock",
      "-c",
      'skills.config=[{name="agent:build",enabled=false},{name="agent:collab",enabled=false},{path="/capabilities/build/SKILL.md",enabled=true}]',
    ]);
    expect(client.join(" ")).not.toContain("skills.config");
    expect(client.join(" ")).not.toContain("agent:build");
  });

  test("retains a balanced account pin but turns resume into a server run", () => {
    const spec: LaunchSpec = {
      harness: "codex",
      command: ["codex-swap", "resume", "thread-1", "--claim", "lease-1", "--", "--search"],
      sessionId: "thread-1",
      transport: "codex-remote",
    };
    expect(codexAppServerCommand(spec, "unix:///tmp/c.sock", [], [])).toEqual([
      "codex-swap",
      "run",
      "--claim",
      "lease-1",
      "--",
      "app-server",
      "--listen",
      "unix:///tmp/c.sock",
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

  test("every emitted -c follows the subcommand that codex parses it against", () => {
    // Codex keeps the `-c` flags before a subcommand and the ones after it in
    // two separate sets, and a subcommand carrying any of its own drops all the
    // global ones. codex-swap appends the runtime proxy's `-c` flags after our
    // arguments, so a policy in front of `app-server` is silently discarded and
    // the compatibility aliases come back — 29 duplicate skills per session.
    const world = codexPath();
    const skills = [{ name: "build", path: "/capabilities/build" }];
    const aliases = ["agent:build"];
    for (const spec of [
      {
        harness: "codex",
        command: ["codex"],
        sessionId: null,
        transport: "codex-remote",
      } satisfies LaunchSpec,
      {
        harness: "codex",
        command: ["codex-swap", "run", "--claim", "lease-1", "--"],
        sessionId: null,
        transport: "codex-remote",
      } satisfies LaunchSpec,
      {
        harness: "codex",
        command: ["codex-swap", "resume", "thread-1", "--claim", "lease-1", "--"],
        sessionId: "thread-1",
        transport: "codex-remote",
      } satisfies LaunchSpec,
    ]) {
      const server = codexAppServerCommand(spec, "unix:///tmp/c.sock", skills, aliases);
      expect(server.indexOf("app-server")).toBeGreaterThan(-1);
      expect(server.indexOf("-c")).toBeGreaterThan(server.indexOf("app-server"));

      const client = codexRemoteCommand(spec, "unix:///tmp/c.sock", "guidance", {
        PATH: world.bin,
      });
      const resume = client.indexOf("resume");
      if (resume > -1) expect(client.indexOf("-c")).toBeGreaterThan(resume);
    }
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
    // `resume` precedes the client's own `-c` flags: a subcommand that carries
    // any `-c` discards the global ones, which would strand the no-auth
    // placeholder provider and the rendered guidance.
    expect(command).toEqual([
      join(world.bin, "codex"),
      "--remote",
      "unix:///tmp/c.sock",
      "resume",
      "thread-1",
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
