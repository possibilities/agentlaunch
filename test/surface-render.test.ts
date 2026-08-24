import { describe, expect, test } from "bun:test";
import {
  buildFormLines,
  createForm,
  type FormHarness,
  type FormState,
  failRun,
} from "../src/surface/model.ts";
import type { ProjectChoice } from "../src/surface/projects.ts";

const HARNESSES: FormHarness[] = [
  {
    harness: "claude",
    defaultModel: "fable",
    defaultEffort: "medium",
    models: [{ model: "fable", efforts: ["low", "medium", "high"], defaultEffort: null }],
  },
];

const PROJECTS: ProjectChoice[] = [
  {
    path: "/home/u/code/alpha",
    display: "~/code/alpha",
    count: 3,
    supportsWorktree: true,
  },
  {
    path: "/home/u/code/a-project-with-a-very-long-name-indeed",
    display: "~/code/a-project-with-a-very-long-name-indeed",
    count: 0,
    supportsWorktree: true,
  },
];

function form(): FormState {
  return createForm({ projects: [...PROJECTS], harnesses: HARNESSES });
}

function rows(state: FormState, width: number): string[] {
  return buildFormLines(state, width).map((row) => row.spans.map((span) => span.text).join(""));
}

describe("buildFormLines", () => {
  test("shows the fact rows and the cascade", () => {
    const text = rows(form(), 76).join("\n");
    expect(text).toContain("project");
    expect(text).toContain("~/code/alpha");
    expect(text).not.toContain("3×"); // frequency orders the list, unshown
    expect(text).toContain("● new worktree");
    expect(text).toContain("claude");
    expect(text).toContain("fable");
    expect(text).toContain("medium");
  });

  test("marks the focused row with the accent rail", () => {
    const state = form();
    state.focus = "project";
    const projectRow = rows(state, 76).find((row) => row.includes("project"));
    expect(projectRow?.startsWith("▎")).toBe(true);
  });

  test("the worktree row states itself; herdr owns the branch name", () => {
    const state = form();
    expect(rows(state, 76).some((row) => row.includes("branch"))).toBe(false);
    expect(rows(state, 76).join("\n")).toContain("● new worktree");
    state.worktree = false;
    const text = rows(state, 76).join("\n");
    expect(text).toContain("○ no worktree");
    expect(text).not.toContain("branch");
  });

  test("a non-Git project renders the worktree row as unavailable and unfocused", () => {
    const state = form();
    state.projects[0] = { ...state.projects[0]!, supportsWorktree: false };
    state.focus = "worktree"; // stale focus must not make a disabled row actionable
    const worktreeRow = rows(state, 76).find((row) => row.includes("worktree"));
    expect(worktreeRow).toContain("○ unavailable · not a git repository");
    expect(worktreeRow?.startsWith("▎")).toBe(false);
  });

  test("no row exceeds the frame at the contract widths", () => {
    for (const width of [36, 76, 96]) {
      for (const row of rows(form(), width)) {
        expect(row.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("renders no identity, no help line, no key advertisement", () => {
    const text = rows(form(), 76).join("\n").toLowerCase();
    expect(text).not.toContain("agentlaunch");
    expect(text).not.toContain("ctrl");
    expect(text).not.toContain("⌃");
  });

  test("confirmation and failure live in the body with recovery keys", () => {
    const state = form();
    state.notice = { text: "started claude · ~/code/alpha", tone: "ok" };
    expect(rows(state, 76).join("\n")).toContain("started claude · ~/code/alpha");
    failRun(state, "workspace create: no repo");
    const text = rows(state, 76).join("\n");
    expect(text).toContain("FAILED · workspace create: no repo");
    expect(text).toContain("ESC QUIT · ⏎ BACK");
  });

  test("the intent renders no line here — the textarea above owns it", () => {
    const state = form();
    state.prompt = "words that must not appear in the fact rows";
    expect(rows(state, 76).join("\n")).not.toContain("words that must not appear");
  });

  test("a slash-command prompt shows the priming row off, within the frame", () => {
    const state = createForm({
      projects: [...PROJECTS],
      harnesses: HARNESSES,
      primings: ["collab"],
    });
    expect(rows(state, 76).join("\n")).toContain("collab");
    state.prompt = "/collab ship the form";
    const primingRow = rows(state, 76).find((row) => row.includes("priming"));
    expect(primingRow).toContain("none");
    expect(primingRow).toContain("slash command");
    expect(primingRow?.startsWith("▎")).toBe(false);
    for (const width of [36, 76, 96]) {
      for (const row of rows(state, width)) {
        expect(row.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("tags each field row for the pointer; separators and status are null", () => {
    const state = form();
    expect(buildFormLines(state, 76).map((row) => row.field)).toEqual([
      "project",
      "worktree",
      null,
      "harness",
      "model",
      "effort",
      "priming",
    ]);
    failRun(state, "boom");
    const tail = buildFormLines(state, 76)
      .map((row) => row.field)
      .slice(7);
    expect(tail).toEqual([null, null, null]);
  });
});
