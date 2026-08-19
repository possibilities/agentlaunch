import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CliError } from "../errors.ts";
import type { Environ } from "../paths.ts";
import type { LaunchPlan } from "./model.ts";

/**
 * The surface handoff: with --x-surface, a committed launch leaves as one
 * session directive — a JSON line appended to the file the host names in
 * AGENTSURFACE_DIRECTIVES — and the host realizes it on the surface.
 * AgentLaunch never calls herdr or agentsurface; the directive carries
 * everything the surface needs. The `surface-handoff-protocol` wiki page is
 * the contract.
 */

export const DIRECTIVE_SCHEMA_VERSION = 1;

export const DIRECTIVE_SINK_ENV = "AGENTSURFACE_DIRECTIVES";

/** One session for the surface to realize: where (cwd, worktree), what
 * (the herdr agent kind and its launch arguments), the composed intent, and
 * disposition (focus). `record` is opaque extra metadata the host merges
 * into its own launch record. */
export interface SessionDirective {
  schema_version: number;
  cwd: string;
  worktree: boolean;
  focus: boolean;
  agent: { kind: string; args: string[] };
  intent: string | null;
  record?: Record<string, unknown>;
}

/** A priming rides the intent as each harness's own skill spelling: /name
 * for claude and pi, $name for codex — the prefix alone when the intent is
 * empty, so the skill still primes the session. */
export function primedIntent(plan: Pick<LaunchPlan, "harness" | "prompt" | "priming">): string {
  if (plan.priming === null) return plan.prompt;
  const sigil = plan.harness === "codex" ? "$" : "/";
  return `${sigil}${plan.priming}${plan.prompt === "" ? "" : ` ${plan.prompt}`}`;
}

export function buildDirective(plan: LaunchPlan, focus: boolean): SessionDirective {
  const intent = primedIntent(plan);
  return {
    schema_version: DIRECTIVE_SCHEMA_VERSION,
    cwd: plan.project.path,
    worktree: plan.worktree,
    focus,
    agent: { kind: plan.harness, args: ["--x-level", plan.level] },
    intent: intent === "" ? null : intent,
    record: { model: plan.model, effort: plan.effort, priming: plan.priming },
  };
}

/** The host's sink, or a refusal: the form emits directives and nothing
 * else, so without a host there is nowhere for a launch to go. */
export function directiveSink(env: Environ): string {
  const path = env[DIRECTIVE_SINK_ENV];
  if (path === undefined || path === "") {
    throw new CliError(
      "surface_host_missing",
      `--x-surface runs under a surface host, and ${DIRECTIVE_SINK_ENV} is not set`,
      "open the form through the host (agentsurface host -- agentlaunch --x-surface)",
    );
  }
  return path;
}

/** One directive, one line, one atomic append: the host tails the file and
 * acts on each complete line as it lands. */
export function appendDirective(path: string, directive: SessionDirective): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(directive)}\n`);
}
