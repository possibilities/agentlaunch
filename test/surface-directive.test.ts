import { describe, expect, test } from "bun:test";
import type { CliError } from "../src/errors.ts";
import {
  assertHostedStdout,
  buildDirective,
  DIRECTIVE_SCHEMA_VERSION,
  directiveLine,
  primedIntent,
} from "../src/surface/directive.ts";
import type { LaunchPlan } from "../src/surface/model.ts";

const PLAN: LaunchPlan = {
  project: { path: "/code/alpha", display: "~/code/alpha", count: 0 },
  worktree: false,
  harness: "claude",
  model: "fable",
  effort: "max",
  level: "fable:max",
  prompt: "fix it",
  priming: null,
};

describe("primedIntent", () => {
  test("each harness spells its own skill prefix; empty intents prime alone", () => {
    expect(primedIntent({ harness: "claude", prompt: "fix it", priming: "collab" })).toBe(
      "/collab fix it",
    );
    expect(primedIntent({ harness: "pi", prompt: "fix it", priming: "build" })).toBe(
      "/build fix it",
    );
    expect(primedIntent({ harness: "codex", prompt: "fix it", priming: "collab" })).toBe(
      "$collab fix it",
    );
    expect(primedIntent({ harness: "codex", prompt: "", priming: "orchestrate" })).toBe(
      "$orchestrate",
    );
    expect(primedIntent({ harness: "claude", prompt: "fix it", priming: null })).toBe("fix it");
  });
});

describe("buildDirective", () => {
  test("carries the surface half, the agent half, and the record extras", () => {
    const directive = buildDirective(PLAN, true);
    expect(directive).toEqual({
      schema_version: DIRECTIVE_SCHEMA_VERSION,
      cwd: "/code/alpha",
      worktree: false,
      focus: true,
      agent: { kind: "claude", args: ["--x-level", "fable:max"] },
      intent: "fix it",
      record: { model: "fable", effort: "max", priming: null },
    });
  });

  test("an empty intent travels as null; a priming composes into it", () => {
    expect(buildDirective({ ...PLAN, prompt: "" }, false).intent).toBeNull();
    const primed = buildDirective({ ...PLAN, harness: "codex", priming: "collab" }, false);
    expect(primed.intent).toBe("$collab fix it");
    expect(primed.focus).toBe(false);
    expect(primed.record).toEqual({ model: "fable", effort: "max", priming: "collab" });
  });
});

describe("directiveLine", () => {
  test("one directive, one newline-terminated JSON line, whatever the intent holds", () => {
    const wild = buildDirective(
      { ...PLAN, prompt: "line one\nline two\ttabbed", priming: "collab" },
      false,
    );
    const line = directiveLine(wild);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(wild);
  });
});

describe("assertHostedStdout", () => {
  test("a piped stdout passes; a terminal stdout refuses with the host recovery", () => {
    expect(() => assertHostedStdout({ isTTY: undefined })).not.toThrow();
    expect(() => assertHostedStdout({ isTTY: false })).not.toThrow();
    let caught: unknown;
    try {
      assertHostedStdout({ isTTY: true });
    } catch (error) {
      caught = error;
    }
    expect((caught as CliError).code).toBe("surface_host_missing");
    expect((caught as CliError).recovery).toContain("agentsurface host");
  });
});
