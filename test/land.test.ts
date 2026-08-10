import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "../src/envelope.ts";
import type { LandResult } from "../src/land.ts";
import type { RunRecord } from "../src/runs.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

interface World {
  root: string;
  binDir: string;
  home: string;
  /** The repository's primary checkout — where a merge has to happen. */
  repo: string;
  /** The linked worktree standing in for a landed workspace. */
  workspace: string;
  argvLog: string;
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args] });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

/**
 * A real repository with a real linked worktree, behind a fake `orca` that
 * answers the survey and release verbs. Git is genuine here — merges,
 * conflicts, and dirtiness are the real thing — because those are exactly
 * what x-land reasons about; only the surface is canned.
 */
function makeWorld(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentsurface-land-")));
  roots.push(root);
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });

  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  // A remote exists but is never contacted: it is what makes the backend's
  // "origin/main" base ref resolve to the local branch.
  git(repo, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);

  const workspace = join(root, "wt");
  git(repo, ["worktree", "add", "-b", "feature", workspace]);

  const argvLog = join(root, "orca-argv.log");
  const fake = join(binDir, "orca");
  writeFileSync(
    fake,
    [
      "#!/usr/bin/env bash",
      `dir="$(dirname "$0")"`,
      `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
      `answer() { cat "$dir/$1.json"; exit "$(cat "$dir/$1.exit" 2>/dev/null || echo 0)"; }`,
      `case "$1 $2" in`,
      `  "status --json") answer status;;`,
      `  "worktree show") answer worktree-show;;`,
      `  "repo show") answer repo-show;;`,
      `  "terminal list") answer terminal-list;;`,
      `  "terminal stop") answer terminal-stop;;`,
      // Release really removes the checkout, so the branch-delete step that
      // follows it meets the same git state it would in a real landing.
      `  "worktree rm") git -C ${JSON.stringify(repo)} worktree remove --force ${JSON.stringify(workspace)} >/dev/null 2>&1; answer worktree-rm;;`,
      `  *) echo '{"ok":false}'; exit 1;;`,
      `esac`,
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);

  const world = { root, binDir, home: join(root, "home"), repo, workspace, argvLog };
  answerFile(world, "status", {
    ok: true,
    result: { runtime: { reachable: true, state: "ready", appVersion: "1.4.177" } },
  });
  answerFile(world, "worktree-show", {
    ok: true,
    result: {
      worktree: {
        id: `repo1::${workspace}`,
        path: workspace,
        displayName: "feature",
        repoId: "repo1",
        isMainWorktree: false,
        childWorktreeIds: [],
      },
    },
  });
  answerFile(world, "repo-show", {
    ok: true,
    result: {
      repo: { id: "repo1", path: repo, displayName: "proj", worktreeBaseRef: "origin/main" },
    },
  });
  answerFile(world, "terminal-list", { ok: true, result: { terminals: [] } });
  answerFile(world, "terminal-stop", { ok: true, result: {} });
  answerFile(world, "worktree-rm", { ok: true, result: {} });
  return world;
}

function answerFile(world: World, name: string, body: unknown, exitCode?: number): void {
  writeFileSync(join(world.binDir, `${name}.json`), JSON.stringify(body));
  if (exitCode !== undefined) writeFileSync(join(world.binDir, `${name}.exit`), String(exitCode));
}

/** A commit in the workspace, so the branch has something to land. */
function commitInWorkspace(world: World, text: string, message: string): void {
  writeFileSync(join(world.workspace, "file.txt"), text);
  git(world.workspace, ["add", "."]);
  git(world.workspace, ["commit", "-m", message]);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(world: World, args: string[], cwd?: string): RunResult {
  const result = Bun.spawnSync({
    cmd: ["bun", MAIN, ...args],
    cwd: cwd ?? world.repo,
    env: {
      PATH: `${world.binDir}:${process.env["PATH"] ?? ""}`,
      HOME: world.home,
      AGENTSURFACE_NO_BALANCE: "1",
    },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function landData(result: RunResult): LandResult {
  return (JSON.parse(result.stdout) as Envelope<Record<string, unknown>>)
    .data as unknown as LandResult;
}

function envelope(result: RunResult): Envelope<Record<string, unknown>> {
  return JSON.parse(result.stdout) as Envelope<Record<string, unknown>>;
}

function orcaCalls(world: World): string[] {
  try {
    return readFileSync(world.argvLog, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

describe("x-land", () => {
  test("a dry run surveys without changing anything", () => {
    const world = makeWorld();
    commitInWorkspace(world, "feature\n", "feature work");
    const before = git(world.repo, ["rev-parse", "main"]);

    const result = run(world, ["x-land", "name:feature", "--x-dry-run", "--x-json"]);
    expect(result.code).toBe(0);
    const data = landData(result);
    expect(data.blockers).toEqual([]);
    expect(data.branch).toBe("feature");
    // origin/main is the backend's base ref; the merge target is the local one.
    expect(data.into).toBe("main");
    expect(data.commits).toBe(1);
    expect(data.primary_path).toBe(world.repo);
    expect(data.removed).toBe(false);

    expect(git(world.repo, ["rev-parse", "main"])).toBe(before);
    expect(existsSync(world.workspace)).toBe(true);
    expect(orcaCalls(world).some((call) => call.startsWith("worktree rm"))).toBe(false);
  });

  test("uncommitted work blocks the land and names the flag that clears it", () => {
    const world = makeWorld();
    commitInWorkspace(world, "feature\n", "feature work");
    writeFileSync(join(world.workspace, "file.txt"), "half-finished\n");

    const dry = landData(run(world, ["x-land", "name:feature", "--x-dry-run", "--x-json"]));
    expect(dry.blockers).toEqual([
      { code: "dirty", detail: "1 modified", cleared_by: "--x-abandon" },
    ]);

    const result = run(world, ["x-land", "name:feature", "--x-json"]);
    expect(result.code).toBe(1);
    const failed = envelope(result);
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("land_blocked");
    // Committing is judgment: the recovery points at the workspace, never at
    // a flag that would commit for the operator.
    expect(failed.error?.recovery).toContain(world.workspace);
    expect(existsSync(world.workspace)).toBe(true);
  });

  test("a live terminal blocks until --x-force", () => {
    const world = makeWorld();
    commitInWorkspace(world, "feature\n", "feature work");
    answerFile(world, "terminal-list", {
      ok: true,
      result: {
        terminals: [{ handle: "term_a", title: "bun dev", connected: true }],
      },
    });

    const blocked = run(world, ["x-land", "name:feature", "--x-json"]);
    expect(blocked.code).toBe(1);
    expect(envelope(blocked).error?.message).toContain("terminals");

    const forced = run(world, ["x-land", "name:feature", "--x-force", "--x-json"]);
    expect(forced.code).toBe(0);
    const data = landData(forced);
    expect(data.stopped).toEqual(["term_a"]);
    expect(orcaCalls(world).some((call) => call.startsWith("terminal stop"))).toBe(true);
  });

  test("landing merges, releases, deletes the branch, and stamps the run", () => {
    const world = makeWorld();
    commitInWorkspace(world, "feature\n", "feature work");
    // A run record pointing at the workspace, as a real landing would leave.
    const runsDir = join(world.home, ".local", "state", "agentsurface", "runs");
    mkdirSync(runsDir, { recursive: true });
    const record: RunRecord = {
      run_id: "run-1",
      created_at: new Date().toISOString(),
      kind: "open",
      backend: "orca",
      harness: "claude",
      harness_value: "claude",
      workspace: { name: "feature", path: world.workspace, id: `repo1::${world.workspace}` },
      terminal: "term_a",
      command: ["claude"],
      session_id: null,
    };
    writeFileSync(join(runsDir, "run-1.json"), JSON.stringify(record));

    const result = run(world, ["x-land", "name:feature", "--x-json"]);
    expect(result.code).toBe(0);
    const data = landData(result);
    expect(data.merge).toBe("merged");
    expect(data.removed).toBe(true);
    expect(data.branch_deleted).toBe(true);
    expect(data.runs).toEqual(["run-1"]);

    expect(git(world.repo, ["log", "--format=%s", "-1", "main"])).toBe("feature work");
    expect(existsSync(world.workspace)).toBe(false);
    expect(git(world.repo, ["branch", "--list", "feature"])).toBe("");

    const stamped = JSON.parse(readFileSync(join(runsDir, "run-1.json"), "utf8")) as RunRecord;
    expect(stamped.closed_as).toBe("landed");
    expect(stamped.closed_at).not.toBeNull();
    // The record survives its workspace: it is what still ties the run id to
    // a session id (ADR 0016).
    expect(stamped.workspace.path).toBe(world.workspace);
  });

  test("a merge conflict rolls back and leaves the target branch untouched", () => {
    const world = makeWorld();
    commitInWorkspace(world, "feature side\n", "feature work");
    writeFileSync(join(world.repo, "file.txt"), "main side\n");
    git(world.repo, ["add", "."]);
    git(world.repo, ["commit", "-m", "main work"]);
    const before = git(world.repo, ["rev-parse", "main"]);

    const result = run(world, ["x-land", "name:feature", "--x-json"]);
    expect(result.code).toBe(1);
    const failed = envelope(result);
    expect(failed.error?.code).toBe("land_conflict");
    expect(failed.error?.message).toContain("file.txt");

    // Rolled back: no merge in progress, HEAD where it was, and nothing
    // released — the destructive half never runs when the merge fails.
    expect(git(world.repo, ["rev-parse", "main"])).toBe(before);
    expect(existsSync(join(world.repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(existsSync(world.workspace)).toBe(true);
    expect(orcaCalls(world).some((call) => call.startsWith("worktree rm"))).toBe(false);
  });

  test("--x-abandon skips the merge and force-deletes the branch", () => {
    const world = makeWorld();
    commitInWorkspace(world, "feature\n", "feature work");
    writeFileSync(join(world.workspace, "file.txt"), "half-finished\n");
    const before = git(world.repo, ["rev-parse", "main"]);

    const result = run(world, ["x-land", "name:feature", "--x-abandon", "--x-json"]);
    expect(result.code).toBe(0);
    const data = landData(result);
    expect(data.merge).toBe("abandoned");
    expect(data.into).toBeNull();
    expect(data.branch_deleted).toBe(true);

    expect(git(world.repo, ["rev-parse", "main"])).toBe(before);
    expect(existsSync(world.workspace)).toBe(false);
    expect(git(world.repo, ["branch", "--list", "feature"])).toBe("");
  });

  test("the repository's primary checkout is refused unconditionally", () => {
    const world = makeWorld();
    answerFile(world, "worktree-show", {
      ok: true,
      result: {
        worktree: {
          id: `repo1::${world.repo}`,
          path: world.repo,
          displayName: "main",
          repoId: "repo1",
          isMainWorktree: true,
          childWorktreeIds: [],
        },
      },
    });
    for (const flags of [[], ["--x-force"], ["--x-abandon"]]) {
      const result = run(world, ["x-land", "name:main", ...flags, "--x-json"]);
      expect(result.code).toBe(1);
      expect(envelope(result).error?.code).toBe("land_primary_checkout");
    }
  });

  test("a child workspace blocks until --x-force", () => {
    const world = makeWorld();
    commitInWorkspace(world, "feature\n", "feature work");
    answerFile(world, "worktree-show", {
      ok: true,
      result: {
        worktree: {
          id: `repo1::${world.workspace}`,
          path: world.workspace,
          displayName: "feature",
          repoId: "repo1",
          isMainWorktree: false,
          childWorktreeIds: [`repo1::${world.root}/other`],
        },
      },
    });
    const blocked = run(world, ["x-land", "name:feature", "--x-json"]);
    expect(blocked.code).toBe(1);
    expect(envelope(blocked).error?.message).toContain("children");
    expect(run(world, ["x-land", "name:feature", "--x-force", "--x-json"]).code).toBe(0);
  });

  test("an unclean primary checkout blocks with no flag to clear it", () => {
    const world = makeWorld();
    commitInWorkspace(world, "feature\n", "feature work");
    writeFileSync(join(world.repo, "stray.txt"), "unstaged\n");

    const dry = landData(run(world, ["x-land", "name:feature", "--x-dry-run", "--x-json"]));
    expect(dry.blockers).toEqual([
      { code: "base_dirty", detail: `${world.repo} has 1 untracked`, cleared_by: null },
    ]);
    expect(run(world, ["x-land", "name:feature", "--x-json"]).code).toBe(1);
  });

  test("a run: ref resolves the workspace through our own registry", () => {
    const world = makeWorld();
    commitInWorkspace(world, "feature\n", "feature work");
    const runsDir = join(world.home, ".local", "state", "agentsurface", "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, "run-7.json"),
      JSON.stringify({
        run_id: "run-7",
        created_at: new Date().toISOString(),
        kind: "open",
        backend: "orca",
        harness: "pi",
        harness_value: "pi",
        workspace: { name: "feature", path: world.workspace, id: `repo1::${world.workspace}` },
        terminal: null,
        command: ["pi"],
        session_id: null,
      } satisfies RunRecord),
    );
    const result = run(world, ["x-land", "run:run-7", "--x-dry-run", "--x-json"]);
    expect(result.code).toBe(0);
    expect(landData(result).workspace.path).toBe(world.workspace);
    // The registry knew the backend's own id, so that is what was asked for.
    expect(orcaCalls(world).some((call) => call.includes(`id:repo1::${world.workspace}`))).toBe(
      true,
    );
  });

  test("a ref with no colon is a usage fault, never a guess", () => {
    const world = makeWorld();
    const result = run(world, ["x-land", "feature"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "neither run:<run-id-or-name> nor a backend workspace selector",
    );
  });
});
