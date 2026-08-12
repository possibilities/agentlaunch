import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/errors.ts";
import type { XSpec } from "../src/partition.ts";
import { partition } from "../src/partition.ts";

const HARNESSES = ["claude", "codex", "pi"] as const;

const SPEC: XSpec = {
  value: new Set(["--x-account"]),
  bool: new Set(["--x-dry-run", "--x-json"]),
  scoped: new Map<string, readonly string[]>([
    ["--x-yolo", HARNESSES],
    ["--x-no-yolo", HARNESSES],
    ["--x-mode", ["fast"]],
  ]),
};

describe("partition", () => {
  test("claims --x-* anywhere and forwards everything else in order", () => {
    const parts = partition(
      ["-p", "hello", "--x-dry-run", "--model", "fable", "--x-account", "work", "mcp"],
      SPEC,
    );
    expect(parts.harness).toEqual(["-p", "hello", "--model", "fable", "mcp"]);
    expect(parts.bools.has("x-dry-run")).toBe(true);
    expect(parts.values["x-account"]).toBe("work");
  });

  test("a literal -- has no meaning and forwards like any token", () => {
    const parts = partition(["--", "--x-dry-run", "--weird"], SPEC);
    expect(parts.harness).toEqual(["--", "--weird"]);
    expect(parts.bools.has("x-dry-run")).toBe(true);
  });

  test("value flags accept both spellings and fault on a missing value", () => {
    expect(partition(["--x-account=c1"], SPEC).values["x-account"]).toBe("c1");
    expect(() => partition(["--x-account"], SPEC)).toThrow(UsageError);
    expect(() => partition(["--x-account", "--x-json"], SPEC)).toThrow(UsageError);
  });

  test("unknown and duplicated x-flags are usage faults", () => {
    expect(() => partition(["--x-bogus"], SPEC)).toThrow(/unknown option "--x-bogus"/);
    expect(() => partition(["--x-json", "--x-json"], SPEC)).toThrow(UsageError);
    expect(() => partition(["--x-json=1"], SPEC)).toThrow(UsageError);
  });

  test("unknown unprefixed flags are the harness's problem, never ours", () => {
    const parts = partition(["--totally-unknown", "-x", "x-word"], SPEC);
    expect(parts.harness).toEqual(["--totally-unknown", "-x", "x-word"]);
  });

  test("scoped flags repeat, and a following harness name narrows one occurrence", () => {
    const parts = partition(["--x-no-yolo", "claude", "--x-no-yolo", "codex", "hello"], SPEC);
    expect(parts.scoped.get("x-no-yolo")).toEqual(["claude", "codex"]);
    expect(parts.harness).toEqual(["hello"]);
  });

  test("a bare scoped flag covers every harness and leaves a prompt alone", () => {
    const parts = partition(["--x-yolo", "fix the tests"], SPEC);
    expect(parts.scoped.get("x-yolo")).toEqual(["all"]);
    expect(parts.harness).toEqual(["fix the tests"]);
  });

  test("the = spelling scopes too, and an off-vocabulary value is a usage fault", () => {
    expect(partition(["--x-yolo=pi"], SPEC).scoped.get("x-yolo")).toEqual(["pi"]);
    expect(() => partition(["--x-yolo=cursor"], SPEC)).toThrow(UsageError);
  });

  test("each scoped flag has its own vocabulary", () => {
    const parts = partition(["--x-mode", "fast", "--x-yolo", "claude"], SPEC);
    expect(parts.scoped.get("x-mode")).toEqual(["fast"]);
    expect(parts.scoped.get("x-yolo")).toEqual(["claude"]);
    // A harness name is outside the other flag's vocabulary and is forwarded.
    const bare = partition(["--x-mode", "claude"], SPEC);
    expect(bare.scoped.get("x-mode")).toEqual(["all"]);
    expect(bare.harness).toEqual(["claude"]);
    expect(() => partition(["--x-mode=claude"], SPEC)).toThrow(UsageError);
  });
});
