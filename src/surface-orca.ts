import { basename } from "node:path";
import { CliError } from "./errors.ts";
import type { Narrator } from "./narrate.ts";
import { shellLine } from "./narrate.ts";
import type { Environ } from "./paths.ts";
import { spawnBounded } from "./subprocess.ts";
import type {
  Attachment,
  BackendHealth,
  Placement,
  PlaceRequest,
  Released,
  ReleaseRequest,
  SurfaceBackend,
  Survey,
  SurveyRequest,
  WorkspaceIntent,
} from "./surface.ts";

/**
 * The Orca backend: everything Orca-shaped lives here and nowhere else
 * (ADR 0012). The adapter speaks Orca's own CLI (`orca … --json`, verified
 * against 1.4.177): worktrees implement workspaces, `repo add` implements
 * project registration, and a runtime-issued terminal handle is the placed
 * terminal's address. Selector spellings (`path:`, `id:`, `name:`) are
 * Orca's; the core never sees them.
 */

const START_RECOVERY = "start Orca: `orca open` (or `orca serve` for a headless runtime)";

export const orcaBackend: SurfaceBackend = {
  name: "orca",

  async place(request: PlaceRequest): Promise<Placement> {
    await assertReachable(request.env, request.narrator);
    const resolved = await resolveWorkspace(request);
    let anchored: string[] = [];
    if (!request.dryRun && resolved.workspace.path !== null) {
      anchored = (await request.prepare?.(resolved.workspace.path)) ?? [];
    }
    const terminal = request.dryRun
      ? null
      : await createTerminal(request, resolved.workspace.id, resolved.workspace.path, anchored);
    return {
      backend: "orca",
      project: resolved.project,
      workspace: resolved.workspace,
      terminal,
      provenance: resolved.provenance,
    };
  },

  async survey(request: SurveyRequest): Promise<Survey> {
    await assertReachable(request.env, request.narrator);
    const shown = await orcaTry(request.env, request.narrator, [
      "worktree",
      "show",
      "--worktree",
      request.selector,
    ]);
    const record = objectField(shown, "worktree");
    const worktree = readWorktree(record);
    if (record === null || worktree === null) {
      throw new CliError(
        "workspace_not_found",
        `no orca workspace matches "${request.selector}"`,
        "orca worktree list names them; orca selectors are name:, path:, branch:, id:",
      );
    }
    // The base ref is repo policy rather than a guess, and only the repo
    // record carries it.
    const repoId = stringField(record, "repoId");
    let baseRef: string | null = null;
    if (repoId !== null) {
      const repo = await orcaTry(request.env, request.narrator, [
        "repo",
        "show",
        "--repo",
        `id:${repoId}`,
      ]);
      baseRef = stringField(objectField(repo, "repo"), "worktreeBaseRef");
    }
    const children = record["childWorktreeIds"];
    return {
      backend: "orca",
      workspace: worktree,
      baseRef,
      primary: record["isMainWorktree"] === true,
      children: Array.isArray(children) ? children.length : 0,
      attachments: await listTerminals(request, request.selector),
    };
  },

  async release(request: ReleaseRequest): Promise<Released> {
    await assertReachable(request.env, request.narrator);
    const stopped: string[] = [];
    if (request.stopAttachments) {
      const live = (await listTerminals(request, request.selector)).filter(
        (attachment) => attachment.live,
      );
      if (live.length > 0) {
        await orcaJson(request.env, request.narrator, [
          "terminal",
          "stop",
          "--worktree",
          request.selector,
        ]);
        stopped.push(...live.map((attachment) => attachment.handle));
      }
    }
    // Never --force: Orca's own force force-removes the checkout, which
    // discards uncommitted work. Everything that would need forcing was a
    // blocker the caller already cleared, so a plain rm must succeed here.
    await orcaJson(request.env, request.narrator, [
      "worktree",
      "rm",
      "--worktree",
      request.selector,
    ]);
    return {
      stopped,
      removed: true,
      detail: stopped.length > 0 ? `stopped ${stopped.length} terminal(s)` : "no live terminals",
    };
  },

  async doctor(env: Environ): Promise<BackendHealth> {
    if (Bun.which("orca") === null) return { reachable: false, detail: "orca is not on PATH" };
    try {
      const status = await orcaJson(env, null, ["status"]);
      const runtime = objectField(status, "runtime");
      const reachable = runtime?.["reachable"] === true;
      const version = stringField(runtime, "appVersion");
      const state = stringField(runtime, "state");
      return {
        reachable,
        detail: reachable
          ? `runtime ${state ?? "ready"} · v${version ?? "?"}`
          : "runtime not reachable",
      };
    } catch (error) {
      return { reachable: false, detail: (error as Error).message };
    }
  },
};

interface ResolvedWorkspace {
  project: { name: string; created: boolean } | null;
  workspace: { name: string; path: string | null; id: string | null; created: boolean };
  provenance: { recorded: boolean; detail: string };
}

/** Orca's lineage is set at creation, so an existing workspace keeps whatever
 * it already had — placing a run in it is not a reason to rewrite it. */
const NOT_CREATED = {
  recorded: false,
  detail: "workspace already exists · lineage unchanged",
};

async function resolveWorkspace(request: PlaceRequest): Promise<ResolvedWorkspace> {
  const { intent } = request;
  switch (intent.kind) {
    case "current": {
      const worktree =
        (await findWorktree(request, `path:${intent.path}`)) ??
        (await findWorktreeByToplevel(request, intent.path));
      if (worktree === null) {
        throw new CliError(
          "workspace_not_found",
          `${intent.path} is not inside an orca workspace`,
          "pass --x-workspace <selector> to pick one, or --x-new-workspace <name> to create one",
        );
      }
      return { project: null, workspace: { ...worktree, created: false }, provenance: NOT_CREATED };
    }
    case "existing": {
      const worktree = await findWorktree(request, intent.selector);
      if (worktree === null) {
        throw new CliError(
          "workspace_not_found",
          `no orca workspace matches "${intent.selector}"`,
          "orca worktree list names them; orca selectors are name:, path:, branch:, id:",
        );
      }
      return { project: null, workspace: { ...worktree, created: false }, provenance: NOT_CREATED };
    }
    case "new":
      return await createWorkspace(request, intent);
  }
}

/** Orca's flavor of provenance: an arbitrary, reassignable lineage link
 * between worktrees, decoupled from git. Left unsaid, `worktree create`
 * infers a parent from `ORCA_WORKTREE_ID` in the calling terminal — which is
 * why "none" has to be spelled out (ADR 0015). A run's own workspace id is
 * Orca's only when Orca recorded it; otherwise the path still identifies the
 * checkout, since an Orca worktree is one. */
function parentArgs(provenance: PlaceRequest["provenance"]): { args: string[]; detail: string } {
  switch (provenance.kind) {
    case "none":
      return { args: ["--no-parent"], detail: "none" };
    case "selector":
      return {
        args: ["--parent-worktree", provenance.selector],
        detail: provenance.selector,
      };
    case "run": {
      const selector =
        provenance.backend === "orca" && provenance.workspace.id !== null
          ? `id:${provenance.workspace.id}`
          : `path:${provenance.workspace.path}`;
      return {
        args: ["--parent-worktree", selector],
        detail: `run ${provenance.runId} · ${provenance.workspace.name}`,
      };
    }
  }
}

/** Ensure, then create (ADR 0013): the repo the new workspace belongs to is
 * registered on demand — from --x-project when given, else from the git
 * toplevel of the anchoring path. Dry runs stop at reporting what would be. */
async function createWorkspace(
  request: PlaceRequest,
  intent: Extract<WorkspaceIntent, { kind: "new" }>,
): Promise<ResolvedWorkspace> {
  const repo = await ensureRepo(request, intent);
  const parent = parentArgs(request.provenance);
  if (request.dryRun || repo.id === null) {
    return {
      project: { name: repo.name, created: repo.created },
      workspace: { name: intent.name, path: null, id: null, created: false },
      provenance: { recorded: false, detail: parent.detail },
    };
  }
  const created = await orcaJson(request.env, request.narrator, [
    "worktree",
    "create",
    "--name",
    intent.name,
    "--repo",
    `id:${repo.id}`,
    ...parent.args,
  ]);
  const direct = readWorktree(objectField(created, "worktree"));
  const worktree = direct ?? (await findWorktree(request, `name:${intent.name}`));
  if (worktree === null) {
    throw new CliError(
      "surface_backend",
      `orca created worktree "${intent.name}" but did not report it back`,
      `orca worktree list --json should name it; then pass --x-workspace name:${intent.name}`,
    );
  }
  const named = await labelWorkspace(request, worktree);
  return {
    project: { name: repo.name, created: repo.created },
    workspace: { ...named, created: true },
    provenance: { recorded: true, detail: parent.detail },
  };
}

/**
 * A run name is what Orca's card should read. `worktree create` takes only
 * the checkout's name — which is also its directory and branch, so it stays
 * the slug the operator typed — while `worktree set --display-name` is the
 * only setter for the label the app shows. Orca stores both verbatim, so the
 * name reaches the card exactly as typed. Only a workspace this placement
 * created is labelled: relabelling one that already existed would rename
 * somebody else's card as a side effect of placing a run in it.
 */
async function labelWorkspace(
  request: PlaceRequest,
  worktree: { name: string; path: string; id: string | null },
): Promise<{ name: string; path: string; id: string | null }> {
  if (request.name === null) return worktree;
  await orcaJson(request.env, request.narrator, [
    "worktree",
    "set",
    "--worktree",
    worktree.id !== null ? `id:${worktree.id}` : `path:${worktree.path}`,
    "--display-name",
    request.name,
  ]);
  request.narrator.detail("name", `${request.name} · orca display name`);
  return { ...worktree, name: request.name };
}

interface EnsuredRepo {
  /** Null only on a dry run that would have registered. */
  id: string | null;
  name: string;
  created: boolean;
}

async function ensureRepo(
  request: PlaceRequest,
  intent: Extract<WorkspaceIntent, { kind: "new" }>,
): Promise<EnsuredRepo> {
  const repos = await listRepos(request);
  if (intent.project !== null && !intent.project.startsWith("path:")) {
    const match = repos.find((repo) => repo.name === intent.project || repo.id === intent.project);
    if (match === undefined) {
      throw new CliError(
        "project_not_found",
        `no registered orca project matches "${intent.project}"`,
        "only a path can be registered on demand: pass --x-project path:<repo> (orca repo list names the rest)",
      );
    }
    return { ...match, created: false };
  }
  const root =
    intent.project !== null ? intent.project.slice("path:".length) : await gitToplevel(intent.path);
  const existing = repos.find((repo) => repo.path === root);
  if (existing !== undefined) return { ...existing, created: false };
  if (request.dryRun) return { id: null, name: basename(root), created: true };
  await orcaJson(request.env, request.narrator, ["repo", "add", "--path", root]);
  const registered = (await listRepos(request)).find((repo) => repo.path === root);
  if (registered === undefined) {
    throw new CliError(
      "surface_backend",
      `orca repo add accepted ${root} but the repo did not appear in orca repo list`,
      "run `orca repo list --json` to inspect",
    );
  }
  return { ...registered, created: true };
}

async function createTerminal(
  request: PlaceRequest,
  worktreeId: string | null,
  worktreePath: string | null,
  anchored: string[],
): Promise<string> {
  const selector = worktreeId !== null ? `id:${worktreeId}` : `path:${worktreePath}`;
  // The sentinel marks the placed command as already-routed (ADR 0004), and
  // the `env` spelling holds whether Orca runs it through a shell or not.
  // Anchoring arguments go last: the tail is the harness's own argv, since a
  // balancing wrapper only ever contributes a head and a `--` (ADR 0023).
  const command = shellLine(["env", "AGENTSURFACE_LAUNCH=1", ...request.spec.command, ...anchored]);
  const created = await orcaJson(request.env, request.narrator, [
    "terminal",
    "create",
    "--worktree",
    selector,
    "--command",
    command,
    "--title",
    request.title,
  ]);
  const handle = stringField(objectField(created, "terminal"), "handle");
  if (handle === null) {
    throw new CliError(
      "surface_backend",
      "orca terminal create reported no terminal handle",
      "run `orca terminal list --json` to find the placed terminal",
    );
  }
  return handle;
}

// ---------------------------------------------------------------------------
// Orca lookups

interface OrcaWorktree {
  name: string;
  path: string;
  id: string;
}

/** Every Orca lookup needs only these two, and all three request types carry
 * them — so the helpers below serve place, survey, and release alike. */
interface OrcaCall {
  env: Environ;
  narrator: Narrator;
}

async function findWorktree(request: OrcaCall, selector: string): Promise<OrcaWorktree | null> {
  const result = await orcaTry(request.env, request.narrator, [
    "worktree",
    "show",
    "--worktree",
    selector,
  ]);
  return readWorktree(objectField(result, "worktree"));
}

/** A path inside a workspace resolves via its git toplevel — a worktree is
 * a checkout, so the repository root is the workspace path. */
async function findWorktreeByToplevel(
  request: OrcaCall,
  path: string,
): Promise<OrcaWorktree | null> {
  let toplevel: string;
  try {
    toplevel = await gitToplevel(path);
  } catch {
    return null;
  }
  if (toplevel === path) return null;
  return await findWorktree(request, `path:${toplevel}`);
}

function readWorktree(record: Record<string, unknown> | null): OrcaWorktree | null {
  if (record === null) return null;
  const id = stringField(record, "id");
  const path = stringField(record, "path");
  if (id === null || path === null) return null;
  return { id, path, name: stringField(record, "displayName") ?? basename(path) };
}

/** Orca runs agents in terminals, so a terminal is what a workspace has
 * attached. `connected` is its own word for still-live. */
async function listTerminals(request: OrcaCall, selector: string): Promise<Attachment[]> {
  const result = await orcaTry(request.env, request.narrator, [
    "terminal",
    "list",
    "--worktree",
    selector,
  ]);
  const terminals = result?.["terminals"];
  if (!Array.isArray(terminals)) return [];
  const out: Attachment[] = [];
  for (const entry of terminals) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const handle = stringField(record, "handle");
    if (handle === null) continue;
    out.push({
      handle,
      title: stringField(record, "title") ?? handle,
      live: record["connected"] === true,
    });
  }
  return out;
}

interface OrcaRepo {
  id: string;
  name: string;
  path: string;
}

async function listRepos(request: OrcaCall): Promise<OrcaRepo[]> {
  const result = await orcaJson(request.env, request.narrator, ["repo", "list"]);
  const repos = result["repos"];
  if (!Array.isArray(repos)) return [];
  const out: OrcaRepo[] = [];
  for (const entry of repos) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = stringField(record, "id");
    const path = stringField(record, "path");
    if (id === null || path === null) continue;
    out.push({ id, path, name: stringField(record, "displayName") ?? basename(path) });
  }
  return out;
}

/** Generous enough that a slow `rev-parse` on a large repo never
 * false-trips (S10); a git process still alive past this is stuck. */
const GIT_TIMEOUT_MS = 60_000;

async function gitToplevel(path: string): Promise<string> {
  const { stdout, code } = await spawnBounded({
    cmd: ["git", "-C", path, "rev-parse", "--show-toplevel"],
    env: process.env,
    timeoutMs: GIT_TIMEOUT_MS,
    label: `git -C ${path} rev-parse --show-toplevel`,
  });
  const toplevel = stdout.trim();
  if (code !== 0 || toplevel === "") {
    throw new CliError(
      "project_not_found",
      `${path} is not inside a git repository, so no project can be inferred`,
      "pass --x-project path:<repo> to name one",
    );
  }
  return toplevel;
}

// ---------------------------------------------------------------------------
// plumbing

async function assertReachable(env: Environ, narrator: Narrator): Promise<void> {
  const status = await orcaJson(env, narrator, ["status"]);
  const runtime = objectField(status, "runtime");
  if (runtime?.["reachable"] !== true) {
    throw new CliError("surface_unreachable", "the orca runtime is not reachable", START_RECOVERY);
  }
}

/** One orca CLI call: argv plus --json, the result object out. Refusals are
 * loud (ADR 0013 mirrors the balance doctrine): a failed call is a domain
 * error, never a silent fall-back to running in this terminal. */
async function orcaJson(
  env: Environ,
  narrator: Narrator | null,
  args: string[],
): Promise<Record<string, unknown>> {
  const outcome = await runOrca(env, narrator, args);
  if (outcome.ok) return outcome.result;
  throw new CliError(
    "surface_backend",
    `orca ${args.join(" ")} failed: ${outcome.detail}`,
    outcome.reachableFault ? START_RECOVERY : "rerun with --x-verbose to see each orca call",
  );
}

/**
 * A lookup that may legitimately miss (S11): null only for Orca's own typed
 * not-found codes (`selector_not_found`, `repo_not_found` — verified against
 * live orca 1.4.177), never for a daemon fault, permission error, or
 * malformed response, which would otherwise read as "not found" and send
 * control flow down a create path. Everything else propagates as the same
 * domain error `orcaJson` raises.
 */
async function orcaTry(
  env: Environ,
  narrator: Narrator | null,
  args: string[],
): Promise<Record<string, unknown> | null> {
  const outcome = await runOrca(env, narrator, args);
  if (outcome.ok) return outcome.result;
  if (outcome.notFound) return null;
  throw new CliError(
    outcome.reachableFault ? "surface_unreachable" : "surface_backend",
    `orca ${args.join(" ")} failed: ${outcome.detail}`,
    outcome.reachableFault ? START_RECOVERY : "rerun with --x-verbose to see each orca call",
  );
}

/** Generous enough that a slow orca call never false-trips (S10); a call
 * still running past this is treated as stuck rather than merely slow. */
const ORCA_TIMEOUT_MS = 30_000;

/** Orca's own vocabulary for "the selector matched nothing" — confirmed
 * live: `orca worktree show --worktree name:<missing>` answers
 * `selector_not_found`, `orca repo show --repo id:<missing>` answers
 * `repo_not_found`. Matched by suffix so either code (and any sibling Orca
 * adds later in the same family) is recognized without enumerating them. */
function isNotFoundCode(code: string | null): boolean {
  return code?.endsWith("_not_found") ?? false;
}

type OrcaOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; detail: string; reachableFault: boolean; notFound: boolean };

async function runOrca(
  env: Environ,
  narrator: Narrator | null,
  args: string[],
): Promise<OrcaOutcome> {
  const bin = Bun.which("orca");
  if (bin === null) {
    throw new CliError(
      "surface_unavailable",
      "orca is not on PATH; the orca surface backend needs its CLI",
      "install Orca, or drop --x-surface to launch in this terminal",
    );
  }
  const argv = [...args, "--json"];
  narrator?.detail("orca", shellLine(["orca", ...argv]));
  const { stdout, stderr, code } = await spawnBounded({
    cmd: [bin, ...argv],
    env,
    timeoutMs: ORCA_TIMEOUT_MS,
    label: `orca ${args.join(" ")}`,
  });
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (code === 0 && body !== null && body["ok"] === true) {
    const result = objectField(body, "result");
    return { ok: true, result: result ?? {} };
  }
  const error = body?.["error"];
  const errorRecord =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
  const errorCode = stringField(errorRecord, "code");
  const detail =
    stringField(errorRecord, "message") ??
    (typeof error === "string" ? error : null) ??
    firstLine(stderr) ??
    `exit ${code}`;
  return {
    ok: false,
    detail,
    reachableFault: /runtime|reachable|connect/i.test(detail),
    notFound: isNotFoundCode(errorCode),
  };
}

function objectField(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const value = record?.[key];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstLine(text: string): string | null {
  const line = text.split("\n", 1)[0]?.trim();
  return line !== undefined && line.length > 0 ? line : null;
}
