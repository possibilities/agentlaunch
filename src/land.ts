import { CliError } from "./errors.ts";
import type { Narrator } from "./narrate.ts";
import { shellLine } from "./narrate.ts";
import type { Environ } from "./paths.ts";
import type { SurfaceBackend, Survey } from "./surface.ts";

/**
 * Land (ADR 0016): merging a workspace's finished work back to the main line
 * and letting the surface go. The order is the safety property — survey,
 * refuse, merge, release, reconcile — so a checkout is never removed until
 * its work provably arrived somewhere else.
 *
 * Everything git is done with git, directly against the checkouts; the
 * backend is asked only for what it alone knows (which workspace, whose
 * repo, what is still attached) and what it alone can do (stop attachments,
 * remove the workspace). Nothing here half-happens: a step that cannot
 * complete throws with the world as it was, so the calling agent resolves
 * and runs the same command again.
 */

/** Something true of the workspace that stops it being landed. `clearedBy`
 * names the flag that overrides it, or null when the answer is to go fix the
 * repository instead. */
export interface Blocker {
  code: string;
  detail: string;
  cleared_by: string | null;
}

export interface LandOptions {
  /** The backend's own selector; a `run:` ref is resolved before this. */
  selector: string;
  /** Merge target override; otherwise the backend's base ref decides. */
  into: string | undefined;
  /** Clear operational blockers: live attachments, child workspaces. */
  force: boolean;
  /** Discard the work: skip the merge entirely and release regardless. */
  abandon: boolean;
  dryRun: boolean;
}

export interface LandResult {
  backend: string;
  workspace: { name: string; path: string; id: string | null };
  branch: string | null;
  into: string | null;
  primary_path: string | null;
  /** What happened to the work: merged now, already in the target, or
   * deliberately discarded. */
  merge: "merged" | "already" | "abandoned" | null;
  commits: number | null;
  behind: number | null;
  unpushed: number | null;
  blockers: Blocker[];
  attachments: { handle: string; title: string; live: boolean }[];
  stopped: string[];
  removed: boolean;
  branch_deleted: boolean;
  runs: string[];
  dry_run: boolean;
}

export interface LandContext {
  env: Environ;
  home: string;
  narrator: Narrator;
}

export async function landWorkspace(
  context: LandContext,
  backend: SurfaceBackend,
  options: LandOptions,
  stampRuns: (workspacePath: string, closedAs: "landed" | "abandoned") => Promise<string[]>,
): Promise<LandResult> {
  const survey = await backend.survey({
    selector: options.selector,
    narrator: context.narrator,
    env: context.env,
  });
  // The repository's own checkout is where work lands, never what lands.
  // No flag makes that a good idea.
  if (survey.primary) {
    throw new CliError(
      "land_primary_checkout",
      `${survey.workspace.name} is the repository's primary checkout, not a workspace to land`,
      "name the workspace holding the finished work: agentsurface x-land name:<workspace>",
    );
  }

  const path = survey.workspace.path;
  const state = await checkoutState(context, path);
  if (state.branch === null) {
    throw new CliError(
      "land_detached",
      `${survey.workspace.name} has no branch checked out (detached HEAD at ${state.head.slice(0, 12)})`,
      "check out a branch in the workspace, or pass --x-abandon to discard it",
    );
  }
  const branch = state.branch;

  const primary = await primaryCheckout(context, path);
  const expected = options.into ?? localBase(context, survey.baseRef, primary.remotes);
  const into = expected ?? primary.branch;
  const primaryState = await checkoutState(context, primary.path);

  const blockers: Blocker[] = [];
  if (!options.abandon && state.dirty.total > 0) {
    blockers.push({
      code: "dirty",
      detail: describeDirty(state.dirty),
      cleared_by: "--x-abandon",
    });
  }
  const live = survey.attachments.filter((attachment) => attachment.live);
  if (!options.force && live.length > 0) {
    blockers.push({
      code: "terminals",
      detail: `${live.length} live: ${live.map((attachment) => attachment.title).join(", ")}`,
      cleared_by: "--x-force",
    });
  }
  if (!options.force && survey.children > 0) {
    blockers.push({
      code: "children",
      detail: `${survey.children} workspace(s) descend from this one`,
      cleared_by: "--x-force",
    });
  }
  // Every base check exists only to protect a merge, so abandoning skips them.
  if (!options.abandon) {
    if (into === null) {
      blockers.push({
        code: "base_detached",
        detail: `${primary.path} has no branch checked out and no base ref was stated`,
        cleared_by: null,
      });
    } else if (primaryState.branch !== into) {
      blockers.push({
        code: "base_branch",
        detail: `${primary.path} is on ${primaryState.branch ?? "a detached HEAD"}, not ${into}`,
        cleared_by: null,
      });
    }
    if (primaryState.dirty.total > 0) {
      blockers.push({
        code: "base_dirty",
        detail: `${primary.path} has ${describeDirty(primaryState.dirty)}`,
        cleared_by: null,
      });
    }
  }

  const counts =
    options.abandon || into === null
      ? { ahead: null, behind: null }
      : await aheadBehind(context, primary.path, into, branch);
  const unpushed = await unpushedCount(context, path, branch);

  const result: LandResult = {
    backend: survey.backend,
    workspace: survey.workspace,
    branch,
    into: options.abandon ? null : into,
    primary_path: primary.path,
    merge: null,
    commits: counts.ahead,
    behind: counts.behind,
    unpushed,
    blockers,
    attachments: survey.attachments,
    stopped: [],
    removed: false,
    branch_deleted: false,
    runs: [],
    dry_run: options.dryRun,
  };

  if (options.dryRun) return result;
  if (blockers.length > 0) throw blockedError(survey, branch, into, primary.path, blockers);

  if (options.abandon) {
    result.merge = "abandoned";
  } else if (into === null) {
    // Unreachable: a missing target is a blocker above, and blockers throw.
    // Stated rather than assumed, so no future edit can merge into nothing.
    throw new CliError(
      "land_no_base",
      `no merge target for ${branch}`,
      "pass --x-into <branch> to name one",
    );
  } else if (counts.ahead === 0) {
    result.merge = "already";
    context.narrator.row("merge", `already in ${into} · nothing to merge`);
  } else {
    await mergeBranch(context, primary.path, branch, into);
    result.merge = "merged";
    context.narrator.row("merge", `${branch} → ${into} · ${counts.ahead} commit(s)`);
  }

  const released = await backend.release({
    selector: options.selector,
    stopAttachments: true,
    narrator: context.narrator,
    env: context.env,
  });
  result.stopped = released.stopped;
  result.removed = released.removed;

  // The backend may dispose of the branch itself (Orca does, quietly failing
  // when git refuses); finishing the job with git is what makes the outcome
  // the same on every backend.
  result.branch_deleted = await deleteBranch(context, primary.path, branch, options.abandon);
  result.runs = await stampRuns(path, options.abandon ? "abandoned" : "landed");
  return result;
}

function blockedError(
  survey: Survey,
  branch: string,
  into: string | null,
  primaryPath: string,
  blockers: Blocker[],
): CliError {
  const summary = blockers.map((blocker) => `${blocker.code} (${blocker.detail})`).join("; ");
  const dirty = blockers.some((blocker) => blocker.code === "dirty");
  const recovery = dirty
    ? `commit or discard the changes in ${survey.workspace.path}, then run x-land again`
    : blockers.every((blocker) => blocker.cleared_by !== null)
      ? `rerun with ${[...new Set(blockers.map((blocker) => blocker.cleared_by))].join(" ")}`
      : into !== null
        ? shellLine(["git", "-C", primaryPath, "switch", into])
        : "resolve the repository state above, then run x-land again";
  return new CliError(
    "land_blocked",
    `${survey.workspace.name} (${branch}) cannot be landed: ${summary}`,
    recovery,
  );
}

// ---------------------------------------------------------------------------
// git

interface Dirty {
  tracked: number;
  untracked: number;
  total: number;
}

interface CheckoutState {
  /** Short branch name; null when HEAD is detached. */
  branch: string | null;
  head: string;
  dirty: Dirty;
}

function describeDirty(dirty: Dirty): string {
  const parts: string[] = [];
  if (dirty.tracked > 0) parts.push(`${dirty.tracked} modified`);
  if (dirty.untracked > 0) parts.push(`${dirty.untracked} untracked`);
  return parts.join(", ");
}

async function checkoutState(context: LandContext, path: string): Promise<CheckoutState> {
  const status = await git(context, path, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) {
    throw new CliError(
      "land_not_a_checkout",
      `${path} is not a git checkout: ${firstLine(status.stderr) ?? `git exited ${status.code}`}`,
      "x-land works on git workspaces; nothing else can be merged",
    );
  }
  let tracked = 0;
  let untracked = 0;
  for (const line of status.stdout.split("\n")) {
    if (line.trim() === "") continue;
    if (line.startsWith("??")) untracked++;
    else tracked++;
  }
  const branch = await git(context, path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await git(context, path, ["rev-parse", "HEAD"]);
  const name = branch.stdout.trim();
  return {
    branch: name === "HEAD" || name === "" ? null : name,
    head: head.stdout.trim(),
    dirty: { tracked, untracked, total: tracked + untracked },
  };
}

interface PrimaryCheckout {
  path: string;
  branch: string | null;
  remotes: string[];
}

/** git's own answer to "where is the repository proper": the first entry of
 * `worktree list` is always the main working tree. Asking git rather than the
 * backend keeps this true for checkouts the backend never made. */
async function primaryCheckout(context: LandContext, path: string): Promise<PrimaryCheckout> {
  const listed = await git(context, path, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) {
    throw new CliError(
      "land_not_a_checkout",
      `${path} has no git worktree list: ${firstLine(listed.stderr) ?? `git exited ${listed.code}`}`,
      "x-land works on git workspaces; nothing else can be merged",
    );
  }
  let primaryPath: string | null = null;
  let branch: string | null = null;
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (primaryPath !== null) break;
      primaryPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (primaryPath !== null && line.startsWith("branch ")) {
      branch = shortBranch(line.slice("branch ".length).trim());
    }
  }
  if (primaryPath === null) {
    throw new CliError(
      "land_no_primary",
      `git reported no main working tree for ${path}`,
      "run `git worktree list` in the workspace to inspect",
    );
  }
  if (primaryPath === path) {
    throw new CliError(
      "land_primary_checkout",
      `${path} is the repository's main working tree, not a workspace to land`,
      "name the workspace holding the finished work: agentsurface x-land name:<workspace>",
    );
  }
  const remotes = await git(context, primaryPath, ["remote"]);
  return {
    path: primaryPath,
    branch,
    remotes: remotes.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  };
}

function shortBranch(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** A backend states its base as it cuts from it — Orca's is `origin/main`.
 * The merge happens locally, so the tracking prefix comes off, and only for a
 * remote this repository actually has. */
function localBase(context: LandContext, baseRef: string | null, remotes: string[]): string | null {
  if (baseRef === null) return null;
  for (const remote of remotes) {
    const prefix = `${remote}/`;
    if (baseRef.startsWith(prefix)) {
      const local = baseRef.slice(prefix.length);
      context.narrator.detail("base", `${baseRef} · merging into local ${local}`);
      return local;
    }
  }
  return shortBranch(baseRef);
}

async function aheadBehind(
  context: LandContext,
  primaryPath: string,
  into: string,
  branch: string,
): Promise<{ ahead: number | null; behind: number | null }> {
  const counted = await git(context, primaryPath, [
    "rev-list",
    "--left-right",
    "--count",
    `${into}...${branch}`,
  ]);
  if (counted.code !== 0) return { ahead: null, behind: null };
  const [behind, ahead] = counted.stdout.trim().split(/\s+/).map(Number);
  return {
    ahead: Number.isFinite(ahead) ? (ahead as number) : null,
    behind: Number.isFinite(behind) ? (behind as number) : null,
  };
}

/** Reported, never blocking: whether the branch was published is the
 * operator's business, and a merged branch's own remote stops mattering. */
async function unpushedCount(
  context: LandContext,
  path: string,
  branch: string,
): Promise<number | null> {
  const upstream = await git(context, path, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    `${branch}@{upstream}`,
  ]);
  if (upstream.code !== 0) return null;
  const counted = await git(context, path, [
    "rev-list",
    "--count",
    `${upstream.stdout.trim()}..${branch}`,
  ]);
  if (counted.code !== 0) return null;
  const count = Number(counted.stdout.trim());
  return Number.isFinite(count) ? count : null;
}

/** The one step that can fail with the repository half-changed, so it is the
 * one step that undoes itself: a conflicted merge is aborted before the error
 * is raised, leaving the target exactly as it was for the agent to resolve. */
async function mergeBranch(
  context: LandContext,
  primaryPath: string,
  branch: string,
  into: string,
): Promise<void> {
  const merged = await git(context, primaryPath, ["merge", "--no-edit", branch]);
  if (merged.code === 0) return;
  const conflicted = await git(context, primaryPath, ["diff", "--name-only", "--diff-filter=U"]);
  const paths = conflicted.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  await git(context, primaryPath, ["merge", "--abort"]);
  const detail =
    paths.length > 0
      ? `conflicts in ${paths.join(", ")}`
      : (firstLine(merged.stderr) ?? firstLine(merged.stdout) ?? `git merge exited ${merged.code}`);
  throw new CliError(
    "land_conflict",
    `merging ${branch} into ${into} failed and was rolled back: ${detail}`,
    `resolve it in the workspace — rebase onto ${into} there, then run x-land again; ${primaryPath} is unchanged`,
  );
}

/** After release the branch is checked out nowhere, so it can go. `-d` keeps
 * git's own merged-ness check as a last guard on the normal path; abandoning
 * is the only route to `-D`. */
async function deleteBranch(
  context: LandContext,
  primaryPath: string,
  branch: string,
  abandon: boolean,
): Promise<boolean> {
  const exists = await git(context, primaryPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (exists.code !== 0) return true;
  const deleted = await git(context, primaryPath, ["branch", abandon ? "-D" : "-d", branch]);
  return deleted.code === 0;
}

interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(context: LandContext, cwd: string, args: string[]): Promise<GitOutcome> {
  context.narrator.detail("git", shellLine(["git", "-C", cwd, ...args]));
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: context.env as Record<string, string>,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function firstLine(text: string): string | null {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? null : line.trim();
}
