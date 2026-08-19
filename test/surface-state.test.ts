import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSubmitted,
  type FormDraft,
  readFormDraft,
  readLastSubmitted,
  readSubmittedCounts,
  writeFormDraft,
} from "../src/surface/state.ts";

let temps: string[] = [];

afterEach(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  temps = [];
});

function statePath(name: string): string {
  const temp = mkdtempSync(join(tmpdir(), "agentlaunch-surface-state-"));
  temps.push(temp);
  return join(temp, "state", name);
}

const SUBMITTED = {
  project: "/code/alpha",
  harness: "claude",
  model: "fable",
  effort: "xhigh",
  worktree: false,
  priming: null,
  focus: true,
};

describe("the submitted log", () => {
  test("appends timestamped records and counts submissions per project", () => {
    const path = statePath("submitted.jsonl");
    expect(readSubmittedCounts(path).size).toBe(0);
    appendSubmitted(path, SUBMITTED);
    appendSubmitted(path, SUBMITTED);
    appendSubmitted(path, { ...SUBMITTED, project: "/code/beta" });
    const counts = readSubmittedCounts(path);
    expect(counts.get("/code/alpha")).toBe(2);
    expect(counts.get("/code/beta")).toBe(1);
    const first = JSON.parse(readFileSync(path, "utf8").split("\n")[0] ?? "");
    expect(typeof first.at).toBe("string");
  });

  test("a garbled line loses one record, nothing more", () => {
    const path = statePath("submitted.jsonl");
    appendSubmitted(path, SUBMITTED);
    appendFileSync(path, "{not json\n");
    appendSubmitted(path, SUBMITTED);
    expect(readSubmittedCounts(path).get("/code/alpha")).toBe(2);
  });

  test("remembers the last submission's cascade, skipping garbage tails", () => {
    const path = statePath("submitted.jsonl");
    expect(readLastSubmitted(path)).toBeNull();
    appendSubmitted(path, SUBMITTED);
    appendSubmitted(path, {
      ...SUBMITTED,
      harness: "codex",
      model: "sol",
      effort: "ultra",
      priming: "build",
    });
    appendFileSync(path, "{garbage\n");
    expect(readLastSubmitted(path)).toEqual({
      harness: "codex",
      model: "sol",
      effort: "ultra",
    });
  });
});

describe("the form draft", () => {
  test("round-trips and clears without residue", () => {
    const path = statePath("form-draft.json");
    expect(readFormDraft(path)).toBeNull();
    const draft: FormDraft = {
      prompt: "half a thought\nsecond line",
      project: "/code/alpha",
      worktree: true,
      harness: "claude",
      model: "fable",
      effort: "low",
      priming: "collab",
    };
    writeFormDraft(path, draft);
    expect(readFormDraft(path)).toEqual(draft);
    writeFormDraft(path, null);
    expect(readFormDraft(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("a malformed draft reads as absent", () => {
    const path = statePath("form-draft.json");
    writeFormDraft(path, {
      prompt: "p",
      project: "/x",
      priming: "none",
      worktree: false,
      harness: "claude",
      model: "fable",
      effort: "low",
    });
    appendFileSync(path, "{garbage");
    expect(readFormDraft(path)).toBeNull();
  });
});
