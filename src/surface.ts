import { UsageError } from "./errors.ts";
import type { LaunchSpec } from "./harness.ts";
import type { Narrator } from "./narrate.ts";
import type { Environ } from "./paths.ts";
import { orcaBackend } from "./surface-orca.ts";

/**
 * The surface API (ADR 0012): one backend-generic contract every surface
 * implements. The core hands a finished launch spec across this seam with a
 * workspace intent and gets back where it landed; nothing backend-shaped may
 * appear in these types, and everything a backend's own CLI or state looks
 * like lives in its adapter.
 */

/** Where a landing should live. "current" and "new" carry the path the
 * intent is anchored to — the invocation cwd on a launch, the session's own
 * cwd on a resume. Ensure (ADR 0013) materializes what the intent implies:
 * registration always, creation only when the operator named it. */
export type WorkspaceIntent =
  | { kind: "current"; path: string }
  | { kind: "existing"; selector: string }
  | { kind: "new"; name: string; project: string | null; path: string };

/**
 * What a landing came from (ADR 0015). Provenance is stated by the caller and
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
  /** The workspace a previous run landed in. The path is portable across
   * backends; the id belongs to the backend that recorded it. */
  | {
      kind: "run";
      runId: string;
      backend: string;
      workspace: { name: string; path: string; id: string | null };
    };

export interface LandRequest {
  spec: LaunchSpec;
  intent: WorkspaceIntent;
  /** Display name for the landed terminal; run names will feed this. */
  title: string;
  /** What this landing descends from — always stated, never inferred. */
  provenance: Provenance;
  /** Dry runs resolve read-only: no registration, no creation, no terminal. */
  dryRun: boolean;
  narrator: Narrator;
  env: Environ;
}

export interface Landing {
  backend: string;
  /** The ensure outcome for the project, when the intent implied one. */
  project: { name: string; created: boolean } | null;
  /** Path and id are null only when a dry run declined to create. */
  workspace: { name: string; path: string | null; id: string | null; created: boolean };
  /** Backend-issued handle for the landed terminal; null on a dry run. */
  terminal: string | null;
  /** What the backend did with the requested provenance. Backends differ in
   * what they can express, so a drop is reported, never silent. */
  provenance: { recorded: boolean; detail: string };
}

export interface BackendHealth {
  reachable: boolean;
  detail: string;
}

export interface SurfaceBackend {
  readonly name: string;
  /** Land a finished launch spec: ensure the entities the intent implies,
   * start the command in the workspace, report where it landed. */
  land(request: LandRequest): Promise<Landing>;
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
