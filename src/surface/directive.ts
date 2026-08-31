import { CliError } from "../errors.ts";
import type { LaunchPlan } from "./model.ts";

/**
 * The surface handoff: under `--x-surface`, a committed launch leaves as one
 * session directive — a JSON line written to stdout, which the host holds
 * as a pipe while the form renders on stderr — and the host realizes it on
 * the surface. AgentLaunch never calls herdr or agentsurface; the directive
 * stream carries everything the surface needs. The
 * `surface-handoff-protocol` wiki page is the contract.
 */

export const DIRECTIVE_SCHEMA_VERSION = 1;

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

/** A priming rides the intent as each harness's own skill spelling:
 * /agent:name for Claude's synthetic plugin and $agent:name for Codex — the
 * prefix alone when the intent is empty. */
export function primedIntent(plan: Pick<LaunchPlan, "harness" | "prompt" | "priming">): string {
  if (plan.priming === null) return plan.prompt;
  const invocation =
    plan.harness === "claude" ? `/agent:${plan.priming}` : `$agent:${plan.priming}`;
  return `${invocation}${plan.prompt === "" ? "" : ` ${plan.prompt}`}`;
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

/** One directive, one line: what the form writes to stdout per commit. */
export function directiveLine(directive: SessionDirective): string {
  return `${JSON.stringify(directive)}\n`;
}

/** The form owes stdout to the host: rendering lives on stderr so the
 * directive stream has stdout to itself. A stdout that is a terminal means
 * no host is reading — the form would print JSON onto the operator's
 * screen after teardown — so it refuses up front, where the message can be
 * read plainly. */
export function assertHostedStdout(stdout: { isTTY?: boolean | undefined }): void {
  if (stdout.isTTY === true) {
    throw new CliError(
      "surface_host_missing",
      "--x-surface writes session directives to stdout, and stdout is a terminal",
      "run the form under a surface host (agentsurface host -- agentlaunch --x-surface)",
    );
  }
}
