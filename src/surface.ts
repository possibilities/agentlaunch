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

export interface LandRequest {
  spec: LaunchSpec;
  intent: WorkspaceIntent;
  /** Display name for the landed terminal; run names will feed this. */
  title: string;
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
