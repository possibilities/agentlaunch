import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Glob } from "bun";
import { CliError, UsageError } from "./errors.ts";
import type { HarnessName } from "./harness.ts";
import { sessionFileFacts, sessionStore } from "./harness.ts";
import type { Environ } from "./paths.ts";
import { stateDirectory } from "./paths.ts";
import type { Provenance } from "./surface.ts";

/**
 * The run registry (ADR 0014/0022): a run is a session plus where it was
 * placed, and the record is agentsurface's own bookkeeping — the one
 * identifier a Placement can promise immediately, since a session id is not
 * always knowable at launch (codex mints its uuid7 during startup). The run id
 * names the record file, rides the envelope, and is never passed to the
 * harness. One file per run, so concurrent Placements never contend.
 */
export interface RunRecord {
  run_id: string;
  created_at: string;
  kind: "open" | "resume";
  backend: string;
  harness: HarnessName;
  /** The --x-level value as typed, null when none was given (ADR 0018). */
  level?: string | null;
  /** What `level` was called before the flags split — records written then
   * hold a whole `--x-harness` union value here. Read, never written: a run
   * record outlives the workspace, so the old ones stay readable. */
  harness_value?: string | null;
  /** The operator's own label for this run (`--x-name`), free text and never
   * unique — a handle to read back, not an identity. Absent on records
   * written before run names existed, which reads the same as unnamed. */
  name?: string | null;
  workspace: { name: string; path: string; id: string | null };
  /** Backend-issued terminal handle — an address for steering, not the
   * run's identity; its lifetime is the backend runtime's. */
  terminal: string | null;
  command: string[];
  session_id: string | null;
  /** What the caller said this run descends from (ADR 0015) — our own
   * bookkeeping, kept whether or not the backend could record it, and
   * absent on records written before provenance existed. */
  from?: Provenance | null;
  /** When x-land released the workspace this run lived in (ADR 0016).
   * Stamped rather than deleted: a finished run is the last thing tying a
   * run id to a session id, and what to prune is a decision of its own. */
  closed_at?: string | null;
  closed_as?: "landed" | "abandoned" | null;
}

/** Same alphabet as session ids: every character glob- and path-literal. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) {
    throw new UsageError(`run id "${runId}" must be alphanumeric plus dot, dash, or underscore`);
  }
}

export function runsDirectory(env: Environ, home: string): string {
  return join(stateDirectory(env, home, "agentsurface"), "runs");
}

function recordPath(env: Environ, home: string, runId: string): string {
  return join(runsDirectory(env, home), `${runId}.json`);
}

export function writeRunRecord(env: Environ, home: string, record: RunRecord): string {
  const directory = runsDirectory(env, home);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${record.run_id}.json`);
  Bun.write(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export async function readRunRecord(env: Environ, home: string, runId: string): Promise<RunRecord> {
  assertRunId(runId);
  const path = recordPath(env, home, runId);
  if (!existsSync(path)) {
    throw new CliError(
      "run_not_found",
      `run "${runId}" has no record under ${runsDirectory(env, home)}`,
      "agentsurface x-runs lists the recorded runs",
    );
  }
  return (await Bun.file(path).json()) as RunRecord;
}

/** Newest first — records are tiny and the directory is flat. */
export async function listRunRecords(env: Environ, home: string): Promise<RunRecord[]> {
  const directory = runsDirectory(env, home);
  if (!existsSync(directory)) return [];
  const records: RunRecord[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    try {
      records.push((await Bun.file(join(directory, entry)).json()) as RunRecord);
    } catch {
      // A half-written or foreign file is not a run; listing skips it.
    }
  }
  records.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return records;
}

/**
 * Runs carrying a name, newest first. Nothing enforces uniqueness — a name
 * is a label, so two runs may share one — which is why this returns every
 * match and lets the caller refuse rather than guess. Closed runs are
 * reported apart: their workspace is gone, so a reference almost never means
 * them, but hiding them entirely would turn "already closed" into "never
 * existed".
 */
export async function findRunsByName(
  env: Environ,
  home: string,
  name: string,
): Promise<{ open: RunRecord[]; closed: RunRecord[] }> {
  const matches = (await listRunRecords(env, home)).filter((record) => record.name === name);
  return {
    open: matches.filter((record) => record.closed_at == null),
    closed: matches.filter((record) => record.closed_at != null),
  };
}

/**
 * A run reference, resolved in tiers: an exact run id first, then a run
 * name. One word covers both because a name is what an operator remembers
 * and an id is what a machine kept — and the id tier is exact, so a name
 * shaped like an id never shadows the record it names. Names are not unique,
 * so several matches is a refusal naming the candidates rather than a guess;
 * open runs are preferred, since a closed one's workspace is already gone.
 */
export async function resolveRunReference(
  env: Environ,
  home: string,
  reference: string,
): Promise<RunRecord> {
  if (RUN_ID.test(reference) && existsSync(recordPath(env, home, reference))) {
    return await readRunRecord(env, home, reference);
  }
  const { open, closed } = await findRunsByName(env, home, reference);
  const tier = open.length > 0 ? open : closed;
  if (tier.length === 1) return tier[0]!;
  if (tier.length > 1) {
    throw new CliError(
      "ambiguous_run",
      `${tier.length} runs are named "${reference}": ${tier.map((record) => record.run_id).join(", ")}`,
      "name one by its run id instead",
    );
  }
  throw new CliError(
    "run_not_found",
    `no run has the id or name "${reference}" under ${runsDirectory(env, home)}`,
    "agentsurface x-runs lists the recorded runs",
  );
}

/**
 * Reconcile the registry after a workspace is released (ADR 0016). Records
 * are stamped, never removed: the record is the last thing tying a run id to
 * a session id, and the session outlives the workspace it was born in. An
 * already-stamped record is left alone, so a re-run never rewrites history.
 */
export async function stampClosedRuns(
  env: Environ,
  home: string,
  workspacePath: string,
  closedAs: "landed" | "abandoned",
): Promise<string[]> {
  const closedAt = new Date().toISOString();
  const stamped: string[] = [];
  for (const record of await listRunRecords(env, home)) {
    if (record.workspace.path !== workspacePath) continue;
    if (record.closed_at != null) continue;
    writeRunRecord(env, home, { ...record, closed_at: closedAt, closed_as: closedAs });
    stamped.push(record.run_id);
  }
  return stamped;
}

/**
 * Session ids are discovered, never assigned (ADR 0014): the run's session
 * is the store entry born in the run's workspace at or after the Placement —
 * every store carries the cwd (codex session_meta, pi header, claude's
 * in-record field), so the workspace path is the join key. Earliest birth
 * wins: a later run in the same workspace has its own later session.
 */
export async function discoverSessionId(
  record: RunRecord,
  env: Environ,
  home: string,
): Promise<string | null> {
  const store = sessionStore(record.harness, env, home);
  if (!existsSync(store.root)) return null;
  const placedAt = Date.parse(record.created_at);
  let found: { sessionId: string; bornAt: number } | null = null;
  for (const pattern of store.patternsFor("*")) {
    const glob = new Glob(pattern);
    for await (const relative of glob.scan({ cwd: store.root, onlyFiles: true })) {
      // Compressed rollouts are archived history, never a fresh session.
      if (relative.endsWith(".zst")) continue;
      const path = join(store.root, relative);
      const bornAt = birthTime(path);
      if (bornAt === null || bornAt < placedAt) continue;
      if (found !== null && bornAt >= found.bornAt) continue;
      const facts = await sessionFileFacts(record.harness, path);
      if (facts.cwd !== record.workspace.path || facts.sessionId === null) continue;
      found = { sessionId: facts.sessionId, bornAt };
    }
  }
  return found?.sessionId ?? null;
}

/** Creation time where the filesystem records it (APFS does); mtime is the
 * fallback and only ever delays discovery, never misattributes it. */
function birthTime(path: string): number | null {
  try {
    const stats = statSync(path);
    const birth = stats.birthtimeMs;
    return birth > 0 ? birth : stats.mtimeMs;
  } catch {
    return null;
  }
}

/** Backfill on first sight: discovery rewrites the record so later readers
 * (and the future steer command) get the session id for free. */
export async function resolveRun(
  env: Environ,
  home: string,
  reference: string,
): Promise<{ record: RunRecord; discovered: boolean }> {
  const record = await resolveRunReference(env, home, reference);
  if (record.session_id !== null) return { record, discovered: false };
  const sessionId = await discoverSessionId(record, env, home);
  if (sessionId === null) return { record, discovered: false };
  const updated = { ...record, session_id: sessionId };
  writeRunRecord(env, home, updated);
  return { record: updated, discovered: true };
}

/**
 * A name has to be free among open runs to be worth having (ADR 0019). It is
 * still a label rather than an identity — closed runs keep theirs, and nothing
 * is invented when one is taken — but a name two live runs answer to resolves
 * to neither, here or on the bus, so the refusal happens where a caller can
 * still choose another.
 */
export async function assertRunNameAvailable(
  env: Environ,
  home: string,
  name: string,
): Promise<void> {
  const { open } = await findRunsByName(env, home, name);
  if (open.length === 0) return;
  throw new CliError(
    "run_name_taken",
    `an open run already answers to "${name}" (${open.map((record) => record.run_id).join(", ")})`,
    "pick another --x-name, or land that run first: agentsurface x-land run:<run-id>",
  );
}

/**
 * Serialized Placements for a workspace (ADR 0020/0022). A codex session is
 * invisible outside its app-server until its first turn — no rollout file, no
 * state row, nothing on disk — so the only fact tying one to a run before it
 * speaks is the workspace it sits in. That is enough exactly while a workspace
 * holds at most one *uncorrelated* session of a harness, which is what this
 * lease buys: a second Placement into the same workspace is refused until the
 * first has had time to appear. Naming is sticky once made, so only the
 * uncorrelated window needs protecting, never the workspace's whole life.
 */
export const PLACEMENT_LEASE_MS = 60_000;

export interface PlacementLease {
  release(): void;
}

/** Both sides of every workspace comparison are resolved: a path crosses into
 * the harness as typed and comes back canonicalized. */
export function resolvedWorkspacePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function leasePath(env: Environ, home: string, workspacePath: string): string {
  const key = createHash("sha256")
    .update(resolvedWorkspacePath(workspacePath))
    .digest("hex")
    .slice(0, 32);
  return join(stateDirectory(env, home, "agentsurface"), "leases", `${key}.json`);
}

export function acquirePlacementLease(
  env: Environ,
  home: string,
  workspacePath: string,
  now: number = Date.now(),
  ttlMs: number = PLACEMENT_LEASE_MS,
): PlacementLease {
  const path = leasePath(env, home, workspacePath);
  mkdirSync(dirname(path), { recursive: true });
  // Two passes at most: the first can lose to an expired lease left by a
  // Placement that never came back, which is cleared and retried once.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(path, "wx");
      writeFileSync(
        handle,
        `${JSON.stringify({
          workspace: resolvedWorkspacePath(workspacePath),
          acquired_at: new Date(now).toISOString(),
          expires_at: new Date(now + ttlMs).toISOString(),
        })}\n`,
      );
      closeSync(handle);
      return {
        release() {
          try {
            unlinkSync(path);
          } catch {
            // Already gone (expired and taken over): nothing to release.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let expiresAt = 0;
      try {
        const held = JSON.parse(readFileSync(path, "utf8")) as { expires_at?: string };
        expiresAt = Date.parse(held.expires_at ?? "");
      } catch {
        // Unreadable lease: treat as expired rather than blocking forever.
      }
      if (Number.isFinite(expiresAt) && expiresAt > now) {
        throw new CliError(
          "placement_in_flight",
          `another Placement into ${workspacePath} is still starting; only one at a time can be told apart`,
          "retry the same command in a few seconds",
        );
      }
      try {
        unlinkSync(path);
      } catch {
        // Someone else cleared it first; the next pass takes it.
      }
    }
  }
  throw new CliError(
    "placement_in_flight",
    `could not claim a Placement slot for ${workspacePath}`,
    "retry the same command in a few seconds",
  );
}

/**
 * Which run the caller is, asked from inside it (ADR 0024). Nothing is stamped
 * for this: a worker already carries the two facts that identify it, and the
 * registry already holds both sides of the join.
 *
 * The session id is exact and is tried first — a harness that names its own
 * session leaves no room for doubt. The workspace is the fallback, for pi and
 * for any session placed before its id was discovered, and it carries the
 * ambiguity a workspace always has: two open runs of one harness there resolve
 * to neither, the same refusal a Placement lease exists to make rare.
 */
export async function resolveCallingRun(
  env: Environ,
  home: string,
  cwd: string,
  caller: { harness: HarnessName; sessionId: string } | null,
): Promise<{ record: RunRecord; matched: "session" | "workspace" }> {
  const records = await listRunRecords(env, home);
  if (caller !== null) {
    const bySession = records.find((record) => record.session_id === caller.sessionId);
    if (bySession !== undefined) return { record: bySession, matched: "session" };
  }
  const here = resolvedWorkspacePath(cwd);
  const open = records.filter(
    (record) =>
      record.closed_at == null &&
      resolvedWorkspacePath(record.workspace.path) === here &&
      (caller === null || record.harness === caller.harness),
  );
  if (open.length === 1) return { record: open[0]!, matched: "workspace" };
  if (open.length > 1) {
    throw new CliError(
      "ambiguous_run",
      `${open.length} open runs share this workspace: ${open.map((record) => record.run_id).join(", ")}`,
      "name one by its run id: agentsurface x-run <run-id>",
    );
  }
  throw new CliError(
    "not_placed",
    "this session is not a run placed on a surface",
    "agentsurface x-runs lists the placed runs",
  );
}
