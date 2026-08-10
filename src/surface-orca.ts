import { basename } from "node:path";
import { CliError } from "./errors.ts";
import type { Narrator } from "./narrate.ts";
import { shellLine } from "./narrate.ts";
import type { Environ } from "./paths.ts";
import type {
  BackendHealth,
  Landing,
  LandRequest,
  SurfaceBackend,
  WorkspaceIntent,
} from "./surface.ts";

/**
 * The Orca backend: everything Orca-shaped lives here and nowhere else
 * (ADR 0012). The adapter speaks Orca's own CLI (`orca … --json`, verified
 * against 1.4.177): worktrees implement workspaces, `repo add` implements
 * project registration, and a runtime-issued terminal handle is the landed
 * terminal's address. Selector spellings (`path:`, `id:`, `name:`) are
 * Orca's; the core never sees them.
 */

const START_RECOVERY = "start Orca: `orca open` (or `orca serve` for a headless runtime)";

export const orcaBackend: SurfaceBackend = {
  name: "orca",

  async land(request: LandRequest): Promise<Landing> {
    await assertReachable(request.env, request.narrator);
    const resolved = await resolveWorkspace(request);
    const terminal = request.dryRun
      ? null
      : await createTerminal(request, resolved.workspace.id, resolved.workspace.path);
    return {
      backend: "orca",
      project: resolved.project,
      workspace: resolved.workspace,
      terminal,
      provenance: resolved.provenance,
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
 * it already had — landing a run in it is not a reason to rewrite it. */
const NOT_CREATED = {
  recorded: false,
  detail: "workspace already exists · lineage unchanged",
};

async function resolveWorkspace(request: LandRequest): Promise<ResolvedWorkspace> {
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
function parentArgs(provenance: LandRequest["provenance"]): { args: string[]; detail: string } {
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
  request: LandRequest,
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
  return {
    project: { name: repo.name, created: repo.created },
    workspace: { ...worktree, created: true },
    provenance: { recorded: true, detail: parent.detail },
  };
}

interface EnsuredRepo {
  /** Null only on a dry run that would have registered. */
  id: string | null;
  name: string;
  created: boolean;
}

async function ensureRepo(
  request: LandRequest,
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
  request: LandRequest,
  worktreeId: string | null,
  worktreePath: string | null,
): Promise<string> {
  const selector = worktreeId !== null ? `id:${worktreeId}` : `path:${worktreePath}`;
  // The sentinel marks the landed command as already-routed (ADR 0004), and
  // the `env` spelling holds whether Orca runs it through a shell or not.
  const command = shellLine(["env", "AGENTSURFACE_LAUNCH=1", ...request.spec.command]);
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
      "run `orca terminal list --json` to find the landed terminal",
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

async function findWorktree(request: LandRequest, selector: string): Promise<OrcaWorktree | null> {
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
  request: LandRequest,
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

interface OrcaRepo {
  id: string;
  name: string;
  path: string;
}

async function listRepos(request: LandRequest): Promise<OrcaRepo[]> {
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

async function gitToplevel(path: string): Promise<string> {
  const child = Bun.spawn(["git", "-C", path, "rev-parse", "--show-toplevel"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
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

/** A lookup that may legitimately miss: null instead of a domain error. */
async function orcaTry(
  env: Environ,
  narrator: Narrator | null,
  args: string[],
): Promise<Record<string, unknown> | null> {
  const outcome = await runOrca(env, narrator, args);
  return outcome.ok ? outcome.result : null;
}

type OrcaOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; detail: string; reachableFault: boolean };

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
  const child = Bun.spawn([bin, ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
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
  const detail =
    stringField(errorRecord, "message") ??
    (typeof error === "string" ? error : null) ??
    firstLine(stderr) ??
    `exit ${code}`;
  return { ok: false, detail, reachableFault: /runtime|reachable|connect/i.test(detail) };
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
