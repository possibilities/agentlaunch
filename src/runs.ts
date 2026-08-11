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
  /** When the record was written — after the backend Placement returned, so
   * it postdates whatever the harness already did during Attachment. Not the
   * birth-time floor discovery scans against; that is `placed_after`. */
  created_at: string;
  /** The lower bound discovery scans a session store against (ADR 0014):
   * captured before `backend.place` is called at all, since Claude and Pi can
   * write their session file the moment their terminal starts, and that can
   * race `created_at`'s later stamp. Absent on records written before this
   * field existed, which falls back to `created_at` — the best bound those
   * records have, even though it is the one this field exists to improve on. */
  placed_after?: string | null;
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
  try {
    return await writeJsonAtomically(directory, `${record.run_id}.json`, record);
  } catch (error) {
    throw new CliError(
      "run_record_unwritable",
      `run record ${join(directory, `${record.run_id}.json`)} could not be written: ${(error as Error).message}`,
      `check that ${directory} is writable, then retry`,
    );
  }
}

/** The registry's one write primitive: a complete temp file in the target's
 * own directory, flushed, then renamed over it. Every caller wraps the failure
 * in its own code, because what could not be written is what a caller can act
 * on. */
async function writeJsonAtomically(
  directory: string,
  name: string,
  value: unknown,
): Promise<string> {
  const path = join(directory, name);
  const temp = join(directory, `.${name}.${process.pid}.${writeSequence++}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
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
    throw error;
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
 *
 * The birth-time floor is `placed_after`, not `created_at`: Claude and Pi can
 * write their session file while a terminal is still being created, which is
 * before the record — and its `created_at` — can be written at all. A record
 * from before `placed_after` existed has no better floor than `created_at`,
 * so that is its fallback.
 *
 * Both sides of the workspace join are resolved paths: the store records
 * whatever cwd the harness actually saw, and a symlinked temp directory or an
 * `/tmp` vs `/private/tmp` difference between that and the recorded Workspace
 * path must not read as two different places.
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
  const placedAt = Date.parse(record.placed_after ?? record.created_at);
  const workspacePath = resolvedWorkspacePath(record.workspace.path);
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
      if (facts.cwd === null || resolvedWorkspacePath(facts.cwd) !== workspacePath) continue;
      if (facts.sessionId === null) continue;
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

/**
 * The Placement journal: what a Placement has already done, written down
 * before it can finish. A Placement is one arrival made of several
 * resources — an account claim, a Workspace the backend created, a terminal
 * started in it — and the run record is only written once they all exist, so
 * until this journal there was no durable trace of a Placement that failed
 * halfway. Every completed phase is journaled, and the fifth state — open —
 * is the run record itself, which is why committing the record is what
 * clears the journal (ADR 0027).
 *
 * Journal state is agentsurface's own bookkeeping, like the records it sits
 * beside: nothing here crosses the surface API, and a backend is never asked
 * about it.
 */
export type PlacementPhase =
  | "reserved"
  | "account-claimed"
  | "workspace-created"
  | "terminal-created";

export interface PlacementJournal {
  run_id: string;
  phase: PlacementPhase;
  started_at: string;
  updated_at: string;
  backend: string;
  harness: HarnessName;
  name: string | null;
  /** The account the Placement claimed and the lease that claim holds — what
   * an interrupted Placement is still spending. */
  account?: { key: string | null; lease: string | null } | null;
  /** Where the Placement is being made, and whether it created it: a
   * Workspace it created and never attached is the orphan an operator has to
   * decide about, and one it merely found is not. */
  workspace?: { path: string; created: boolean } | null;
  terminal?: string | null;
  server?: string | null;
  /** Stamped where the failing process could still say so; a killed one
   * leaves the phase alone and the staleness bound speaks for it. */
  failed_at?: string | null;
  failure?: string | null;
}

/** Journals sit beside the records they become, in a directory the record
 * listing already ignores (it reads `*.json` at the top level only). */
function placingDirectory(env: Environ, home: string): string {
  return join(runsDirectory(env, home), ".placing");
}

/** The same bound the name reservations use: the longest a Placement can
 * plausibly still be in flight. Past it, a journal nobody stamped belongs to a
 * process that was killed rather than one still working. */
const PLACEMENT_STALE_MS = RESERVATION_REAP_MS;

export interface PlacementJournalWriter {
  /** Persist a phase that has completed, with what it produced. */
  record(phase: PlacementPhase, facts: Partial<PlacementJournal>): Promise<void>;
  /** The Placement failed where we can still say so. The journal is kept when
   * it names something that now exists without a run, and dropped when it
   * names nothing — there is no compensation to describe. */
  interrupt(error: unknown): Promise<void>;
  /** The run record is written: the Placement is open, and the journal has
   * nothing left to say. */
  commit(): Promise<void>;
}

/**
 * Nothing is written until the first phase completes, so a Placement refused
 * before it starts leaves no trace to explain.
 */
export function openPlacementJournal(
  env: Environ,
  home: string,
  seed: Pick<PlacementJournal, "run_id" | "backend" | "harness" | "name">,
): PlacementJournalWriter {
  const directory = placingDirectory(env, home);
  const file = `${seed.run_id}.json`;
  const startedAt = new Date().toISOString();
  let journal: PlacementJournal = {
    ...seed,
    phase: "reserved",
    started_at: startedAt,
    updated_at: startedAt,
  };
  let written = false;
  const flush = async (): Promise<void> => {
    try {
      await writeJsonAtomically(directory, file, journal);
      written = true;
    } catch (error) {
      throw new CliError(
        "placement_journal_unwritable",
        `placement journal ${join(directory, file)} could not be written: ${(error as Error).message}`,
        `check that ${directory} is writable, then retry`,
      );
    }
  };
  const drop = (): void => {
    try {
      unlinkSync(join(directory, file));
    } catch {
      // Never written, or already cleared.
    }
  };
  return {
    async record(phase, facts) {
      journal = { ...journal, ...facts, phase, updated_at: new Date().toISOString() };
      await flush();
    },
    async interrupt(error) {
      if (!written) return;
      if (!placementLeftSomething(journal)) {
        drop();
        return;
      }
      journal = {
        ...journal,
        updated_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        failure: error instanceof Error ? error.message : String(error),
      };
      await flush().catch(() => {
        // The journal we already wrote still names the phase and the
        // resources; losing the stamp only costs the reason.
      });
    },
    async commit() {
      drop();
    },
  };
}

/** Whether an interrupted Placement left anything behind that outlives it. A
 * Workspace it created or a terminal it started has no run to belong to; one
 * it merely found belongs to whatever it belonged to before. */
function placementLeftSomething(journal: PlacementJournal): boolean {
  return journal.workspace?.created === true || journal.terminal != null;
}

/**
 * Placements that were interrupted between resources: stamped by their own
 * failing process, or left behind by one that was killed and is now past the
 * bound. A Placement still in flight in another process is neither, and
 * reporting it as interrupted would be a lie.
 *
 * Nothing is compensated automatically. Releasing a Workspace can discard
 * work — that is the operator's decision (and x-land's job), not a reader's —
 * so this names what exists and stops there.
 */
export async function interruptedPlacements(
  env: Environ,
  home: string,
): Promise<PlacementJournal[]> {
  const directory = placingDirectory(env, home);
  if (!existsSync(directory)) return [];
  const journals: PlacementJournal[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(directory, entry);
    let journal: PlacementJournal;
    try {
      journal = (await Bun.file(path).json()) as PlacementJournal;
    } catch {
      // A journal is written atomically like a record, so an unreadable one
      // is debris rather than a Placement; the records are the registry.
      continue;
    }
    if (typeof journal?.run_id !== "string" || typeof journal.phase !== "string") continue;
    const stale =
      Date.now() - Date.parse(journal.updated_at ?? journal.started_at) > PLACEMENT_STALE_MS;
    if (journal.failed_at == null && !stale) continue;
    journals.push(journal);
  }
  journals.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return journals;
}

/** Where an interrupted Placement's journal lives, so the operator who
 * finishes the compensation can clear it. */
export function placementJournalPath(env: Environ, home: string, runId: string): string {
  return join(placingDirectory(env, home), `${runId}.json`);
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

/** What `sockaddr_un.sun_path` holds, under the smallest of the platforms we
 * run on (macOS 104, Linux 108) with room for the terminator. */
const SOCKET_PATH_LIMIT = 100;

/**
 * The Run server's socket (ADR 0026): one per codex Placement, named by the
 * run id so record and socket point at each other. A state directory deep
 * enough to blow the `sockaddr_un` budget (temp HOMEs in tests do) hashes the
 * id instead — the record's `server.socket` is the authoritative spelling
 * either way. When even the hashed name does not fit, the directory itself
 * spends the budget and no name can help: the Placement is refused here,
 * before anything is created, rather than composing a socket codex-swap could
 * only fail to bind.
 */
export function runServerListenUrl(env: Environ, home: string, runId: string): string {
  const directory = join(stateDirectory(env, home, "agentsurface"), "servers");
  const full = join(directory, `${runId}.sock`);
  const short = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  const path =
    Buffer.byteLength(full) <= SOCKET_PATH_LIMIT ? full : join(directory, `${short}.sock`);
  const size = Buffer.byteLength(path);
  if (size > SOCKET_PATH_LIMIT) {
    throw new CliError(
      "run_server_path_too_long",
      `${directory} leaves no room for a Run server socket: ${size} bytes where a unix socket path allows ${SOCKET_PATH_LIMIT}`,
      "point XDG_STATE_HOME at a shorter absolute directory, or place the run from a shorter home",
    );
  }
  // The server binding this socket is codex-swap's, which treats the listen
  // path as caller-owned — so the caller's directory has to exist.
  mkdirSync(directory, { recursive: true });
  return `unix://${path}`;
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
 * session leaves no room for doubt — but only against an open record of the
 * caller's own harness, the same two conditions the workspace tier already
 * enforces: a session id is per-harness (nothing stops a resumed session
 * reusing one this registry also holds against a closed or foreign-harness
 * record), and a closed run's Workspace is already gone, so matching it here
 * would pass the gate on history rather than presence. The workspace is the
 * fallback, for pi and for any session placed before its id was discovered,
 * and it carries the ambiguity a workspace always has: two open runs of one
 * harness there resolve to neither, the same refusal a Placement lease exists
 * to make rare.
 */
export async function resolveCallingRun(
  env: Environ,
  home: string,
  cwd: string,
  caller: { harness: HarnessName; sessionId: string } | null,
): Promise<{ record: RunRecord; matched: "session" | "workspace" }> {
  const records = await listRunRecords(env, home);
  // Newest first, so this is also the most recent record the session id ever
  // named — kept only to enrich a later refusal, never to match on its own.
  let staleSessionMatch: RunRecord | null = null;
  if (caller !== null) {
    const bySession = records.filter((record) => record.session_id === caller.sessionId);
    const open = bySession.find(
      (record) => record.closed_at == null && record.harness === caller.harness,
    );
    if (open !== undefined) return { record: open, matched: "session" };
    staleSessionMatch = bySession[0] ?? null;
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
  // "Never placed" and "placed once, not anymore" are different answers —
  // the session id matched something, just nothing this gate can pass.
  const history =
    staleSessionMatch === null
      ? ""
      : staleSessionMatch.closed_at != null
        ? ` — this session id was run:${staleSessionMatch.run_id}, closed ${staleSessionMatch.closed_at}`
        : ` — this session id was run:${staleSessionMatch.run_id} on ${staleSessionMatch.harness}, not ${caller?.harness}`;
  throw new CliError(
    "not_placed",
    `this session is not a run placed on a surface${history}`,
    "agentsurface x-runs lists the placed runs",
  );
}
