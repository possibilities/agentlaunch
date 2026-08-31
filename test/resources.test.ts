import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchSpec } from "../src/harness.ts";
import {
  applyFleetResourceArguments,
  codexSkillPolicyArguments,
  fleetResourcesRoot,
  loadFleetResources,
} from "../src/resources.ts";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function seed(): { home: string; root: string } {
  const scratch = mkdtempSync(join(tmpdir(), "agentlaunch-resources-"));
  roots.push(scratch);
  const home = join(scratch, "home");
  const root = join(home, ".local", "share", "agentstart", "resources");
  for (const name of ["collab", "wiki"]) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), `# ${name}\n`);
  }
  writeFileSync(join(root, "managed-skills.txt"), "collab\nwiki\n");
  mkdirSync(join(root, "claude", "agent", ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, "claude", "agent", ".claude-plugin", "plugin.json"), "{}\n");
  return { home, root };
}

const spec = (harness: "claude" | "codex", command: string[]): LaunchSpec => ({
  harness,
  command,
  sessionId: null,
});

describe("fixed fleet resources", () => {
  test("loads one private resource tree", () => {
    const world = seed();
    expect(fleetResourcesRoot({}, world.home)).toBe(world.root);
    const resources = loadFleetResources({}, world.home);
    expect(resources.codexSkillNames).toEqual(["agent:collab", "agent:wiki"]);
  });

  test("projects Claude resources through its native surface", () => {
    const world = seed();
    const resources = loadFleetResources({}, world.home);
    expect(
      applyFleetResourceArguments(spec("claude", ["claude", "hello"]), resources).command,
    ).toEqual(["claude", "--plugin-dir", join(world.root, "claude", "agent"), "hello"]);
  });

  test("name-enables qualified Codex skills after native subcommands", () => {
    const world = seed();
    const resources = loadFleetResources({}, world.home);
    const policy =
      'skills.config=[{name="agent:collab",enabled=true},{name="agent:wiki",enabled=true}]';
    expect(codexSkillPolicyArguments(resources.codexSkillNames)).toEqual(["-c", policy]);
    expect(
      applyFleetResourceArguments(spec("codex", ["codex", "hello"]), resources).command,
    ).toEqual(["codex", "-c", policy, "hello"]);
    expect(
      applyFleetResourceArguments(spec("codex", ["codex", "resume", "id", "--search"]), resources)
        .command,
    ).toEqual(["codex", "resume", "id", "-c", policy, "--search"]);
    expect(
      applyFleetResourceArguments(spec("codex", ["codex", "exec", "hello"]), resources).command,
    ).toEqual(["codex", "exec", "-c", policy, "hello"]);
  });
});
