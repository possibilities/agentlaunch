import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
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
  /** The run's own app-server (codex placements, ADR 0026): the dedicated
   * socket its session attaches through, which is the run's identity channel
   * — the one thread on it can only be this run's session. Absent on other
   * harnesses and on records written before run servers existed. */
  server?: { socket: string } | null;
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

/** Distinguishes the temp files of writers racing on one record; the exclusive
 * create is what makes a collision an error rather than a lost write. */
let writeSequence = 0;

/**
 * One record write, awaited and atomic. Awaited because a caller that returns
 * — or exits — before the bytes land hands back a run id whose record never
 * existed. Atomic because a record is rewritten in place (session backfill,
 * close stamping), and a reader has to see either the whole previous record or
 * the whole next one: the temp file is completed and flushed in the same
 * directory, then renamed over the target, since rename is only atomic within
 * one filesystem. Temp files are named out of the `*.json` space, so a write
 * killed mid-flight leaves litter rather than a half-run.
 */
export async function writeRunRecord(
  env: Environ,
  home: string,
  record: RunRecord,
): Promise<string> {
  const directory = runsDirectory(env, home);
  const path = join(directory, `${record.run_id}.json`);
  const temp = join(directory, `.${record.run_id}.${process.pid}.${writeSequence++}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already renamed into place.
    }
    throw new CliError(
      "run_record_unwritable",
      `run record ${path} could not be written: ${(error as Error).message}`,
      `check that ${directory} is writable, then retry`,
    );
  }
  return path;
}

/** A file we own that does not parse as a record is corruption, not a foreign
 * file: writes are atomic, so nothing else can produce one. */
function corruptRecord(path: string, detail: string): CliError {
  return new CliError(
    "run_registry_corrupt",
    `${path} ${detail} — the run registry is corrupt`,
    `move it aside and retry: mv ${path} ${path}.corrupt`,
  );
}

/** The fields the registry itself joins on. Everything else is optional by
 * design: a record outlives the version that wrote it. */
function assertRunRecord(path: string, value: unknown): RunRecord {
  const record = value as RunRecord | null;
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.run_id !== "string" ||
    typeof record.created_at !== "string" ||
    typeof record.workspace?.path !== "string"
  ) {
    throw corruptRecord(path, "is not a run record");
  }
  return record;
}

async function loadRunRecord(path: string): Promise<RunRecord> {
  let parsed: unknown;
  try {
    parsed = await Bun.file(path).json();
  } catch (error) {
    throw corruptRecord(path, `is not readable JSON (${(error as Error).message})`);
  }
  return assertRunRecord(path, parsed);
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
  return await loadRunRecord(path);
}

/** Newest first — records are tiny and the directory is flat. */
export async function listRunRecords(env: Environ, home: string): Promise<RunRecord[]> {
  const directory = runsDirectory(env, home);
  if (!existsSync(directory)) return [];
  const records: RunRecord[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    records.push(await loadRunRecord(join(directory, entry)));
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
  const serversDirectory = join(stateDirectory(env, home, "agentsurface"), "servers");
  for (const record of await listRunRecords(env, home)) {
    if (record.workspace.path !== workspacePath) continue;
    if (record.closed_at != null) continue;
    await writeRunRecord(env, home, { ...record, closed_at: closedAt, closed_as: closedAs });
    // The record is stamped first: a closed record frees the name on its own
    // (ADR 0019), so a release that never happens is stale litter, while a
    // release before the stamp would free a name the run still holds.
    if (typeof record.name === "string") {
      await releaseRunName(env, home, record.name, record.run_id);
    }
    // The run's server dies with its terminal, but a hard kill can skip the
    // unlink; a closed run's socket file is inert either way, so it goes.
    // Only ever a path under our own servers directory.
    const socket = record.server?.socket;
    if (typeof socket === "string" && socket.startsWith("unix://")) {
      const path = socket.slice("unix://".length);
      if (path.startsWith(`${serversDirectory}/`)) {
        try {
          unlinkSync(path);
        } catch {
          // Already gone — the clean-shutdown path unlinked it.
        }
      }
    }
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
  // A run with its own app-server needs no store scan: the one thread on its
  // socket IS the session, visible from the moment the TUI attaches — before
  // any turn writes anything to disk. A dead or empty socket (run ended, TUI
  // not yet attached) falls through to the store scan below.
  if (record.server?.socket !== undefined && record.server.socket !== null) {
    const fromServer = await sessionIdFromRunServer(env, record.server.socket);
    if (fromServer !== null) return fromServer;
  }
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
  await writeRunRecord(env, home, updated);
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
  const { open: openRuns } = await findRunsByName(env, home, name);
  if (openRuns.length === 0) return;
  throw nameTaken(
    name,
    `an open run already answers to "${name}" (${openRuns.map((record) => record.run_id).join(", ")})`,
  );
}

function nameTaken(name: string, message: string): CliError {
  return new CliError(
    "run_name_taken",
    message,
    [
      `pick another --x-name than "${name}",`,
      "or land the run holding it: agentsurface x-land run:<run-id>",
    ].join(" "),
  );
}

/**
 * A reservation whose Placement neither committed a record nor released it —
 * a crash between the two — stops being a claim after this. The bound is the
 * longest a Placement can plausibly be in flight: registering a project,
 * creating a workspace, and creating a terminal are backend round trips, and
 * a slow one is seconds, not minutes. Only an orphan is reaped: a reservation
 * whose run has a record is judged by that record, however old it is.
 */
const RESERVATION_REAP_MS = 10 * 60_000;

interface NameReservation {
  name: string;
  run_id: string;
  created_at: string;
}

/** Reservations sit beside the records they become, in one directory the
 * record listing already ignores (it reads `*.json` at the top level only). */
function namesDirectory(env: Environ, home: string): string {
  return join(runsDirectory(env, home), ".names");
}

/** Keyed by digest because a run name is free text (ADR 0017) and a file name
 * is not: the key has to be injective and path-literal, and the name itself is
 * inside the file for anyone reading the directory. */
function reservationPath(env: Environ, home: string, name: string): string {
  const key = createHash("sha256").update(name).digest("hex").slice(0, 32);
  return join(namesDirectory(env, home), `${key}.json`);
}

async function readReservation(path: string): Promise<NameReservation | null> {
  try {
    const value = (await Bun.file(path).json()) as NameReservation;
    return typeof value?.run_id === "string" ? value : null;
  } catch {
    return null;
  }
}

function olderThanReapBound(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > RESERVATION_REAP_MS;
  } catch {
    return true;
  }
}

/** Exclusive create is the whole mechanism: the filesystem picks the winner. */
async function claimReservation(path: string, body: string): Promise<boolean> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new CliError(
      "run_name_unreservable",
      `run name reservation ${path} could not be written: ${(error as Error).message}`,
      `check that ${join(path, "..")} is writable, then retry`,
    );
  }
}

async function reservationHolds(
  env: Environ,
  home: string,
  path: string,
  name: string,
): Promise<CliError | null> {
  const holder = await readReservation(path);
  if (holder === null) {
    // A reservation created but not written: a crash inside the claim itself.
    return olderThanReapBound(path)
      ? null
      : nameTaken(name, `a Placement in progress reserved "${name}"`);
  }
  const records = await listRunRecords(env, home);
  const record = records.find((candidate) => candidate.run_id === holder.run_id);
  if (record === undefined) {
    return olderThanReapBound(path)
      ? null
      : nameTaken(name, `a Placement in progress reserved "${name}" (${holder.run_id})`);
  }
  // A closed run's name is free again (ADR 0019); the reservation outlived its
  // release, which is compensation this reap finishes.
  if (record.closed_at != null) return null;
  return nameTaken(name, `an open run already answers to "${name}" (${holder.run_id})`);
}

/**
 * Take the name before the backend is asked for anything (ADR 0019). The open
 * records remain the truth about names committed runs hold — this covers only
 * the window between that check and the record, where two parallel Placements
 * would otherwise both pass it and both go live with one name, which is also
 * one agentbus routing handle. Tied to the minted run id so the claim can be
 * released by exactly the run that made it.
 */
export async function reserveRunName(
  env: Environ,
  home: string,
  name: string,
  runId: string,
): Promise<void> {
  const path = reservationPath(env, home, name);
  mkdirSync(namesDirectory(env, home), { recursive: true });
  const body = `${JSON.stringify({ name, run_id: runId, created_at: new Date().toISOString() } satisfies NameReservation)}\n`;
  if (await claimReservation(path, body)) return;
  const refusal = await reservationHolds(env, home, path, name);
  if (refusal !== null) throw refusal;
  try {
    unlinkSync(path);
  } catch {
    // Another caller reaped the same stale reservation; the retry decides.
  }
  if (await claimReservation(path, body)) return;
  throw nameTaken(name, `another Placement took "${name}" first`);
}

/** Compensation, called on a failed Placement and on close: only the run that
 * holds the reservation may drop it, so a reused name's new owner survives a
 * late release from the old one. */
export async function releaseRunName(
  env: Environ,
  home: string,
  name: string,
  runId: string,
): Promise<void> {
  const path = reservationPath(env, home, name);
  const holder = await readReservation(path);
  if (holder === null || holder.run_id !== runId) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone: released twice, or reaped as stale.
  }
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

/**
 * The Run server's socket (ADR 0026): one per codex Placement, named by the
 * run id so record and socket point at each other. `sockaddr_un` allows about
 * 100 bytes; a state directory deep enough to blow that budget (temp HOMEs in
 * tests do) hashes the id instead — the record's `server.socket` is the
 * authoritative spelling either way.
 */
export function runServerListenUrl(env: Environ, home: string, runId: string): string {
  const directory = join(stateDirectory(env, home, "agentsurface"), "servers");
  // The server binding this socket is codex-swap's, which treats the listen
  // path as caller-owned — so the caller's directory has to exist.
  mkdirSync(directory, { recursive: true });
  const full = join(directory, `${runId}.sock`);
  if (Buffer.byteLength(full) <= 100) return `unix://${full}`;
  const short = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return `unix://${join(directory, `${short}.sock`)}`;
}

/**
 * Asks a run's own app-server which thread it holds. Exactly one answer is an
 * identity — the server is exclusive to this run — and anything else is null:
 * zero threads means the TUI has not attached yet, an unreachable socket
 * means the run ended, and two threads means the server is not the exclusive
 * one the record claims, which is a reason to refuse, never to guess.
 */
async function sessionIdFromRunServer(env: Environ, listenUrl: string): Promise<string | null> {
  const swap = Bun.which("codex-swap");
  if (swap === null) return null;
  try {
    const child = Bun.spawn([swap, "app-server", "threads", "--listen", listenUrl, "--json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: env as Record<string, string>,
    });
    const timeout = setTimeout(() => child.kill(), 15_000);
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    clearTimeout(timeout);
    if (code !== 0) return null;
    const body = JSON.parse(stdout) as {
      data?: { threads?: Array<{ id?: unknown }> };
    };
    const threads = body.data?.threads ?? [];
    if (threads.length !== 1) return null;
    const id = threads[0]?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
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
