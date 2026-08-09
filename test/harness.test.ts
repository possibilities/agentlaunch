import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/errors.ts";
import { buildOpen, buildResume, parseHarnessName, sessionStore } from "../src/harness.ts";

const NO_OPTIONS = { passthrough: [] };

describe("parseHarnessName", () => {
  test("accepts the three harnesses", () => {
    expect(parseHarnessName("claude")).toBe("claude");
    expect(parseHarnessName("codex")).toBe("codex");
    expect(parseHarnessName("pi")).toBe("pi");
  });

  test("rejects anything else", () => {
    expect(() => parseHarnessName("cursor")).toThrow(UsageError);
  });
});

describe("buildOpen", () => {
  test("bare open is just the harness binary", () => {
    expect(buildOpen("claude", NO_OPTIONS).command).toEqual(["claude"]);
    expect(buildOpen("codex", NO_OPTIONS).command).toEqual(["codex"]);
    expect(buildOpen("pi", NO_OPTIONS).command).toEqual(["pi"]);
  });

  test("claude gets --model, --effort, --name, then prompt last", () => {
    const spec = buildOpen("claude", {
      model: "fable",
      effort: "max",
      name: "fix-tests",
      prompt: "fix the failing tests",
      passthrough: ["--permission-mode", "plan"],
    });
    expect(spec.command).toEqual([
      "claude",
      "--model",
      "fable",
      "--effort",
      "max",
      "--name",
      "fix-tests",
      "--permission-mode",
      "plan",
      "fix the failing tests",
    ]);
    expect(spec.sessionId).toBeNull();
  });

  test("codex spells effort as a TOML config override", () => {
    const spec = buildOpen("codex", { model: "gpt-5.6-sol", effort: "xhigh", passthrough: [] });
    expect(spec.command).toEqual([
      "codex",
      "--model",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  test("pi spells effort as --thinking", () => {
    const spec = buildOpen("pi", { effort: "high", name: "poke", passthrough: [] });
    expect(spec.command).toEqual(["pi", "--thinking", "high", "--name", "poke"]);
  });

  test("effort values are validated per harness", () => {
    expect(() => buildOpen("codex", { effort: "max", passthrough: [] })).toThrow(
      /codex effort must be one of minimal, low, medium, high, xhigh/,
    );
    expect(() => buildOpen("claude", { effort: "off", passthrough: [] })).toThrow(UsageError);
    expect(buildOpen("pi", { effort: "off", passthrough: [] }).command).toEqual([
      "pi",
      "--thinking",
      "off",
    ]);
  });

  test("codex refuses run names", () => {
    expect(() => buildOpen("codex", { name: "nope", passthrough: [] })).toThrow(
      /codex does not support run names/,
    );
  });
});

describe("buildResume", () => {
  test("claude resumes by flag, codex by subcommand, pi by --session", () => {
    expect(buildResume("claude", "abc-123", []).command).toEqual(["claude", "--resume", "abc-123"]);
    expect(buildResume("codex", "abc-123", []).command).toEqual(["codex", "resume", "abc-123"]);
    expect(buildResume("pi", "abc-123", []).command).toEqual(["pi", "--session", "abc-123"]);
  });

  test("passthrough lands after the id and the spec carries the id", () => {
    const spec = buildResume("codex", "abc-123", ["--last-ish"]);
    expect(spec.command).toEqual(["codex", "resume", "abc-123", "--last-ish"]);
    expect(spec.sessionId).toBe("abc-123");
  });
});

describe("sessionStore", () => {
  const home = "/home/user";

  test("defaults live under the home directory", () => {
    expect(sessionStore("claude", {}, home).root).toBe("/home/user/.claude/projects");
    expect(sessionStore("codex", {}, home).root).toBe("/home/user/.codex");
    expect(sessionStore("pi", {}, home).root).toBe("/home/user/.pi/agent/sessions");
  });

  test("env overrides relocate the store and are reported active", () => {
    const claude = sessionStore("claude", { CLAUDE_CONFIG_DIR: "/profiles/a" }, home);
    expect(claude.root).toBe("/profiles/a/projects");
    expect(claude.overrideActive).toBe(true);

    const codex = sessionStore("codex", { CODEX_HOME: "~/codex-home" }, home);
    expect(codex.root).toBe("/home/user/codex-home");
    expect(codex.overrideActive).toBe(true);

    const pi = sessionStore("pi", { PI_CODING_AGENT_DIR: "/pi/agent" }, home);
    expect(pi.root).toBe("/pi/agent/sessions");
    expect(pi.overrideActive).toBe(true);
  });

  test("empty overrides do not count as active", () => {
    const store = sessionStore("codex", { CODEX_HOME: "" }, home);
    expect(store.root).toBe("/home/user/.codex");
    expect(store.overrideActive).toBe(false);
  });
});
