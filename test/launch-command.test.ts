import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, launchCommand } from "../src/commands.ts";
import { CliError, UsageError } from "../src/errors.ts";
import { HARNESS_NAMES } from "../src/harness.ts";
import { createNarrator } from "../src/narrate.ts";
import { partition, type XSpec } from "../src/partition.ts";
import type { Environ } from "../src/paths.ts";
import { ROLE_RESOURCES_MARKER, ROLE_RESOURCES_VERSION } from "../src/role-resources.ts";
import { seedFleetResources } from "./resource-fixture.ts";

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

function contextFor(root: string, env: Environ = {}): Context {
  const home = join(root, "home");
  seedFleetResources(home);
  return { env, home, cwd: home, narrator: createNarrator({ silent: true, verbose: false }) };
}

// Mirrors main.ts LAUNCH_FLAGS plus the globals.
const SPEC: XSpec = {
  value: new Set(["--x-harness", "--x-level", "--x-account", "--x-prompt-file"]),
  bool: new Set(["--x-json", "--x-help", "--x-dry-run", "--x-no-balance", "--x-verbose"]),
  repeatable: new Set(),
  scoped: new Map<string, readonly string[]>([
    ["--x-yolo", HARNESS_NAMES],
    ["--x-no-yolo", HARNESS_NAMES],
  ]),
};

async function dryRunData(
  root: string,
  argv: string[],
  env: Environ = {},
): Promise<{ command: string[]; resources: { root: string } | null }> {
  const outcome = await launchCommand(
    contextFor(root, env),
    partition([...argv, "--x-dry-run", "--x-no-balance"], SPEC),
  );
  if (outcome.kind !== "result") throw new Error("expected a result outcome");
  return outcome.data as { command: string[]; resources: { root: string } | null };
}

async function dryRun(root: string, argv: string[], env: Environ = {}): Promise<string[]> {
  return (await dryRunData(root, argv, env)).command;
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

describe("explicit AgentRoles resources", () => {
  function roleEnv(root: string, name = "worker"): Environ {
    const role = join(root, "roles", name);
    mkdirSync(role, { recursive: true });
    return {
      [ROLE_RESOURCES_MARKER]: ROLE_RESOURCES_VERSION,
      AGENTROLES_ROLE: role,
      AGENTROLES_NAME: name,
    };
  }

  test("Claude keeps only its complete role layer", async () => {
    const root = scratch();
    const env = roleEnv(root);
    const role = env["AGENTROLES_ROLE"]!;
    const command = await dryRun(
      root,
      [
        "--x-harness",
        "claude",
        "--mcp-config",
        join(role, "mcp.json"),
        "--plugin-dir",
        join(root, "role-plugin"),
        "hello",
      ],
      env,
    );
    expect(command).toContain(join(role, "mcp.json"));
    expect(command).toContain(join(root, "role-plugin"));
    expect(command).not.toContain(
      join(root, "home", ".local", "share", "agentstart", "resources", "claude", "agent"),
    );
    expect(env[ROLE_RESOURCES_MARKER]).toBeUndefined();
  });

  test("Codex worker keeps role MCP and skill controls without global overlays", async () => {
    const root = scratch();
    const env = roleEnv(root);
    const role = env["AGENTROLES_ROLE"]!;
    const roleMcp = 'mcp_servers.agentchats={command="agentchats",args=["mcp"]}';
    const roleSkill = "plugins.worker@agentroles.enabled=true";
    const data = await dryRunData(
      root,
      ["--x-harness", "codex", "-c", roleMcp, "-c", roleSkill, "hello"],
      env,
    );
    expect(data.command).toContain(roleMcp);
    expect(data.command).toContain(roleSkill);
    expect(data.command.some((token) => token.startsWith("skills.config="))).toBe(false);
    expect(data.command.some((token) => token.startsWith("mcp_servers.shadcn="))).toBe(false);
    expect(data.command.some((token) => token.startsWith("mcp_servers.agenthud="))).toBe(false);
    expect(data.resources).toEqual({ root: role });
    expect(env[ROLE_RESOURCES_MARKER]).toBeUndefined();
  });

  test("an absent marker keeps default fleet resources", async () => {
    const root = scratch();
    const command = await dryRun(root, ["--x-harness", "codex", "hello"], {
      AGENTROLES_ROLE: join(root, "roles", "old"),
      AGENTROLES_NAME: "old",
    });
    expect(command.some((token) => token.startsWith("skills.config="))).toBe(true);
    expect(command.some((token) => token.startsWith("mcp_servers.shadcn="))).toBe(true);
  });

  test.each(["claude", "codex"])("%s ordinary launch retains the fleet layer", async (harness) => {
    const root = scratch();
    const data = await dryRunData(root, ["--x-harness", harness, "hello"]);
    expect(data.resources?.root).toBe(
      join(root, "home", ".local", "share", "agentstart", "resources"),
    );
    if (harness === "claude") expect(data.command).toContain("--plugin-dir");
    else expect(data.command.some((token) => token.startsWith("mcp_servers.shadcn="))).toBe(true);
  });

  test.each([
    ["codex", "app-server"],
    ["claude", "doctor"],
  ])("%s %s remains a utility with no injected resource layer", async (harness, command) => {
    const root = scratch();
    for (const env of [{}, roleEnv(root)]) {
      const data = await dryRunData(root, ["--x-harness", harness, command], env);
      expect(data.command).toEqual([harness, command]);
      expect(data.resources).toBeNull();
      expect(env[ROLE_RESOURCES_MARKER]).toBeUndefined();
    }
  });

  test("a role launch does not require the fleet resource files", async () => {
    const root = scratch();
    const env = roleEnv(root);
    const context = contextFor(root, env);
    rmSync(join(context.home, ".local"), { recursive: true });
    const outcome = await launchCommand(
      context,
      partition(["--x-harness", "codex", "--x-dry-run", "--x-no-balance", "hello"], SPEC),
    );
    expect(outcome.kind).toBe("result");
  });

  test("malformed or orphaned markers fail before any global fallback", async () => {
    const root = scratch();
    const role = join(root, "roles", "worker");
    mkdirSync(role, { recursive: true });
    const file = join(root, "file");
    writeFileSync(file, "not a directory");
    const invalid: Environ[] = [
      {
        [ROLE_RESOURCES_MARKER]: ROLE_RESOURCES_VERSION,
        AGENTROLES_ROLE: file,
        AGENTROLES_NAME: "file",
      },
      {
        [ROLE_RESOURCES_MARKER]: ROLE_RESOURCES_VERSION,
        AGENTROLES_ROLE: join(root, "missing"),
        AGENTROLES_NAME: "missing",
      },
      { [ROLE_RESOURCES_MARKER]: "" },
      { [ROLE_RESOURCES_MARKER]: "future", AGENTROLES_ROLE: role, AGENTROLES_NAME: "worker" },
      { [ROLE_RESOURCES_MARKER]: ROLE_RESOURCES_VERSION },
      {
        [ROLE_RESOURCES_MARKER]: ROLE_RESOURCES_VERSION,
        AGENTROLES_ROLE: "relative/worker",
        AGENTROLES_NAME: "worker",
      },
      {
        [ROLE_RESOURCES_MARKER]: ROLE_RESOURCES_VERSION,
        AGENTROLES_ROLE: role,
        AGENTROLES_NAME: "manager",
      },
    ];
    for (const env of invalid) {
      const error = await dryRun(root, ["--x-harness", "codex", "hello"], env).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("role_resources_invalid");
    }
  });
});
