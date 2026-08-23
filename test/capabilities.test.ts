import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCapabilityArguments,
  requestedCapabilityIds,
  resolveCapabilities,
  writeCapabilityReceipt,
} from "../src/capabilities.ts";
import { CliError } from "../src/errors.ts";
import type { LaunchSpec } from "../src/harness.ts";
import type { Partitioned } from "../src/partition.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function scratch(): { root: string; home: string; capabilities: string } {
  const root = mkdtempSync(join(tmpdir(), "agentlaunch-capabilities-"));
  roots.push(root);
  return {
    root,
    home: join(root, "home"),
    capabilities: join(root, "capabilities"),
  };
}

function pack(
  capabilityRoot: string,
  id: string,
  options: { skill?: string; guidance?: string; resources?: boolean } = {},
): string {
  const root = join(capabilityRoot, "packs", id);
  mkdirSync(root, { recursive: true });
  const resources: Record<string, string> = {};
  if (options.skill !== undefined) {
    resources.skills = "skills";
    const skill = join(root, "skills", options.skill);
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), `# ${options.skill}\n`);
  }
  if (options.guidance !== undefined) {
    resources.guidance = "guidance.md";
    writeFileSync(join(root, "guidance.md"), options.guidance);
  }
  if (options.resources === true) {
    resources.claude = "claude";
    resources.pi_extensions = "pi/extensions";
    resources.pi_prompt_templates = "pi/templates";
    mkdirSync(join(root, "claude", "commands"), { recursive: true });
    writeFileSync(join(root, "claude", "commands", "hello.md"), "hello\n");
    mkdirSync(join(root, "pi", "extensions"), { recursive: true });
    writeFileSync(join(root, "pi", "extensions", "status.ts"), "export {};\n");
    mkdirSync(join(root, "pi", "templates"), { recursive: true });
    writeFileSync(join(root, "pi", "templates", "review.md"), "review\n");
  }
  writeFileSync(
    join(root, "capability.json"),
    `${JSON.stringify({
      schema_version: 1,
      id,
      default: id === "common",
      description: `${id} fixture`,
      resources,
    })}\n`,
  );
  return root;
}

function parts(capabilities: string[] = [], noCommon = false): Partitioned {
  return {
    values: {},
    lists: capabilities.length === 0 ? {} : { "x-capability": capabilities },
    bools: new Set(noCommon ? ["x-no-common"] : []),
    scoped: new Map(),
    harness: [],
  };
}

describe("capability selection and projection", () => {
  test("common defaults, explicit packs append, and --x-no-common isolates", () => {
    const world = scratch();
    expect(requestedCapabilityIds(parts(), {}, world.home, "claude", null)).toEqual(["common"]);
    expect(
      requestedCapabilityIds(parts(["focus", "common"]), {}, world.home, "claude", null),
    ).toEqual(["common", "focus"]);
    expect(requestedCapabilityIds(parts(["focus"], true), {}, world.home, "pi", null)).toEqual([
      "focus",
    ]);
  });

  test("renders one immutable projection for skills, Claude resources, Pi resources, and guidance", () => {
    const world = scratch();
    const common = pack(world.capabilities, "common", {
      skill: "collab",
      guidance: "common guidance\n",
      resources: true,
    });
    pack(world.capabilities, "focus", { skill: "focus", guidance: "focus guidance\n" });
    const env = { AGENTSTART_CAPABILITIES_ROOT: world.capabilities };
    const set = resolveCapabilities(["common", "focus"], env, world.home, true);

    expect(set.ids).toEqual(["common", "focus"]);
    expect(set.skillRoots).toEqual([join(set.root, "skills")]);
    expect(set.skills.map((skill) => skill.name)).toEqual(["collab", "focus"]);
    expect(existsSync(join(set.root, "skills", "collab", "SKILL.md"))).toBe(true);
    expect(existsSync(join(set.root, "claude", "agent", ".claude-plugin", "plugin.json"))).toBe(
      true,
    );
    expect(readFileSync(join(set.root, "claude", "agent", "commands", "hello.md"), "utf8")).toBe(
      "hello\n",
    );
    expect(readFileSync(set.piExtensions[0] as string, "utf8")).toBe("export {};\n");
    expect(readFileSync(set.piPromptTemplates[0] as string, "utf8")).toBe("review\n");
    expect(set.guidance).toContain("<!-- capability:common -->");
    expect(set.guidance).toContain("<!-- capability:focus -->");

    writeFileSync(join(common, "skills", "collab", "SKILL.md"), "# changed\n");
    expect(readFileSync(join(set.root, "skills", "collab", "SKILL.md"), "utf8")).toBe("# collab\n");
  });

  test("projects each harness through its native session surface", () => {
    const world = scratch();
    pack(world.capabilities, "common", {
      skill: "collab",
      guidance: "guide\n",
      resources: true,
    });
    const set = resolveCapabilities(
      ["common"],
      { AGENTSTART_CAPABILITIES_ROOT: world.capabilities },
      world.home,
      true,
    );
    const open = (harness: "claude" | "codex" | "pi"): LaunchSpec => ({
      harness,
      command: [harness, "prompt"],
      sessionId: null,
    });
    expect(set.claudePluginDir).not.toBeNull();
    expect(set.guidanceFile).not.toBeNull();
    expect(applyCapabilityArguments(open("claude"), set).command.slice(0, 5)).toEqual([
      "claude",
      "--plugin-dir",
      set.claudePluginDir as string,
      "--append-system-prompt-file",
      set.guidanceFile as string,
    ]);
    expect(applyCapabilityArguments(open("codex"), set)).toEqual(open("codex"));
    const pi = applyCapabilityArguments(open("pi"), set).command;
    expect(pi.slice(0, 4)).toEqual([
      "pi",
      "--no-skills",
      "--no-extensions",
      "--no-prompt-templates",
    ]);
    expect(pi).toContain("--skill");
    expect(pi).toContain("--extension");
    expect(pi).toContain("--prompt-template");
  });

  test("duplicate skills fail before any projection is rendered", () => {
    const world = scratch();
    pack(world.capabilities, "common", { skill: "same" });
    pack(world.capabilities, "focus", { skill: "same" });
    expect(() =>
      resolveCapabilities(
        ["common", "focus"],
        { AGENTSTART_CAPABILITIES_ROOT: world.capabilities },
        world.home,
        true,
      ),
    ).toThrow(CliError);
  });
});

describe("capability receipts", () => {
  test("restore the exact pack IDs for a native resume", () => {
    const world = scratch();
    pack(world.capabilities, "common");
    pack(world.capabilities, "focus");
    const env = {
      AGENTSTART_CAPABILITIES_ROOT: world.capabilities,
      XDG_STATE_HOME: join(world.root, "state"),
    };
    const set = resolveCapabilities(["common", "focus"], env, world.home, true);
    writeCapabilityReceipt(env, world.home, "codex", "session-1", set);
    expect(requestedCapabilityIds(parts(), env, world.home, "codex", "session-1")).toEqual([
      "common",
      "focus",
    ]);
    expect(
      requestedCapabilityIds(parts(["common"]), env, world.home, "codex", "session-1"),
    ).toEqual(["common"]);
  });
});
