import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../src/errors.ts";
import { sessionStore } from "../src/harness.ts";
import type { Environ } from "../src/paths.ts";
import { assertSessionId, countSessions, findSessions } from "../src/resolve.ts";

const CLAUDE_ID = "05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60";
const CODEX_ID = "019fcb41-6f70-7283-aa42-97510cb09818";
const PI_ID = "0198a7b2-1111-7222-8333-444455556666";

let roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentsurface-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** A fixture mirroring all three real store layouts under one temp root. */
function fixtureEnv(): { env: Environ; home: string } {
  const root = tempRoot();
  const home = join(root, "home");

  const claudeProjects = join(root, "claude", "projects", "-Users-someone-code-thing");
  mkdirSync(claudeProjects, { recursive: true });
  writeFileSync(join(claudeProjects, `${CLAUDE_ID}.jsonl`), "{}\n");

  const codexDay = join(root, "codex", "sessions", "2026", "08", "09");
  mkdirSync(codexDay, { recursive: true });
  writeFileSync(join(codexDay, `rollout-2026-08-09T10-00-00-${CODEX_ID}.jsonl`), "{}\n");
  const codexArchive = join(root, "codex", "archived_sessions");
  mkdirSync(codexArchive, { recursive: true });

  const piSessions = join(root, "pi", "agent", "sessions", "--Users-someone-code-thing--");
  mkdirSync(piSessions, { recursive: true });
  writeFileSync(join(piSessions, `2026-08-09T10-00-00-000Z_${PI_ID}.jsonl`), "{}\n");

  return {
    env: {
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      PI_CODING_AGENT_DIR: join(root, "pi", "agent"),
    },
    home,
  };
}

describe("assertSessionId", () => {
  test("accepts UUIDs and pi-style custom ids", () => {
    expect(() => assertSessionId(CLAUDE_ID)).not.toThrow();
    expect(() => assertSessionId("my_run.2")).not.toThrow();
  });

  test("rejects ids that could escape the store glob", () => {
    for (const bad of ["", "a/b", "*", "../up", "-leading", "{a,b}", "a?"]) {
      expect(() => assertSessionId(bad)).toThrow(UsageError);
    }
  });
});

describe("findSessions", () => {
  test("finds each id in its own store", async () => {
    const { env, home } = fixtureEnv();
    expect(await findSessions(CLAUDE_ID, env, home)).toEqual([
      { harness: "claude", path: expect.stringContaining(`${CLAUDE_ID}.jsonl`) },
    ]);
    expect(await findSessions(CODEX_ID, env, home)).toEqual([
      { harness: "codex", path: expect.stringContaining(`${CODEX_ID}.jsonl`) },
    ]);
    expect(await findSessions(PI_ID, env, home)).toEqual([
      { harness: "pi", path: expect.stringContaining(`${PI_ID}.jsonl`) },
    ]);
  });

  test("finds compressed and archived codex rollouts", async () => {
    const { env, home } = fixtureEnv();
    const archived = "0197aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
    const compressed = "0196aaaa-bbbb-7ccc-8ddd-eeeeffff1111";
    const codexHome = env["CODEX_HOME"] ?? "";
    writeFileSync(
      join(codexHome, "archived_sessions", `rollout-2026-01-01T00-00-00-${archived}.jsonl`),
      "{}\n",
    );
    writeFileSync(
      join(
        codexHome,
        "sessions",
        "2026",
        "08",
        "09",
        `rollout-2026-08-09T11-00-00-${compressed}.jsonl.zst`,
      ),
      "",
    );
    expect(await findSessions(archived, env, home)).toHaveLength(1);
    expect(await findSessions(compressed, env, home)).toHaveLength(1);
  });

  test("returns every store that has the id", async () => {
    const { env, home } = fixtureEnv();
    const shared = "0195aaaa-bbbb-7ccc-8ddd-eeeeffff2222";
    const claudeDir = join(env["CLAUDE_CONFIG_DIR"] ?? "", "projects", "-elsewhere");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, `${shared}.jsonl`), "{}\n");
    const piDir = join(env["PI_CODING_AGENT_DIR"] ?? "", "sessions", "--elsewhere--");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, `2026-08-09T12-00-00-000Z_${shared}.jsonl`), "{}\n");
    const matches = await findSessions(shared, env, home);
    expect(matches.map((match) => match.harness)).toEqual(["claude", "pi"]);
  });

  test("returns nothing when stores are absent or empty", async () => {
    const root = tempRoot();
    const env: Environ = {
      CLAUDE_CONFIG_DIR: join(root, "nope-claude"),
      CODEX_HOME: join(root, "nope-codex"),
      PI_CODING_AGENT_DIR: join(root, "nope-pi"),
    };
    expect(await findSessions(CLAUDE_ID, env, join(root, "home"))).toEqual([]);
  });
});

describe("countSessions", () => {
  test("counts session files per store", async () => {
    const { env, home } = fixtureEnv();
    expect(await countSessions(sessionStore("claude", env, home))).toBe(1);
    expect(await countSessions(sessionStore("codex", env, home))).toBe(1);
    expect(await countSessions(sessionStore("pi", env, home))).toBe(1);
  });

  test("missing store roots count zero", async () => {
    const root = tempRoot();
    const env: Environ = { CODEX_HOME: join(root, "absent") };
    expect(await countSessions(sessionStore("codex", env, join(root, "home")))).toBe(0);
  });
});
