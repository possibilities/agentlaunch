import { describe, expect, test } from "bun:test";
import { createNarrator, facts, shellLine, tildePath } from "../src/narrate.ts";

function collect(options: { silent: boolean; verbose: boolean }): {
  lines: string[];
  narrator: ReturnType<typeof createNarrator>;
} {
  const lines: string[] = [];
  const narrator = createNarrator({ ...options, write: (line) => lines.push(line) });
  return { lines, narrator };
}

describe("createNarrator", () => {
  test("rows align on one column and details stay out by default", () => {
    const { lines, narrator } = collect({ silent: false, verbose: false });
    narrator.row("open", "claude");
    narrator.row("dry run", "nothing launched");
    narrator.detail("bin", "/usr/bin/claude");
    expect(lines).toEqual(["open      claude", "dry run   nothing launched"]);
    expect(narrator.verbose).toBe(false);
  });

  test("verbose adds detail rows in the same shape", () => {
    const { lines, narrator } = collect({ silent: false, verbose: true });
    narrator.row("open", "claude");
    narrator.detail("bin", "/usr/bin/claude");
    expect(lines).toEqual(["open      claude", "bin       /usr/bin/claude"]);
  });

  test("silent withholds everything, even verbose detail", () => {
    const { lines, narrator } = collect({ silent: true, verbose: true });
    narrator.row("open", "claude");
    narrator.detail("bin", "/usr/bin/claude");
    expect(lines).toEqual([]);
    expect(narrator.verbose).toBe(false);
  });
});

describe("facts", () => {
  test("joins present facts and drops the absent ones", () => {
    expect(facts("claude", "model fable")).toBe("claude · model fable");
    expect(facts("claude", undefined, "effort max")).toBe("claude · effort max");
    expect(facts("claude", "")).toBe("claude");
    expect(facts(undefined, undefined)).toBe("");
  });
});

describe("tildePath", () => {
  test("shortens paths under home and leaves others alone", () => {
    expect(tildePath("/home/user/code/foo", "/home/user")).toBe("~/code/foo");
    expect(tildePath("/home/user", "/home/user")).toBe("~");
    expect(tildePath("/tmp/elsewhere", "/home/user")).toBe("/tmp/elsewhere");
  });

  test("does not shorten a sibling directory that merely shares the prefix", () => {
    expect(tildePath("/home/username/x", "/home/user")).toBe("/home/username/x");
  });

  test("an empty home never rewrites", () => {
    expect(tildePath("/anything", "")).toBe("/anything");
  });
});

describe("shellLine", () => {
  test("quotes only what a shell would need quoted", () => {
    expect(shellLine(["claude", "--model", "fable"])).toBe("claude --model fable");
    expect(shellLine(["claude", "two words"])).toBe("claude 'two words'");
    expect(shellLine(["codex", "-c", 'model_reasoning_effort="max"'])).toBe(
      `codex -c 'model_reasoning_effort="max"'`,
    );
    expect(shellLine(["x", "it's"])).toBe(`x 'it'\\''s'`);
  });
});
