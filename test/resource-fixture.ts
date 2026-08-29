import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function seedFleetResources(home: string): void {
  const root = join(home, ".local", "share", "agentstart", "resources");
  const skill = join(root, "skills", "collab");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# collab\n");
  writeFileSync(join(root, "managed-skills.txt"), "collab\n");
  const claude = join(root, "claude", "agent", ".claude-plugin");
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, "plugin.json"), "{}\n");
  mkdirSync(join(root, "pi", "extensions"), { recursive: true });
  mkdirSync(join(root, "pi", "prompt-templates"), { recursive: true });
}
