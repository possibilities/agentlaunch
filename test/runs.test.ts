import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/errors.ts";
import type { RunRecord } from "../src/runs.ts";
import {
  discoverSessionId,
  interruptedPlacements,
  listRunRecords,
  openPlacementJournal,
  placementJournalPath,
  readRunRecord,
  releaseRunName,
  reserveRunName,
  resolveCallingRun,
  resolveRunReference,
  runServerListenUrl,
  runsDirectory,
  scanRunRecords,
  stampClosedRuns,
  updateRunRecord,
  warnCorruptRunRecords,
  writeRunRecord,
} from "../src/runs.ts";

const ENV = {} as Record<string, string | undefined>;

let homes: string[] = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentsurface-runs-"));
  homes.push(home);
  return home;
}

/** A home short enough for the socket-path budget: macOS's per-user temp
 * directory alone spends more than a unix socket path allows. */
function makeShortHome(): string {
  const home = mkdtempSync(join("/tmp", "as-"));
  homes.push(home);
  return home;
}

function record(runId: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: runId,
    created_at: new Date().toISOString(),
    kind: "open",
    backend: "orca",
    harness: "claude",
    level: null,
    name: null,
    workspace: { name: "ws", path: "/tmp/ws", id: null },
    terminal: null,
    command: ["claude"],
    session_id: null,
    ...extra,
  };
}

function namesEntries(home: string): string[] {
  const directory = join(runsDirectory(ENV, home), ".names");
  return existsSync(directory) ? readdirSync(directory) : [];
}

describe("run record writes", () => {
  test("a write is awaited and lands whole, leaving no temp file behind", async () => {
    const home = makeHome();
    const written = record("run-1");
    const path = await writeRunRecord(ENV, home, written);
    expect(JSON.parse(readFileSync(path, "utf8")) as RunRecord).toEqual(written);
    expect(readdirSync(runsDirectory(ENV, home))).toEqual(["run-1.json"]);
  });

  test("a write killed mid-flight leaves litter, never a half-run", async () => {
    const home = makeHome();
    await writeRunRecord(ENV, home, record("run-1"));
    // What a crash between create and rename leaves: a partial file named out
    // of the *.json space, so the rename that never happened is the only
    // thing missing.
    const directory = runsDirectory(ENV, home);
    writeFileSync(join(directory, ".run-2.9999.0.tmp"), '{"run_id": "run-2", "created');
    const records = await listRunRecords(ENV, home);
    expect(records.map((entry) => entry.run_id)).toEqual(["run-1"]);
    expect(existsSync(join(directory, "run-2.json"))).toBe(false);
  });

  test("a malformed record is corruption an enumeration walks past, loudly", async () => {
    const home = makeHome();
    await writeRunRecord(ENV, home, record("run-1"));
    const stray = join(runsDirectory(ENV, home), "run-2.json");
    writeFileSync(stray, "{ this is not json");
    const { records, corrupt } = await scanRunRecords(ENV, home);
    // One bad file is one run missing, not the whole registry refused.
    expect(records.map((entry) => entry.run_id)).toEqual(["run-1"]);
    expect(corrupt.map((entry) => entry.path)).toEqual([stray]);
    const said: string[] = [];
    warnCorruptRunRecords(corrupt, (line) => said.push(line));
    expect(said.join("\n")).toContain(stray);
    expect(said.join("\n")).toContain("mv ");
    expect(said.every((line) => line.startsWith("WARNING"))).toBe(true);
  });

  test("a JSON file that is not a record is corruption too", async () => {
    const home = makeHome();
    mkdirSync(runsDirectory(ENV, home), { recursive: true });
    writeFileSync(join(runsDirectory(ENV, home), "run-3.json"), '{"run_id": "run-3"}');
    const { records, corrupt } = await scanRunRecords(ENV, home);
    expect(records).toHaveLength(0);
    expect(corrupt).toHaveLength(1);
    expect(await listRunRecords(ENV, home)).toHaveLength(0);
  });

  test("addressing the corrupt record itself still refuses", async () => {
    const home = makeHome();
    mkdirSync(runsDirectory(ENV, home), { recursive: true });
    const stray = join(runsDirectory(ENV, home), "run-4.json");
    writeFileSync(stray, "{ this is not json");
    for (const attempt of [
      () => readRunRecord(ENV, home, "run-4"),
      () => resolveRunReference(ENV, home, "run-4"),
    ]) {
      const failure = await attempt().catch((error: unknown) => error as CliError);
      expect(failure).toBeInstanceOf(CliError);
      expect((failure as CliError).code).toBe("run_registry_corrupt");
      expect((failure as CliError).recovery).toContain("mv ");
    }
  });
});

describe("run record serialization", () => {
  const WS = { name: "ws", path: "/tmp/ws-serialized", id: null };

  /** The verifier's probe, in one process: a session-id backfill that read the
   * record before a close stamp landed must not write its own read back over
   * it. The lock is not enough on its own — the read has to happen inside it. */
  test("a backfill that read a stale record does not drop a close stamp", async () => {
    const home = makeHome();
    await writeRunRecord(ENV, home, record("run-1", { workspace: WS }));
    // read A: what a discovery started from, before anything else touched it
    const readA = await readRunRecord(ENV, home, "run-1");
    expect(readA.closed_at ?? null).toBeNull();
    // read B + write B: the close stamp lands while the discovery is running
    await stampClosedRuns(ENV, home, WS.path, "landed");
    // write A: the discovery's own write, which re-reads under the run's lock
    await updateRunRecord(ENV, home, "run-1", (current) => ({
      ...current,
      session_id: "sess-A",
    }));
    const final = await readRunRecord(ENV, home, "run-1");
    expect(final.session_id).toBe("sess-A");
    expect(final.closed_at).not.toBeNull();
    expect(final.closed_as).toBe("landed");
  });

  /** The contending writers are separate agentsurface processes — a worker's
   * x-run backfilling beside an operator's x-land — so the serialization has
   * to be a file, not a promise. Each child holds the lock across a read, a
   * pause, and a write: without cross-process exclusion the second child reads
   * before the first writes and one field is silently lost. */
  test("two processes read-modify-writing one record both survive", async () => {
    const home = makeHome();
    await writeRunRecord(ENV, home, record("run-1", { workspace: WS }));
    const children = [
      probe(home, "run-1", "session_id", "sess-A"),
      probe(home, "run-1", "closed_at", "2026-08-10T00:00:00.000Z"),
    ];
    for (const child of await Promise.all(children)) expect(child).toBe(0);
    const final = await readRunRecord(ENV, home, "run-1");
    expect(final.session_id).toBe("sess-A");
    expect(final.closed_at).toBe("2026-08-10T00:00:00.000Z");
  });

  /** One separate agentsurface process doing one read-modify-write, slowly
   * enough that an unserialized pair would overlap. */
  async function probe(home: string, runId: string, field: string, value: string): Promise<number> {
    const script = join(home, `probe-${field}.ts`);
    const source = join(import.meta.dir, "..", "src", "runs.ts");
    writeFileSync(
      script,
      [
        `import { readRunRecord, withRunRecordLock, writeRunRecord } from ${JSON.stringify(source)};`,
        "const ENV = {};",
        `const home = ${JSON.stringify(home)};`,
        `const runId = ${JSON.stringify(runId)};`,
        "await withRunRecordLock(ENV, home, runId, async () => {",
        "  const current = await readRunRecord(ENV, home, runId);",
        "  await Bun.sleep(400);",
        `  await writeRunRecord(ENV, home, { ...current, ${field}: ${JSON.stringify(value)} });`,
        "});",
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", "run", script], { stdout: "ignore", stderr: "inherit" });
    return await child.exited;
  }
});

describe("run name reservations", () => {
  test("one name, one holder: the second Placement is refused", async () => {
    const home = makeHome();
    await reserveRunName(ENV, home, "auth-flow", "run-1");
    const failure = await reserveRunName(ENV, home, "auth-flow", "run-2").catch(
      (error: unknown) => error as CliError,
    );
    expect((failure as CliError).code).toBe("run_name_taken");
    expect((failure as CliError).message).toContain("run-1");
    // The name is a file key, not a file name: free text reserves cleanly.
    await reserveRunName(ENV, home, "fix the auth flow", "run-2");
    expect(namesEntries(home)).toHaveLength(2);
  });

  test("a failed Placement releases its name, and only its own", async () => {
    const home = makeHome();
    await reserveRunName(ENV, home, "auth-flow", "run-1");
    await releaseRunName(ENV, home, "auth-flow", "run-2");
    expect(namesEntries(home)).toHaveLength(1);
    await releaseRunName(ENV, home, "auth-flow", "run-1");
    expect(namesEntries(home)).toHaveLength(0);
    await reserveRunName(ENV, home, "auth-flow", "run-3");
  });

  test("a closed run's name is free even if its reservation outlived it", async () => {
    const home = makeHome();
    await reserveRunName(ENV, home, "auth-flow", "run-1");
    await writeRunRecord(
      ENV,
      home,
      record("run-1", { name: "auth-flow", closed_at: new Date().toISOString() }),
    );
    await reserveRunName(ENV, home, "auth-flow", "run-2");
    const holder = JSON.parse(
      readFileSync(join(runsDirectory(ENV, home), ".names", namesEntries(home)[0]!), "utf8"),
    ) as { run_id: string };
    expect(holder.run_id).toBe("run-2");
  });

  test("an open run's name stays held however old the reservation is", async () => {
    const home = makeHome();
    await reserveRunName(ENV, home, "auth-flow", "run-1");
    await writeRunRecord(ENV, home, record("run-1", { name: "auth-flow" }));
    backdate(home, 2 * 60 * 60_000);
    const failure = await reserveRunName(ENV, home, "auth-flow", "run-2").catch(
      (error: unknown) => error as CliError,
    );
    expect((failure as CliError).code).toBe("run_name_taken");
  });

  test("a reservation whose Placement crashed is reaped past the bound", async () => {
    const home = makeHome();
    await reserveRunName(ENV, home, "auth-flow", "run-1");
    // No record was ever committed: the Placement died between the two.
    const held = await reserveRunName(ENV, home, "auth-flow", "run-2").catch(
      (error: unknown) => error as CliError,
    );
    expect((held as CliError).code).toBe("run_name_taken");
    backdate(home, 11 * 60_000);
    await reserveRunName(ENV, home, "auth-flow", "run-2");
  });

  test("two Placements reaping one stale reservation produce a single holder", async () => {
    const home = makeHome();
    await reserveRunName(ENV, home, "auth-flow", "run-1");
    backdate(home, 11 * 60_000);
    // Both judge the same orphan stale; only the one whose rename consumed it
    // may claim, so the other is refused rather than overwriting the winner.
    const outcomes = await Promise.allSettled([
      reserveRunName(ENV, home, "auth-flow", "run-2"),
      reserveRunName(ENV, home, "auth-flow", "run-3"),
    ]);
    const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect((outcome.reason as CliError).code).toBe("run_name_taken");
      }
    }
    expect(namesEntries(home)).toHaveLength(1);
    const holder = JSON.parse(
      readFileSync(join(runsDirectory(ENV, home), ".names", namesEntries(home)[0]!), "utf8"),
    ) as { run_id: string };
    expect(["run-2", "run-3"]).toContain(holder.run_id);
  });

  /** Reservations age by mtime, so a bound is testable without waiting one. */
  function backdate(home: string, byMs: number): void {
    const directory = join(runsDirectory(ENV, home), ".names");
    const when = new Date(Date.now() - byMs);
    for (const entry of readdirSync(directory)) utimesSync(join(directory, entry), when, when);
  }
});

describe("placement journals", () => {
  const WS = { name: "ws", path: "/tmp/ws-journalled", id: null };

  test("a Placement that only claimed an account still leaves a journal", async () => {
    const home = makeHome();
    const journal = openPlacementJournal(ENV, home, {
      run_id: "run-1",
      backend: "orca",
      harness: "codex",
      name: "auth-flow",
    });
    await journal.record("reserved", {});
    // Balancing claims an account and its lease before a Workspace exists: a
    // Placement killed here has created nothing, and is spending something.
    await journal.record("account-claimed", {
      account: { key: "anthropic-2", lease: "lease-7" },
    });
    await journal.interrupt(new Error("orca refused the workspace name"));
    const interrupted = await interruptedPlacements(ENV, home);
    expect(interrupted.map((entry) => entry.run_id)).toEqual(["run-1"]);
    expect(interrupted[0]?.account).toEqual({ key: "anthropic-2", lease: "lease-7" });
  });

  test("a Placement that created and claimed nothing leaves nothing to explain", async () => {
    const home = makeHome();
    const journal = openPlacementJournal(ENV, home, {
      run_id: "run-1",
      backend: "orca",
      harness: "claude",
      name: null,
    });
    await journal.record("reserved", {});
    await journal.interrupt(new Error("refused before anything existed"));
    expect(await interruptedPlacements(ENV, home)).toHaveLength(0);
  });

  test("landing the workspace a journal named clears it, and its name", async () => {
    const home = makeHome();
    await reserveRunName(ENV, home, "auth-flow", "run-1");
    const journal = openPlacementJournal(ENV, home, {
      run_id: "run-1",
      backend: "orca",
      harness: "claude",
      name: "auth-flow",
    });
    await journal.record("workspace-created", { workspace: { path: WS.path, created: true } });
    await journal.interrupt(new Error("terminal create failed"));
    expect(existsSync(placementJournalPath(ENV, home, "run-1"))).toBe(true);
    // x-land releasing that workspace is the decision the journal was waiting
    // for — nothing else ever clears one.
    await stampClosedRuns(ENV, home, WS.path, "abandoned");
    expect(existsSync(placementJournalPath(ENV, home, "run-1"))).toBe(false);
    expect(namesEntries(home)).toHaveLength(0);
    expect(await interruptedPlacements(ENV, home)).toHaveLength(0);
  });

  test("landing one workspace leaves another workspace's journal alone", async () => {
    const home = makeHome();
    const journal = openPlacementJournal(ENV, home, {
      run_id: "run-2",
      backend: "orca",
      harness: "claude",
      name: null,
    });
    await journal.record("workspace-created", {
      workspace: { path: "/tmp/ws-elsewhere", created: true },
    });
    await journal.interrupt(new Error("terminal create failed"));
    await stampClosedRuns(ENV, home, WS.path, "landed");
    expect(existsSync(placementJournalPath(ENV, home, "run-2"))).toBe(true);
  });
});

describe("run server socket paths", () => {
  const RUN_ID = "0199c2f7-4a1e-7c3d-9b2a-5f6e7d8c9b0a";

  test("a short state directory keeps the run id in the socket name", () => {
    const home = makeShortHome();
    const url = runServerListenUrl(ENV, home, RUN_ID);
    expect(url).toBe(`unix://${home}/.local/state/agentsurface/servers/${RUN_ID}.sock`);
  });

  test("a deep state directory hashes the id to stay inside the budget", () => {
    const home = join(makeShortHome(), "d".repeat(20));
    const url = runServerListenUrl(ENV, home, RUN_ID);
    const path = url.slice("unix://".length);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(100);
    expect(path).not.toContain(RUN_ID);
    expect(path).toMatch(/\/[0-9a-f]{12}\.sock$/);
  });

  test("a state directory that spends the whole budget is refused, uncreated", () => {
    const home = join(makeShortHome(), "x".repeat(40), "y".repeat(40));
    const failure = (() => {
      try {
        return runServerListenUrl(ENV, home, RUN_ID);
      } catch (error) {
        return error as CliError;
      }
    })();
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("run_server_path_too_long");
    // Named so the operator can see which directory spent it.
    expect((failure as CliError).message).toContain(join(home, ".local", "state"));
    expect((failure as CliError).recovery).toContain("XDG_STATE_HOME");
    // Refused before anything was created, so nothing is left to clean up.
    expect(existsSync(join(home, ".local"))).toBe(false);
  });
});

/** A claude session file at the store layout discoverSessionId scans: the id
 * comes from the filename, the cwd from a "cwd" field anywhere in the head. */
function writeClaudeSession(home: string, sessionId: string, cwd: string): void {
  const projectDir = join(home, ".claude", "projects", "proj1");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({ cwd })}\n`);
}

describe("session discovery", () => {
  test("S5: the floor is placed_after, not the later created_at stamp", async () => {
    const home = makeHome();
    const workspace = join(home, "ws");
    mkdirSync(workspace, { recursive: true });
    const sessionId = "22222222-2222-2222-2222-222222222222";
    writeClaudeSession(home, sessionId, workspace);
    // The session file's real birth time is "now" — between a placed_after
    // captured before the backend was ever called and a created_at stamped,
    // by construction, after it returned: the ordering S5 exists to fix.
    const run = record("run-1", {
      workspace: { name: "ws", path: workspace, id: null },
      placed_after: new Date(Date.now() - 60_000).toISOString(),
      created_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await discoverSessionId(run, ENV, home)).toBe(sessionId);
  });

  test("S5: a record with no placed_after falls back to created_at", async () => {
    const home = makeHome();
    const workspace = join(home, "ws");
    mkdirSync(workspace, { recursive: true });
    const sessionId = "33333333-3333-3333-3333-333333333333";
    writeClaudeSession(home, sessionId, workspace);
    const run = record("run-1", {
      workspace: { name: "ws", path: workspace, id: null },
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(run.placed_after).toBeUndefined();
    expect(await discoverSessionId(run, ENV, home)).toBe(sessionId);
  });

  test("S7: the workspace join compares resolved paths, not raw strings", async () => {
    const home = makeHome();
    // /tmp is itself a symlink to /private/tmp on macOS — exactly the
    // canonicalization difference a raw string compare misses.
    const rawWorkspace = mkdtempSync(join("/tmp", "as-run-ws-"));
    homes.push(rawWorkspace);
    const resolvedWorkspace = realpathSync(rawWorkspace);
    expect(resolvedWorkspace).not.toBe(rawWorkspace);
    const sessionId = "11111111-1111-1111-1111-111111111111";
    // The store records the resolved cwd the harness actually saw; the run
    // record holds the unresolved path the Workspace was created from.
    writeClaudeSession(home, sessionId, resolvedWorkspace);
    const run = record("run-1", {
      workspace: { name: "ws", path: rawWorkspace, id: null },
      created_at: new Date(0).toISOString(),
    });
    expect(await discoverSessionId(run, ENV, home)).toBe(sessionId);
  });
});

describe("resolving the calling run", () => {
  test("S6: the session tier ignores a closed record, and says why in the refusal", async () => {
    const home = makeHome();
    await writeRunRecord(
      ENV,
      home,
      record("run-closed", {
        harness: "claude",
        session_id: "sess-1",
        closed_at: new Date().toISOString(),
        closed_as: "landed",
      }),
    );
    const failure = await resolveCallingRun(ENV, home, "/nowhere", {
      harness: "claude",
      sessionId: "sess-1",
    }).catch((error: unknown) => error as CliError);
    expect((failure as CliError).code).toBe("not_placed");
    expect((failure as CliError).message).toContain("run-closed");
    expect((failure as CliError).message).toContain("closed");
  });

  test("S6: the session tier ignores an open record of a different harness", async () => {
    const home = makeHome();
    await writeRunRecord(ENV, home, record("run-1", { harness: "codex", session_id: "sess-2" }));
    const failure = await resolveCallingRun(ENV, home, "/nowhere", {
      harness: "claude",
      sessionId: "sess-2",
    }).catch((error: unknown) => error as CliError);
    expect((failure as CliError).code).toBe("not_placed");
    expect((failure as CliError).message).toContain("run-1");
  });

  test("S6: an open record of the caller's own harness still wins on session id", async () => {
    const home = makeHome();
    await writeRunRecord(
      ENV,
      home,
      record("run-open", { harness: "claude", session_id: "sess-3" }),
    );
    const { record: matched, matched: tier } = await resolveCallingRun(ENV, home, "/nowhere", {
      harness: "claude",
      sessionId: "sess-3",
    });
    expect(matched.run_id).toBe("run-open");
    expect(tier).toBe("session");
  });
});
