import { UsageError } from "./errors.ts";
import type { LaunchSpec } from "./harness.ts";
import type { Narrator } from "./narrate.ts";
import type { Environ } from "./paths.ts";
import { orcaBackend } from "./surface-orca.ts";

/**
 * The surface API (ADR 0012): one backend-generic contract every surface
 * implements. The core hands a finished launch spec across this seam with a
 * workspace intent and gets back where it was placed; nothing backend-shaped may
 * appear in these types, and everything a backend's own CLI or state looks
 * like lives in its adapter.
 */

/** Where a Placement should live. "current" and "new" carry the path the
 * intent is anchored to — the invocation cwd on a launch, the session's own
 * cwd on a resume. Ensure (ADR 0013) materializes what the intent implies:
 * registration always, creation only when the operator named it. */
export type WorkspaceIntent =
  | { kind: "current"; path: string }
  | { kind: "existing"; selector: string }
  | { kind: "new"; name: string; project: string | null; path: string };

/**
 * What a placement came from (ADR 0015). Provenance is stated by the caller and
 * never inferred: `none` is a value rather than the absence of one, because a
 * backend that would otherwise read its own environment has to be told
 * explicitly not to. The vocabulary here is ours; what a backend *means* by a
 * parent is its own flavor, and an honest adapter reports what it could not
 * record rather than silently dropping it.
 */
export type Provenance =
  /** Explicitly nothing to descend from. */
  | { kind: "none" }
  /** A workspace named in the backend's own selector vocabulary. */
  | { kind: "selector"; selector: string }
  /** The workspace a previous run was placed in. The path is portable across
   * backends; the id belongs to the backend that recorded it. */
  | {
      kind: "run";
      runId: string;
      backend: string;
      workspace: { name: string; path: string; id: string | null };
    };

export interface PlaceRequest {
  spec: LaunchSpec;
  intent: WorkspaceIntent;
  /** Display name for the placed terminal: the run name when the operator
   * gave one, the harness value otherwise. */
  title: string;
  /** The operator's own label for this run (`--x-name`), or null. Distinct
   * from the title because a backend may name more than a terminal: where it
   * labels a workspace it created, this is the label to use, stated as typed.
   * A backend with nothing to name simply ignores it. */
  name: string | null;
  /** What this placement descends from — always stated, never inferred. */
  provenance: Provenance;
  /** Dry runs resolve read-only: no registration, no creation, no terminal. */
  dryRun: boolean;
  /**
   * Called once the workspace exists and before anything is started inside it,
   * with the workspace's own path. It is where the caller answers what a
   * harness would otherwise stop to ask on first sight of a directory, and
   * where a launch that must not run concurrently claims its place — both need
   * the real path, which only the backend knows once it has resolved or
   * created the workspace. Throwing here refuses the placement before any
   * attachment starts. A backend must call it exactly once outside a dry run.
   */
  prepare?: (workspacePath: string) => void;
  narrator: Narrator;
  env: Environ;
}

export interface Placement {
  backend: string;
  /** The ensure outcome for the project, when the intent implied one. */
  project: { name: string; created: boolean } | null;
  /** Path and id are null only when a dry run declined to create. */
  workspace: { name: string; path: string | null; id: string | null; created: boolean };
  /** Backend-issued handle for the placed terminal; null on a dry run. */
  terminal: string | null;
  /** What the backend did with the requested provenance. Backends differ in
   * what they can express, so a drop is reported, never silent. */
  provenance: { recorded: boolean; detail: string };
}

/** One thing a backend runs inside a workspace — an Orca terminal, a herdr
 * pane or agent. Releasing a workspace stops them; the handle is the same
 * address a run record carries. */
export interface Attachment {
  handle: string;
  title: string;
  /** Whether the backend still considers it live. */
  live: boolean;
}

/**
 * What a backend knows about an existing workspace that nobody else does:
 * its identity, whether it is the repository's primary checkout, what its
 * worktrees are cut from, and what is still running inside it. Git facts are
 * deliberately absent — a workspace is a directory plus the backend's
 * bookkeeping, and the directory half is git's to answer, read with git.
 */
export interface Survey {
  backend: string;
  workspace: { name: string; path: string; id: string | null };
  /** The ref this backend cuts new workspaces from — repo policy where the
   * backend records one, null where it has no opinion. */
  baseRef: string | null;
  /** The repository's own checkout, which exists to be worked in and never
   * to be released. */
  primary: boolean;
  /** Workspaces the backend records as descending from this one; releasing a
   * parent leaves them without one. */
  children: number;
  attachments: Attachment[];
}

export interface SurveyRequest {
  /** The backend's own workspace selector; `run:` refs are resolved to one
   * before they reach here. */
  selector: string;
  narrator: Narrator;
  env: Environ;
}

export interface ReleaseRequest {
  selector: string;
  /** Stop live attachments first. False leaves them to the backend's own
   * removal semantics, which may refuse. */
  stopAttachments: boolean;
  narrator: Narrator;
  env: Environ;
}

/** What releasing actually did. A backend that also disposes of the branch
 * says so, because the caller finishes that job with git otherwise. */
export interface Released {
  stopped: string[];
  removed: boolean;
  detail: string;
}

export interface BackendHealth {
  reachable: boolean;
  detail: string;
}

export interface SurfaceBackend {
  readonly name: string;
  /** Place a finished launch spec: ensure the entities the intent implies,
   * start the command in the workspace, report where it was placed. */
  place(request: PlaceRequest): Promise<Placement>;
  /** Report an existing workspace: identity, attachments, and the facts only
   * this backend holds. Read-only. */
  survey(request: SurveyRequest): Promise<Survey>;
  /** Let go of a workspace: stop what is attached, then remove it. The
   * inverse of place, and the only destructive operation on the seam. */
  release(request: ReleaseRequest): Promise<Released>;
  /** Health for x-doctor; never throws — diagnosis is the caller's job. */
  doctor(env: Environ): Promise<BackendHealth>;
}

/** Registration order is also presentation order in x-doctor. A second
 * backend is an adapter plus a line here (ADR 0012). */
export const BACKENDS: Record<string, SurfaceBackend> = { orca: orcaBackend };

export const BACKEND_NAMES: readonly string[] = Object.keys(BACKENDS);

/** A bare --x-surface means the sole/first registered backend. */
export const DEFAULT_BACKEND = BACKEND_NAMES[0]!;

export function surfaceBackend(name: string): SurfaceBackend {
  const backend = BACKENDS[name];
  if (backend === undefined) {
    throw new UsageError(
      `unknown surface backend "${name}" (expected ${BACKEND_NAMES.join(", ")})`,
    );
  }
  return backend;
}
