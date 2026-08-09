import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig } from "../src/config.ts";
import { CliError } from "../src/errors.ts";
import type { Environ } from "../src/paths.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function writeConfig(content: string): { env: Environ; home: string } {
  const root = mkdtempSync(join(tmpdir(), "agentsurface-config-"));
  roots.push(root);
  const home = join(root, "home");
  const directory = join(home, ".config", "agentsurface");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.json"), content);
  return { env: {}, home };
}

describe("loadConfig", () => {
  test("missing file means yolo off everywhere", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-config-"));
    roots.push(root);
    const config = loadConfig({}, join(root, "home"));
    expect(config.exists).toBe(false);
    expect(config.yolo).toEqual({ claude: false, codex: false, pi: false });
  });

  test("XDG_CONFIG_HOME relocates the file", () => {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-config-"));
    roots.push(root);
    const env: Environ = { XDG_CONFIG_HOME: join(root, "xdg") };
    expect(configPath(env, join(root, "home"))).toBe(
      join(root, "xdg", "agentsurface", "config.json"),
    );
  });

  test("per-harness yolo map is read strictly", () => {
    const { env, home } = writeConfig(
      JSON.stringify({ yolo: { claude: true, codex: true, pi: false } }),
    );
    const config = loadConfig(env, home);
    expect(config.exists).toBe(true);
    expect(config.yolo).toEqual({ claude: true, codex: true, pi: false });
  });

  test("boolean yolo covers every harness", () => {
    const { env, home } = writeConfig(JSON.stringify({ yolo: true }));
    expect(loadConfig(env, home).yolo).toEqual({ claude: true, codex: true, pi: true });
  });

  test("partial maps leave the rest off", () => {
    const { env, home } = writeConfig(JSON.stringify({ yolo: { codex: true } }));
    expect(loadConfig(env, home).yolo).toEqual({ claude: false, codex: true, pi: false });
  });

  test("invalid shapes are config_invalid domain errors", () => {
    for (const bad of [
      "not json at all",
      JSON.stringify([1, 2]),
      JSON.stringify({ yolo: "yes" }),
      JSON.stringify({ yolo: { cursor: true } }),
      JSON.stringify({ yolo: { claude: "true" } }),
      JSON.stringify({ yolo: true, extra: 1 }),
    ]) {
      const { env, home } = writeConfig(bad);
      expect(() => loadConfig(env, home)).toThrow(CliError);
    }
  });
});
