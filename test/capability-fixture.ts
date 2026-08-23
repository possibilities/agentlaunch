import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function seedCommonCapability(home: string): void {
  const root = join(home, ".local", "share", "agentstart", "capabilities", "packs", "common");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "capability.json"),
    `${JSON.stringify({
      schema_version: 1,
      id: "common",
      default: true,
      description: "Test common capability pack",
      resources: {},
    })}\n`,
  );
}
