import { CliError } from "./errors.ts";
import type { HarnessName, LaunchSpec } from "./harness.ts";
import type { Narrator } from "./narrate.ts";
import { shellLine } from "./narrate.ts";
import type { Environ } from "./paths.ts";

/**
 * Balanced launches compose a swap prefix around the pure launch spec
 * (ADR 0003): agentusage picks the account, the swap tools pin it, and the
 * harness argv passes through byte-for-byte after their `--`. Nothing here
 * changes what the harness receives.
 */

export interface BalanceDecision {
  provider: "claude" | "codex";
  /** claude-swap route (claude launches). */
  route: { id: string; slot: number } | null;
  /** codex-swap account key (codex and pi launches). */
  accountKey: string | null;
  /** Lease consumed by the launch; null when dry-run composed unclaimed. */
  leaseId: string | null;
  reason: string | null;
}

export interface BalanceRequest {
  /** --x-account pin; forwarded, never resolved here. */
  account: string | undefined;
  /** Model driving fable intent and codex lane selection. */
  model: string | undefined;
  /** Dry runs must not reserve or claim anything. */
  dryRun: boolean;
  narrator: Narrator;
}

export interface BalancedLaunch {
  spec: LaunchSpec;
  decision: BalanceDecision;
}

/** Balance is on unless the launch or the machine opts out. */
export function balanceDisabled(env: Environ, noBalanceFlag: boolean): boolean {
  if (noBalanceFlag) return true;
  const machine = env["AGENTSURFACE_NO_BALANCE"];
  return machine !== undefined && machine !== "";
}

export async function balanceSpec(
  env: Environ,
  spec: LaunchSpec,
  request: BalanceRequest,
): Promise<BalancedLaunch> {
  if (spec.harness === "claude") return balanceClaude(env, spec, request);
  return balanceCodexFamily(env, spec, request);
}

// ---------------------------------------------------------------------------
// claude — agentusage balance claude → cswap run <slot> --share-history

async function balanceClaude(
  env: Environ,
  spec: LaunchSpec,
  request: BalanceRequest,
): Promise<BalancedLaunch> {
  const argv = ["agentusage", "balance", "claude", "--json"];
  if (request.model !== undefined) argv.push("--model", request.model);
  if (request.account !== undefined) argv.push("--account", request.account);
  if (request.dryRun) argv.push("--dry-run");

  const body = await runBalanceJson(env, argv, request.narrator);
  const route = body["route"];
  const slot =
    typeof route === "object" && route !== null
      ? (route as Record<string, unknown>)["slot"]
      : undefined;
  const routeId =
    typeof route === "object" && route !== null
      ? (route as Record<string, unknown>)["id"]
      : undefined;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) {
    throw new CliError(
      "balance_contract",
      "agentusage balance claude returned no usable route slot",
      "run `agentusage status` to inspect, or pass --x-no-balance",
    );
  }
  return {
    spec: {
      ...spec,
      command: ["cswap", "run", String(slot), "--share-history", "--", ...spec.command.slice(1)],
    },
    decision: {
      provider: "claude",
      route: { id: typeof routeId === "string" ? routeId : `claude-swap:${slot}`, slot },
      accountKey: null,
      leaseId: null,
      reason: stringOrNull(body["reason"]),
    },
  };
}

// ---------------------------------------------------------------------------
// codex + pi — agentusage balance codex [--claim] → codex-swap run/resume/pi run

async function balanceCodexFamily(
  env: Environ,
  spec: LaunchSpec,
  request: BalanceRequest,
): Promise<BalancedLaunch> {
  // An explicit pin skips selection entirely: codex-swap's own eligibility
  // gate judges the forced account, mirroring its fail-hard contract.
  if (request.account !== undefined) {
    return {
      spec: { ...spec, command: composeCodexFamily(spec, ["--account", request.account]) },
      decision: {
        provider: "codex",
        route: null,
        accountKey: request.account,
        leaseId: null,
        reason: "requested-account",
      },
    };
  }

  const argv = ["agentusage", "balance", "codex", "--json"];
  const model = normalizePiModel(spec.harness, request.model);
  if (model !== undefined) argv.push("--model", model);
  if (!request.dryRun) argv.push("--claim");

  const body = await runBalanceJson(env, argv, request.narrator);
  const accountKey = stringOrNull(body["accountKey"]);
  if (accountKey === null) {
    throw new CliError(
      "balance_contract",
      "agentusage balance codex returned no account key",
      "run `agentusage status` to inspect, or pass --x-no-balance",
    );
  }
  const lease = body["lease"];
  const leaseId =
    typeof lease === "object" && lease !== null
      ? stringOrNull((lease as Record<string, unknown>)["leaseId"])
      : null;
  if (!request.dryRun && leaseId === null) {
    throw new CliError(
      "balance_contract",
      "agentusage balance codex --claim returned no lease",
      "run `codex-swap doctor`, or pass --x-no-balance",
    );
  }

  // A dry run composed nothing claimable, so it prints the --account
  // spelling — a real command a human can copy-run through the same gate.
  const pin = leaseId !== null ? ["--claim", leaseId] : ["--account", accountKey];
  return {
    spec: { ...spec, command: composeCodexFamily(spec, pin) },
    decision: {
      provider: "codex",
      route: null,
      accountKey,
      leaseId,
      reason: stringOrNull(body["reason"]),
    },
  };
}

/**
 * codex opens wrap as `codex-swap run`, codex resumes as
 * `codex-swap resume <id>` (the session id moves into the wrapper's
 * grammar), pi always as `codex-swap pi run` — pi's own `--session` flag
 * rides the forwarded args untouched.
 */
export function composeCodexFamily(spec: LaunchSpec, pin: string[]): string[] {
  if (spec.harness === "pi") {
    return ["codex-swap", "pi", "run", ...pin, "--", ...spec.command.slice(1)];
  }
  if (spec.sessionId !== null) {
    // buildResume shaped: ["codex", "resume", <id>, ...passthrough]
    return ["codex-swap", "resume", spec.sessionId, ...pin, "--", ...spec.command.slice(3)];
  }
  return ["codex-swap", "run", ...pin, "--", ...spec.command.slice(1)];
}

/** Pi model ids may carry the provider prefix; lanes match on the bare id. */
export function normalizePiModel(
  harness: HarnessName,
  model: string | undefined,
): string | undefined {
  if (model === undefined || harness !== "pi") return model;
  return model.startsWith("openai-codex/") ? model.slice("openai-codex/".length) : model;
}

// ---------------------------------------------------------------------------
// shared plumbing

async function runBalanceJson(
  env: Environ,
  argv: string[],
  narrator: Narrator,
): Promise<Record<string, unknown>> {
  narrator.detail("balance", shellLine(argv));
  const [bin, ...rest] = argv as [string, ...string[]];
  const resolved = Bun.which(bin);
  if (resolved === null) {
    throw new CliError(
      "balance_unavailable",
      `${bin} is not on PATH; balanced launches need the agentusage stack`,
      "install it, or pass --x-no-balance (or set AGENTSURFACE_NO_BALANCE=1) to launch unbalanced",
    );
  }
  const child = Bun.spawn([resolved, ...rest], {
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
    if (typeof parsed === "object" && parsed !== null) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }

  if (code === 0 && body !== null && body["ok"] === true) return body;

  // agentusage spells refusals two ways: `{error: {code, message}}` and the
  // balance-verb `{refusal, detail}`; both must surface verbatim.
  const error = body?.["error"];
  const errorRecord =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
  const code_ =
    stringOrNull(errorRecord?.["code"]) ??
    (typeof error === "string" ? error : null) ??
    stringOrNull(body?.["refusal"]) ??
    (code === 3 ? "no-eligible-account" : "balance-failed");
  const message =
    stringOrNull(errorRecord?.["message"]) ??
    stringOrNull(body?.["detail"]) ??
    firstLine(stderr) ??
    `agentusage ${argv.slice(1, 3).join(" ")} exited ${code}`;
  const recovery = stringOrNull(body?.["recovery"]) ?? stringOrNull(errorRecord?.["recovery"]);
  throw new CliError(
    `balance_${code_.replaceAll("-", "_")}`,
    message,
    recovery ?? "fix capacity (`agentusage status` explains), or pass --x-no-balance",
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstLine(text: string): string | null {
  const line = text.split("\n", 1)[0]?.trim();
  return line !== undefined && line.length > 0 ? line : null;
}
