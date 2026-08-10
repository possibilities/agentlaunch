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
import { dirname, join } from "node:path";
import type { Envelope } from "../src/envelope.ts";
import type { RunRecord } from "../src/runs.ts";
import type { Provenance } from "../src/surface.ts";

type AnyEnvelope = Envelope<Record<string, unknown>>;

interface SurfaceData {
  run_id: string | null;
  session_id: string | null;
  command: string[];
  surface: {
    backend: string;
    project: { name: string; created: boolean } | null;
    workspace: { name: string; path: string | null; id: string | null; created: boolean };
    terminal: string | null;
    provenance: { requested: Provenance; recorded: boolean; detail: string };
  };
}

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const SESSION_ID = "05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60";
/** The adapter's word for "this workspace already existed, so its lineage is
 * not the Placement's to set". */
const NOT_CREATED_DETAIL = "workspace already exists · lineage unchanged";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

interface World {
  root: string;
  binDir: string;
  home: string;
  /** An existing workspace directory the canned orca answers point at. */
  workspace: string;
  argvLog: string;
}

/**
 * A world with a fake `orca` first on PATH: it records its argv and answers
 * from canned per-verb JSON files, so Placements drive the real adapter
 * against the real CLI contract shapes (transcribed from orca 1.4.177)
 * without an Orca install. `repo add` swaps the repo-list answer, which is
 * what makes ensure observable.
 */
function makeWorld(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentsurface-surface-")));
  roots.push(root);
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const workspace = join(root, "ws");
  mkdirSync(workspace, { recursive: true });
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
      `  "worktree create") answer worktree-create;;`,
      `  "worktree set") answer worktree-set;;`,
      `  "worktree list") answer worktree-list;;`,
      `  "repo list") answer repo-list;;`,
      `  "repo add") cp "$dir/repo-list-after.json" "$dir/repo-list.json"; answer repo-add;;`,
      `  "terminal create") answer terminal-create;;`,
      `  *) echo '{"ok":false}'; exit 1;;`,
      `esac`,
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  const answer = (name: string, body: unknown): void => {
    writeFileSync(join(binDir, `${name}.json`), JSON.stringify(body));
  };
  answer("status", {
    ok: true,
    result: { runtime: { reachable: true, state: "ready", appVersion: "1.4.177" } },
  });
  answer("worktree-show", {
    ok: true,
    result: { worktree: { id: `repo1::${workspace}`, path: workspace, displayName: "main" } },
  });
  answer("repo-list", {
    ok: true,
    result: { repos: [{ id: "repo1", path: workspace, displayName: "proj" }] },
  });
  answer("worktree-set", { ok: true, result: {} });
  answer("terminal-create", {
    ok: true,
    result: { terminal: { handle: "term_test-1", worktreeId: `repo1::${workspace}` } },
  });
  return { root, binDir, home: join(root, "home"), workspace, argvLog };
}

function answerFile(world: World, name: string, body: unknown, exitCode?: number): void {
  writeFileSync(join(world.binDir, `${name}.json`), JSON.stringify(body));
  if (exitCode !== undefined) writeFileSync(join(world.binDir, `${name}.exit`), String(exitCode));
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(world: World, args: string[], cwd?: string): RunResult {
  const result = Bun.spawnSync({
    cmd: ["bun", MAIN, ...args],
    cwd: cwd ?? world.workspace,
    env: {
      PATH: `${world.binDir}:${process.env["PATH"] ?? ""}`,
      HOME: world.home,
      CLAUDE_CONFIG_DIR: join(world.root, "claude"),
      CODEX_HOME: join(world.root, "codex"),
      PI_CODING_AGENT_DIR: join(world.root, "pi"),
      AGENTSURFACE_NO_BALANCE: "1",
    },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function orcaCalls(world: World): string[] {
  try {
    return readFileSync(world.argvLog, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

function surfaceData(result: RunResult): SurfaceData {
  return (JSON.parse(result.stdout) as AnyEnvelope).data as unknown as SurfaceData;
}

function runsDir(world: World): string {
  return join(world.home, ".local", "state", "agentsurface", "runs");
}

function readRecord(world: World, runId: string): RunRecord {
  return JSON.parse(readFileSync(join(runsDir(world), `${runId}.json`), "utf8")) as RunRecord;
}

describe("surface placements", () => {
  test("a launch is placed in the current workspace and records a run", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "claude",
      "--x-surface",
      "--x-no-yolo",
      "--x-json",
      "hi",
    ]);
    expect(result.code).toBe(0);
    const data = surfaceData(result);
    expect(data.surface).toEqual({
      backend: "orca",
      project: null,
      workspace: {
        name: "main",
        path: world.workspace,
        id: `repo1::${world.workspace}`,
        created: false,
      },
      terminal: "term_test-1",
      // An existing workspace keeps the lineage it has (ADR 0015).
      provenance: { requested: { kind: "none" }, recorded: false, detail: NOT_CREATED_DETAIL },
    });
    expect(data.run_id).not.toBeNull();
    const record = readRecord(world, data.run_id!);
    expect(record.kind).toBe("open");
    expect(record.harness).toBe("claude");
    // No --x-level, so the record has no level to hold.
    expect(record.level).toBeNull();
    expect(record.terminal).toBe("term_test-1");
    expect(record.session_id).toBeNull();
    expect(record.command).toEqual(["claude", "--model", "opus[1m]", "--effort", "medium", "hi"]);
    const calls = orcaCalls(world);
    expect(calls[0]).toBe("status --json");
    expect(calls[1]).toBe(`worktree show --worktree path:${world.workspace} --json`);
    // The sentinel rides an `env` prefix so PATH shims exec the real binary
    // whether or not Orca runs the command through a shell.
    expect(calls[2]).toBe(
      `terminal create --worktree id:repo1::${world.workspace} --command env AGENTSURFACE_LAUNCH=1 claude --model 'opus[1m]' --effort medium hi --title claude --json`,
    );
    // --x-json without --x-dry-run is legal here: the command returned.
    expect(result.stderr).toBe("");
  });

  test("a dry run resolves read-only: no terminal, no record", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "claude",
      "--x-surface",
      "--x-no-yolo",
      "--x-dry-run",
      "--x-json",
    ]);
    expect(result.code).toBe(0);
    const data = surfaceData(result);
    expect(data.run_id).toBeNull();
    expect(data.surface.terminal).toBeNull();
    expect(data.surface.workspace.path).toBe(world.workspace);
    expect(existsSync(runsDir(world))).toBe(false);
    expect(orcaCalls(world).some((call) => call.startsWith("terminal create"))).toBe(false);
  });

  test("--x-new-workspace ensures the project and creates the workspace", () => {
    const world = makeWorld();
    const repo = join(world.root, "fresh-repo");
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ["git", "init", "-q", repo] });
    const created = join(world.root, "worktrees", "fix-things");
    answerFile(world, "repo-list", { ok: true, result: { repos: [] } });
    answerFile(world, "repo-list-after", {
      ok: true,
      result: { repos: [{ id: "repo9", path: realpathSync(repo), displayName: "fresh-repo" }] },
    });
    answerFile(world, "repo-add", { ok: true, result: {} });
    answerFile(world, "worktree-create", {
      ok: true,
      result: { worktree: { id: `repo9::${created}`, path: created, displayName: "fix-things" } },
    });
    const result = run(
      world,
      [
        "--x-harness",
        "codex",
        "--x-surface",
        "--x-new-workspace",
        "fix-things",
        "--x-no-yolo",
        "--x-json",
      ],
      repo,
    );
    expect(result.code).toBe(0);
    const data = surfaceData(result);
    expect(data.surface.project).toEqual({ name: "fresh-repo", created: true });
    expect(data.surface.workspace).toEqual({
      name: "fix-things",
      path: created,
      id: `repo9::${created}`,
      created: true,
    });
    const calls = orcaCalls(world);
    expect(calls).toContain(`repo add --path ${realpathSync(repo)} --json`);
    // No --x-from means provenance is explicitly none, not left to Orca's
    // env inference (ADR 0015).
    expect(calls).toContain("worktree create --name fix-things --repo id:repo9 --no-parent --json");
  });

  test("a registered project is found, not re-registered", () => {
    const world = makeWorld();
    const created = join(world.root, "worktrees", "more");
    answerFile(world, "worktree-create", {
      ok: true,
      result: { worktree: { id: `repo1::${created}`, path: created, displayName: "more" } },
    });
    const result = run(world, [
      "--x-harness",
      "claude",
      "--x-surface",
      "--x-new-workspace",
      "more",
      "--x-project",
      "proj",
      "--x-no-yolo",
      "--x-json",
    ]);
    expect(result.code).toBe(0);
    expect(surfaceData(result).surface.project).toEqual({ name: "proj", created: false });
    expect(orcaCalls(world).some((call) => call.startsWith("repo add"))).toBe(false);
  });

  test("--x-workspace passes the selector through to the backend", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "claude",
      "--x-surface",
      "orca",
      "--x-workspace",
      "name:main",
      "--x-no-yolo",
      "--x-json",
    ]);
    expect(result.code).toBe(0);
    expect(orcaCalls(world)).toContain("worktree show --worktree name:main --json");
  });

  test("an unmatched workspace is a domain error naming both ways out", () => {
    const world = makeWorld();
    answerFile(world, "worktree-show", { ok: false }, 1);
    const result = run(world, ["--x-harness", "claude", "--x-surface", "--x-json"], world.root);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    expect(envelope.error?.code).toBe("workspace_not_found");
    expect(envelope.error?.recovery).toContain("--x-new-workspace");
  });

  test("an unreachable runtime refuses loudly, never places in this terminal", () => {
    const world = makeWorld();
    answerFile(world, "status", { ok: true, result: { runtime: { reachable: false } } });
    const result = run(world, ["--x-harness", "claude", "--x-surface", "--x-json"]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    expect(envelope.error?.code).toBe("surface_unreachable");
    expect(envelope.error?.recovery).toContain("orca open");
  });

  test("a missing orca CLI refuses with surface_unavailable", () => {
    const world = makeWorld();
    rmSync(join(world.binDir, "orca"));
    const result = Bun.spawnSync({
      cmd: ["bun", MAIN, "--x-harness", "claude", "--x-surface", "--x-json"],
      cwd: world.workspace,
      env: {
        PATH: `${world.binDir}:${dirname(process.execPath)}`,
        HOME: world.home,
        AGENTSURFACE_NO_BALANCE: "1",
      },
    });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout.toString()) as AnyEnvelope;
    expect(envelope.error?.code).toBe("surface_unavailable");
  });

  test("surface flags without --x-surface, and contradictions, are usage faults", () => {
    const world = makeWorld();
    const stray = run(world, ["--x-harness", "claude", "--x-workspace", "name:main"]);
    expect(stray.code).toBe(2);
    expect(stray.stderr).toContain("add --x-surface");
    const both = run(world, [
      "--x-harness",
      "claude",
      "--x-surface",
      "--x-workspace",
      "a",
      "--x-new-workspace",
      "b",
    ]);
    expect(both.code).toBe(2);
    const project = run(world, ["--x-harness", "claude", "--x-surface", "--x-project", "p"]);
    expect(project.code).toBe(2);
    expect(project.stderr).toContain("--x-new-workspace");
    const utility = run(world, ["--x-harness", "codex", "--x-surface", "login"]);
    expect(utility.code).toBe(2);
    expect(utility.stderr).toContain("utility invocation");
  });

  test("a resume is placed in the workspace holding the session's own cwd", () => {
    const world = makeWorld();
    const store = join(world.root, "claude", "projects", "-encoded");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, `${SESSION_ID}.jsonl`),
      `${JSON.stringify({ cwd: world.workspace })}\n`,
    );
    const result = run(
      world,
      ["x-resume", SESSION_ID, "--x-surface", "--x-no-yolo", "--x-json"],
      world.root,
    );
    expect(result.code).toBe(0);
    const data = surfaceData(result);
    expect(data.session_id).toBe(SESSION_ID);
    const record = readRecord(world, data.run_id!);
    expect(record.kind).toBe("resume");
    expect(record.session_id).toBe(SESSION_ID);
    const calls = orcaCalls(world);
    expect(calls).toContain(`worktree show --worktree path:${world.workspace} --json`);
    expect(calls.some((call) => call.includes(`claude --resume ${SESSION_ID}`))).toBe(true);
  });
});

/**
 * Provenance (ADR 0015). The vocabulary is ours — `run:` references resolve
 * through our own registry — and Orca's flavor of it is a `--parent-worktree`
 * selector. The load-bearing case is the last one: omitting the flag emits
 * `--no-parent`, because on a backend that infers, saying nothing is not the
 * same as saying none.
 */
describe("provenance", () => {
  /** A new workspace in the already-registered project, so the ensure path
   * needs no git repository of its own. */
  function placeNew(world: World, args: string[]): RunResult {
    const created = join(world.root, "worktrees", "child");
    answerFile(world, "worktree-create", {
      ok: true,
      result: { worktree: { id: `repo1::${created}`, path: created, displayName: "child" } },
    });
    return run(world, [
      "--x-harness",
      "codex",
      "--x-surface",
      "--x-new-workspace",
      "child",
      "--x-project",
      "proj",
      "--x-no-yolo",
      "--x-json",
      ...args,
    ]);
  }

  test("--x-from carries a backend selector through untouched", () => {
    const world = makeWorld();
    const result = placeNew(world, ["--x-from", "name:parent-ws"]);
    expect(result.code).toBe(0);
    const data = surfaceData(result);
    expect(data.surface.provenance).toEqual({
      requested: { kind: "selector", selector: "name:parent-ws" },
      recorded: true,
      detail: "name:parent-ws",
    });
    expect(orcaCalls(world)).toContain(
      "worktree create --name child --repo id:repo1 --parent-worktree name:parent-ws --json",
    );
    expect(readRecord(world, data.run_id!).from).toEqual({
      kind: "selector",
      selector: "name:parent-ws",
    });
  });

  test("--x-from run:<id> resolves through our own registry", () => {
    const world = makeWorld();
    // One Placement, then a second that descends from it — the agent-spawning-
    // agent case, expressed entirely in run ids.
    const first = surfaceData(
      run(world, ["--x-harness", "codex", "--x-surface", "--x-no-yolo", "--x-json"]),
    );
    const parentRun = first.run_id!;
    const result = placeNew(world, ["--x-from", `run:${parentRun}`]);
    expect(result.code).toBe(0);
    const data = surfaceData(result);
    expect(data.surface.provenance.recorded).toBe(true);
    expect(data.surface.provenance.detail).toBe(`run ${parentRun} · main`);
    expect(orcaCalls(world)).toContain(
      `worktree create --name child --repo id:repo1 --parent-worktree id:repo1::${world.workspace} --json`,
    );
    expect(readRecord(world, data.run_id!).from).toEqual({
      kind: "run",
      runId: parentRun,
      backend: "orca",
      workspace: { name: "main", path: world.workspace, id: `repo1::${world.workspace}` },
    });
  });

  test("--x-no-from and an omitted flag both mean explicitly none", () => {
    const explicit = makeWorld();
    expect(placeNew(explicit, ["--x-no-from"]).code).toBe(0);
    const silent = makeWorld();
    const result = placeNew(silent, []);
    expect(result.code).toBe(0);
    const created = "worktree create --name child --repo id:repo1 --no-parent --json";
    expect(orcaCalls(explicit)).toContain(created);
    expect(orcaCalls(silent)).toContain(created);
    const data = surfaceData(result);
    expect(data.surface.provenance).toEqual({
      requested: { kind: "none" },
      recorded: true,
      detail: "none",
    });
    expect(readRecord(silent, data.run_id!).from).toBeNull();
  });

  test("an unknown parent run is a domain error, not a silent none", () => {
    const world = makeWorld();
    const result = placeNew(world, ["--x-from", "run:2f4a9c1e-0000-4000-8000-000000000000"]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    expect(envelope.error?.code).toBe("run_not_found");
    expect(orcaCalls(world).some((call) => call.startsWith("worktree create"))).toBe(false);
  });

  test("a ref that is neither run: nor a selector is a usage fault", () => {
    const world = makeWorld();
    const result = placeNew(world, ["--x-from", "parent"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("run:<run-id-or-name>");
    expect(orcaCalls(world).some((call) => call.startsWith("worktree create"))).toBe(false);
  });

  test("provenance flags are usage faults where they cannot apply", () => {
    const world = makeWorld();
    const cases: Array<[string, string[]]> = [
      [
        "both at once",
        ["--x-surface", "--x-new-workspace", "c", "--x-from", "name:a", "--x-no-from"],
      ],
      ["an existing workspace keeps what it has", ["--x-surface", "--x-from", "name:a"]],
      ["the current workspace keeps what it has", ["--x-surface", "--x-no-from"]],
      ["no surface at all", ["--x-from", "name:a"]],
    ];
    for (const [reason, args] of cases) {
      const result = run(world, ["--x-harness", "codex", "--x-no-yolo", ...args]);
      expect(result.code, reason).toBe(2);
    }
  });
});

describe("run records", () => {
  function place(world: World, args: string[] = []): string {
    const result = run(world, [
      "--x-harness",
      "codex",
      "--x-surface",
      "--x-no-yolo",
      "--x-json",
      ...args,
    ]);
    expect(result.code).toBe(0);
    return surfaceData(result).run_id!;
  }

  test("x-runs lists records; x-run discovers the session id and backfills", () => {
    const world = makeWorld();
    const runId = place(world);
    expect(readRecord(world, runId).session_id).toBeNull();

    // The session is born in the run's workspace after the Placement: the
    // codex store gains a rollout whose session_meta cwd is the workspace.
    const day = join(world.root, "codex", "sessions", "2026", "08", "09");
    mkdirSync(day, { recursive: true });
    const uuid = "019fe905-1768-7370-af06-e8afcff04b49";
    writeFileSync(
      join(day, `rollout-2026-08-09T20-14-13-${uuid}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { session_id: uuid, cwd: world.workspace } })}\n`,
    );

    const list = run(world, ["x-runs", "--x-json"]);
    expect(list.code).toBe(0);
    const runs = (JSON.parse(list.stdout) as AnyEnvelope).data?.["runs"] as RunRecord[];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.run_id).toBe(runId);

    const shown = run(world, ["x-run", runId, "--x-json"]);
    expect(shown.code).toBe(0);
    const record = (JSON.parse(shown.stdout) as AnyEnvelope).data as unknown as RunRecord;
    expect(record.session_id).toBe(uuid);
    expect(readRecord(world, runId).session_id).toBe(uuid);
  });

  test("a session in another cwd is never claimed by discovery", () => {
    const world = makeWorld();
    const runId = place(world);
    const day = join(world.root, "codex", "sessions", "2026", "08", "09");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-2026-08-09T20-14-13-019fe905-1768-7370-af06-000000000000.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { session_id: "other", cwd: "/somewhere/else" } })}\n`,
    );
    const shown = run(world, ["x-run", runId, "--x-json"]);
    expect(shown.code).toBe(0);
    const record = (JSON.parse(shown.stdout) as AnyEnvelope).data as unknown as RunRecord;
    expect(record.session_id).toBeNull();
  });

  test("an unknown run id is run_not_found with the listing recovery", () => {
    const world = makeWorld();
    const result = run(world, ["x-run", "nope", "--x-json"]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    expect(envelope.error?.code).toBe("run_not_found");
    expect(envelope.error?.recovery).toContain("x-runs");
  });

  test("x-doctor reports the backend and the run count", () => {
    const world = makeWorld();
    place(world);
    const result = run(world, ["x-doctor", "--x-json"]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as {
      surface: {
        backends: Array<{ backend: string; reachable: boolean; detail: string }>;
        runs: number;
      };
    };
    expect(data.surface.backends).toEqual([
      { backend: "orca", reachable: true, detail: "runtime ready · v1.4.177" },
    ]);
    expect(data.surface.runs).toBe(1);
  });
});

describe("run names", () => {
  function placeNamed(world: World, name: string, args: string[] = []): string {
    const result = run(world, [
      "--x-harness",
      "codex",
      "--x-surface",
      "--x-name",
      name,
      "--x-no-yolo",
      "--x-json",
      ...args,
    ]);
    expect(result.code).toBe(0);
    return surfaceData(result).run_id!;
  }

  test("the name titles the terminal and is written to the record", () => {
    const world = makeWorld();
    const runId = placeNamed(world, "fix the auth flow");
    const record = readRecord(world, runId);
    expect(record.name).toBe("fix the auth flow");
    expect(orcaCalls(world)).toContain(
      `terminal create --worktree id:repo1::${world.workspace} --command env AGENTSURFACE_LAUNCH=1 codex --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --title fix the auth flow --json`,
    );
  });

  test("a created workspace is labelled with the name, verbatim", () => {
    const world = makeWorld();
    // Creating a workspace infers the project from the anchor's git toplevel.
    Bun.spawnSync({ cmd: ["git", "init", "-q", world.workspace] });
    const created = join(world.root, "worktrees", "auth");
    answerFile(world, "worktree-create", {
      ok: true,
      result: { worktree: { id: `repo1::${created}`, path: created, displayName: "auth" } },
    });
    placeNamed(world, "fix the auth flow", ["--x-new-workspace", "auth"]);
    // Orca stores what it is given: the checkout keeps the slug, the card
    // reads the name as typed.
    expect(orcaCalls(world)).toContain(
      "worktree create --name auth --repo id:repo1 --no-parent --json",
    );
    expect(orcaCalls(world)).toContain(
      `worktree set --worktree id:repo1::${created} --display-name fix the auth flow --json`,
    );
  });

  test("a workspace that already existed is never relabelled", () => {
    const world = makeWorld();
    placeNamed(world, "fix the auth flow");
    expect(orcaCalls(world).some((call) => call.startsWith("worktree set"))).toBe(false);
  });

  test("x-run and x-runs read a run back by its name", () => {
    const world = makeWorld();
    const runId = placeNamed(world, "auth-flow");
    const shown = run(world, ["x-run", "auth-flow", "--x-json"]);
    expect(shown.code).toBe(0);
    const record = (JSON.parse(shown.stdout) as AnyEnvelope).data as unknown as RunRecord;
    expect(record.run_id).toBe(runId);
    const list = run(world, ["x-runs"]);
    expect(list.stdout).toContain("auth-flow");
  });

  test("a name an open run already answers to is refused at the source", () => {
    const world = makeWorld();
    const first = placeNamed(world, "auth-flow");
    const result = run(world, [
      "--x-harness",
      "codex",
      "--x-surface",
      "--x-name",
      "auth-flow",
      "--x-no-yolo",
      "--x-json",
    ]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    expect(envelope.error?.code).toBe("run_name_taken");
    expect(envelope.error?.message).toContain(first);
    // Refused before anything was placed: the name still names exactly one run.
    expect(run(world, ["x-run", "auth-flow", "--x-json"]).code).toBe(0);
  });

  test("a second codex Placement into one workspace waits its turn", () => {
    const world = makeWorld();
    placeNamed(world, "first-run");
    const result = run(world, [
      "--x-harness",
      "codex",
      "--x-surface",
      "--x-name",
      "second-run",
      "--x-no-yolo",
      "--x-json",
    ]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    expect(envelope.error?.code).toBe("placement_in_flight");
    expect(envelope.error?.recovery).toContain("retry");
  });

  test("claude is placed beside a held codex slot: only codex needs telling apart", () => {
    const world = makeWorld();
    placeNamed(world, "codex-run");
    const result = run(world, [
      "--x-harness",
      "claude",
      "--x-surface",
      "--x-name",
      "claude-run",
      "--x-no-yolo",
      "--x-json",
    ]);
    expect(result.code).toBe(0);
  });

  test("codex's workspace trust is answered before anything starts in it", () => {
    const world = makeWorld();
    placeNamed(world, "trusted-run");
    // Written under the relocating env var, not the default home.
    const config = readFileSync(join(world.root, "codex", "config.toml"), "utf8");
    expect(config).toContain(`[projects.${JSON.stringify(realpathSync(world.workspace))}]`);
    expect(config).toContain('trust_level = "trusted"');
  });

  test("--x-from resolves a run by name", () => {
    const world = makeWorld();
    Bun.spawnSync({ cmd: ["git", "init", "-q", world.workspace] });
    placeNamed(world, "parent-run");
    const created = join(world.root, "worktrees", "child");
    answerFile(world, "worktree-create", {
      ok: true,
      result: { worktree: { id: `repo1::${created}`, path: created, displayName: "child" } },
    });
    const result = run(world, [
      "--x-harness",
      "codex",
      "--x-surface",
      "--x-new-workspace",
      "child",
      "--x-from",
      "run:parent-run",
      "--x-no-yolo",
      "--x-json",
    ]);
    expect(result.code).toBe(0);
    expect(orcaCalls(world)).toContain(
      `worktree create --name child --repo id:repo1 --parent-worktree id:repo1::${world.workspace} --json`,
    );
  });
});
