import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliError } from "../src/errors.ts";
import {
  appendDirective,
  buildDirective,
  DIRECTIVE_SCHEMA_VERSION,
  DIRECTIVE_SINK_ENV,
  directiveSink,
  primedIntent,
} from "../src/surface/directive.ts";
import type { LaunchPlan } from "../src/surface/model.ts";

let temps: string[] = [];

afterEach(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  temps = [];
});

function sinkPath(): string {
  const temp = mkdtempSync(join(tmpdir(), "agentlaunch-directive-"));
  temps.push(temp);
  return join(temp, "spool", "directives.jsonl");
}

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

describe("directiveSink", () => {
  test("names the host's sink and refuses to run without one", () => {
    expect(directiveSink({ [DIRECTIVE_SINK_ENV]: "/tmp/sink.jsonl" })).toBe("/tmp/sink.jsonl");
    for (const env of [{}, { [DIRECTIVE_SINK_ENV]: "" }]) {
      let caught: unknown;
      try {
        directiveSink(env);
      } catch (error) {
        caught = error;
      }
      expect((caught as CliError).code).toBe("surface_host_missing");
    }
  });
});

describe("appendDirective", () => {
  test("appends one JSON line per directive, in order", () => {
    const path = sinkPath();
    appendDirective(path, buildDirective(PLAN, false));
    appendDirective(path, buildDirective({ ...PLAN, worktree: true }, true));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "").worktree).toBe(false);
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ worktree: true, focus: true });
  });
});
