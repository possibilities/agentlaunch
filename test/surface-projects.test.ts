import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  orderProjects,
  projectIndexForCwd,
  scanProjects,
  supportsWorktree,
} from "../src/surface/projects.ts";

let temps: string[] = [];

afterEach(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  temps = [];
});

function sandbox(): string {
  const temp = mkdtempSync(join(tmpdir(), "agentlaunch-projects-"));
  temps.push(temp);
  return temp;
}

describe("scanProjects", () => {
  test("offers the root itself, then its directories, skipping files, dot names, and absent roots", () => {
    const home = sandbox();
    mkdirSync(join(home, "code", "alpha"), { recursive: true });
    mkdirSync(join(home, "code", "beta"));
    mkdirSync(join(home, "code", ".hidden"));
    writeFileSync(join(home, "code", "notes.md"), "");
    const found = scanProjects(["~/code", "~/src"], home);
    expect(found).toEqual([
      join(home, "code"),
      join(home, "code", "alpha"),
      join(home, "code", "beta"),
    ]);
  });
});

describe("projectIndexForCwd", () => {
  test("the longest containing project wins; no match falls back to the head", () => {
    const projects = [
      { path: "/h/code/app", display: "app", count: 0, supportsWorktree: true },
      { path: "/h/code/app-extras", display: "app-extras", count: 0, supportsWorktree: true },
    ];
    expect(projectIndexForCwd(projects, "/h/code/app-extras/src")).toBe(1);
    expect(projectIndexForCwd(projects, "/h/code/app")).toBe(0);
    expect(projectIndexForCwd(projects, "/elsewhere")).toBe(0);
  });
});

describe("orderProjects", () => {
  test("most-launched first, alphabetical on ties, with tilde display", () => {
    const home = "/home/u";
    const paths = [`${home}/code/zeta`, `${home}/code/alpha`, `${home}/src/beta`];
    const counts = new Map([[`${home}/src/beta`, 2]]);
    const ordered = orderProjects(paths, counts, home, (path) => path.endsWith("beta"));
    expect(ordered.map((project) => project.display)).toEqual([
      "~/src/beta",
      "~/code/alpha",
      "~/code/zeta",
    ]);
    expect(ordered[0]?.count).toBe(2);
    expect(ordered.map((project) => project.supportsWorktree)).toEqual([true, false, false]);
  });
});

describe("supportsWorktree", () => {
  test("recognizes a Git checkout and directories within it, but not a plain directory", () => {
    const root = sandbox();
    const repository = join(root, "repository");
    const nested = join(repository, "nested");
    const plain = join(root, "plain");
    mkdirSync(nested, { recursive: true });
    mkdirSync(plain);
    execFileSync("git", ["init", "--quiet", repository]);

    expect(supportsWorktree(repository)).toBe(true);
    expect(supportsWorktree(nested)).toBe(true);
    expect(supportsWorktree(plain)).toBe(false);
  });
});
