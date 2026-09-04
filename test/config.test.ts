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
  const root = mkdtempSync(join(tmpdir(), "agentlaunch-config-"));
  roots.push(root);
  const home = join(root, "home");
  const directory = join(home, ".config", "agentlaunch");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.json"), content);
  return { env: {}, home };
}

/** Load a config that must fail, and hand back the fault it raised. */
function faultOf(content: string): CliError {
  const { env, home } = writeConfig(content);
  try {
    loadConfig(env, home);
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error(`expected ${content} to be rejected`);
}

describe("loadConfig", () => {
  test("missing file means yolo on everywhere (ADR 0009)", () => {
    const root = mkdtempSync(join(tmpdir(), "agentlaunch-config-"));
    roots.push(root);
    const config = loadConfig({}, join(root, "home"));
    expect(config.exists).toBe(false);
    expect(config.yolo).toEqual({ claude: true, codex: true });
  });

  test("XDG_CONFIG_HOME relocates the file", () => {
    const root = mkdtempSync(join(tmpdir(), "agentlaunch-config-"));
    roots.push(root);
    const env: Environ = { XDG_CONFIG_HOME: join(root, "xdg") };
    expect(configPath(env, join(root, "home"))).toBe(
      join(root, "xdg", "agentlaunch", "config.json"),
    );
  });

  test("per-harness yolo map is read strictly", () => {
    const { env, home } = writeConfig(JSON.stringify({ yolo: { claude: false, codex: true } }));
    const config = loadConfig(env, home);
    expect(config.exists).toBe(true);
    expect(config.yolo).toEqual({ claude: false, codex: true });
  });

  test("boolean yolo covers every harness", () => {
    const { env, home } = writeConfig(JSON.stringify({ yolo: false }));
    expect(loadConfig(env, home).yolo).toEqual({ claude: false, codex: false });
  });

  test("partial maps leave the rest on", () => {
    const { env, home } = writeConfig(JSON.stringify({ yolo: { codex: false } }));
    expect(loadConfig(env, home).yolo).toEqual({ claude: true, codex: false });
  });

  test("an empty file body defaults on", () => {
    const { env, home } = writeConfig(JSON.stringify({}));
    expect(loadConfig(env, home).yolo).toEqual({ claude: true, codex: true });
  });

  test("a $schema key is accepted and ignored", () => {
    const { env, home } = writeConfig(
      JSON.stringify({ $schema: "./config.schema.json", yolo: { claude: false } }),
    );
    const config = loadConfig(env, home);
    expect(config.exists).toBe(true);
    expect(config.yolo).toEqual({ claude: false, codex: true });
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

  test("a body that is not a JSON object is rejected", () => {
    for (const bad of ["null", "42", "true", '"a string"', "[]"]) {
      expect(faultOf(bad).code).toBe("config_invalid");
    }
  });

  test("a file that cannot be read fails rather than defaulting", () => {
    const root = mkdtempSync(join(tmpdir(), "agentlaunch-config-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "agentlaunch", "config.json"), { recursive: true });
    expect(() => loadConfig({}, home)).toThrow(CliError);
  });

  test("a $schema key is ignored whatever its value", () => {
    // The loader filters by key name and never looks at the value, so a
    // mistyped $schema is inert rather than a fault.
    const { env, home } = writeConfig('{"$schema":7,"yolo":{"codex":false}}');
    expect(loadConfig(env, home).yolo).toEqual({ claude: true, codex: false });
  });

  test("missing roots and priming mean the personal defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "agentlaunch-config-"));
    roots.push(root);
    const absent = loadConfig({}, join(root, "home"));
    expect(absent.roots).toEqual(["~/code", "~/source"]);
    expect(absent.priming).toEqual([]);
    const { env, home } = writeConfig(JSON.stringify({}));
    const empty = loadConfig(env, home);
    expect(empty.roots).toEqual(["~/code", "~/source"]);
    expect(empty.priming).toEqual([]);
  });

  test("configured roots and priming win, beside an untouched yolo", () => {
    const { env, home } = writeConfig(
      JSON.stringify({ roots: ["~/work"], priming: ["collab", "build"] }),
    );
    const config = loadConfig(env, home);
    expect(config.roots).toEqual(["~/work"]);
    expect(config.priming).toEqual(["collab", "build"]);
    expect(config.yolo).toEqual({ claude: true, codex: true });
  });

  test("empty roots and malformed priming names refuse loudly", () => {
    for (const bad of [
      JSON.stringify({ roots: [] }),
      JSON.stringify({ roots: "~/code" }),
      JSON.stringify({ priming: ["Not A Skill"] }),
      JSON.stringify({ priming: "collab" }),
    ]) {
      expect(faultOf(bad).code).toBe("config_invalid");
    }
  });
});

/** These pin how a fault is reported: which key it names, in which order
 * faults are found, and that the report points at the file. The prose
 * itself is free to change. */
describe("loadConfig faults", () => {
  test("every unknown root key is named, and the file is named too", () => {
    const fault = faultOf('{"yolo":true,"extra":1,"other":2}');
    expect(fault.code).toBe("config_invalid");
    expect(fault.message).toContain("extra");
    expect(fault.message).toContain("other");
    expect(fault.message).toContain("config.json");
    expect(fault.recovery).toContain("config.json");
  });

  test("unknown root keys are reported before a malformed yolo", () => {
    const fault = faultOf('{"yolo":"bad","extra":1}');
    expect(fault.message).toContain("extra");
    expect(fault.message).not.toContain('"yolo"');
  });

  test("a literal __proto__ at the root is an unknown key", () => {
    // JSON.parse gives it an own key; nothing may treat it as a prototype.
    const fault = faultOf('{"__proto__":{"polluted":true}}');
    expect(fault.code).toBe("config_invalid");
    expect(fault.message).toContain("__proto__");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("a literal __proto__ in the yolo map is an unknown harness", () => {
    const fault = faultOf('{"yolo":{"claude":false,"__proto__":{"polluted":true}}}');
    expect(fault.code).toBe("config_invalid");
    expect(fault.message).toContain("__proto__");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("an unknown harness is named", () => {
    expect(faultOf('{"yolo":{"cursor":true}}').message).toContain("cursor");
  });

  test("the retired harness is rejected by custom config", () => {
    const fault = faultOf('{"yolo":{"pi":false}}');
    expect(fault.code).toBe("config_invalid");
    expect(fault.message).toContain("pi");
  });

  test("a harness flag that is not a boolean names its dotted path", () => {
    for (const bad of ['{"yolo":{"claude":"true"}}', '{"yolo":{"claude":null}}']) {
      expect(faultOf(bad).message).toContain("yolo.claude");
    }
  });

  test("the first offending key in document order is the one named", () => {
    const unknownFirst = faultOf('{"yolo":{"cursor":true,"claude":"x"}}');
    expect(unknownFirst.message).toContain("cursor");
    expect(unknownFirst.message).not.toContain("yolo.claude");
    const mistypedFirst = faultOf('{"yolo":{"claude":"x","cursor":true}}');
    expect(mistypedFirst.message).toContain("yolo.claude");
    expect(mistypedFirst.message).not.toContain("cursor");
  });

  test("a yolo that is neither boolean nor map names the key", () => {
    for (const bad of ['{"yolo":"yes"}', '{"yolo":1}', '{"yolo":null}', '{"yolo":[]}']) {
      const fault = faultOf(bad);
      expect(fault.code).toBe("config_invalid");
      expect(fault.message).toContain("yolo");
    }
  });
});
