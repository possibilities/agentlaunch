import { readFileSync, statSync } from "node:fs";
import { type AccountLease, loopbackLeaseURL, releaseLease } from "./account-session.ts";
import { CliError, UsageError } from "./errors.ts";
import type { HarnessName, LaunchSpec } from "./harness.ts";
import type { Narrator } from "./narrate.ts";
import { shellLine } from "./narrate.ts";
import type { Environ } from "./paths.ts";
import { spawnBounded, whichInEnv } from "./subprocess.ts";

export interface BalanceDecision {
  provider: "claude" | "codex";
  route: { id: string; slot: number } | null;
  /** Initial identity; unpinned Codex leases may rebalance on a quota rejection. */
  accountKey: string;
  leaseId: string | null;
  reason: string | null;
}
export interface BalanceRequest {
  account: string | undefined;
  model: string | undefined;
  dryRun: boolean;
  narrator: Narrator;
}
export interface BalancedLaunch {
  spec: LaunchSpec;
  decision: BalanceDecision;
}
export function balanceDisabledBy(
  env: Environ,
  noBalanceFlag: boolean,
  harness: HarnessName,
  configured: boolean,
): string | null {
  if (noBalanceFlag) return "--x-no-balance";
  for (const name of [
    "AGENTLAUNCH_NO_BALANCE",
    `AGENTLAUNCH_${harness.toUpperCase()}_NO_BALANCE`,
  ]) {
    if (env[name] !== undefined && env[name] !== "") return name;
  }
  return configured ? null : `config balance.${harness}`;
}
const VALUE_FLAGS = new Set([
  "--model",
  "--effort",
  "--profile",
  "--cd",
  "--image",
  "--add-dir",
  "--sandbox",
  "--ask-for-approval",
  "--enable",
  "--disable",
  "--output-schema",
  "--output-last-message",
  "--system-prompt",
  "--append-system-prompt",
  "--system-prompt-file",
  "--append-system-prompt-file",
  "--plugin-dir",
  "--mcp-config",
  "--permission-mode",
  "--output-format",
  "--input-format",
  "--resume",
  "--session-id",
  "--name",
  "--agent",
  "--agents",
  "--max-turns",
  "--max-budget-usd",
]);
const AUTH_SETTING =
  /model_providers?|base_url|api_key|auth_command|bearer_token|http_headers|env_http_headers|forced_login_method/iu;
export function rejectProviderOverrides(spec: LaunchSpec): void {
  const tokens = spec.command.slice(1);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") break;
    let conflict = false;
    if (spec.harness === "codex") {
      if (token === "--oss" || token.startsWith("--local-provider")) conflict = true;
      let config: string | undefined;
      if (token === "-c" || token === "--config") config = tokens[++i];
      else if (token.startsWith("--config=")) config = token.slice(9);
      else if (token.startsWith("-c") && token.length > 2)
        config = token.slice(token[2] === "=" ? 3 : 2);
      if (config && AUTH_SETTING.test(config.split("=", 1)[0]!)) conflict = true;
    } else if (token === "--settings" || token.startsWith("--settings=")) {
      const settings = token === "--settings" ? tokens[++i] : token.slice(11);
      try {
        if (!settings) throw new Error();
        const raw = settings.trimStart().startsWith("{")
          ? settings
          : statSync(settings).size <= 1024 * 1024
            ? readFileSync(settings, "utf8")
            : "";
        const parsed = object(JSON.parse(raw));
        const env = object(parsed?.["env"]);
        conflict =
          !parsed ||
          Object.keys(parsed).some((k) => /apiKeyHelper|forceLogin/u.test(k)) ||
          Object.keys(env ?? {}).some((k) =>
            /ANTHROPIC|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_/u.test(k),
          );
      } catch {
        throw new UsageError(
          "cannot inspect --settings for balanced authentication; use a readable settings file or --x-no-balance",
        );
      }
    }
    // A value is opaque native input even when its text resembles an option.
    if (
      VALUE_FLAGS.has(token) ||
      (spec.harness === "codex" && ["-m", "-p", "-C", "-i", "-s", "-a", "-o"].includes(token))
    )
      i++;
    if (conflict)
      throw new UsageError(
        "native provider/auth overrides conflict with balanced authentication; remove the override or use --x-no-balance",
      );
  }
}
function object(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}
function text(x: unknown): x is string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in the wire contract.
  return typeof x === "string" && x.length > 0 && x.length < 16_384 && !/[\x00-\x1f\x7f]/u.test(x);
}
function contract(): never {
  throw new CliError(
    "balance_contract",
    "agentusage prepare returned an invalid launch contract",
    "update AgentUsage and AgentLaunch together",
  );
}
function parseLease(value: unknown): AccountLease | null {
  const l = object(value);
  if (
    !l ||
    !text(l["id"]) ||
    !text(l["token"]) ||
    !loopbackLeaseURL(l["url"]) ||
    typeof l["expires_at_ms"] !== "number" ||
    !Number.isSafeInteger(l["expires_at_ms"])
  )
    return null;
  if (
    !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/u.test(l["token"]) ||
    !l["token"].startsWith(`${l["id"]}.`)
  )
    return null;
  return l as unknown as AccountLease;
}
const UNSET = new Set([
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_MULTI_AUTH_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]);
/** Codex subcommand-local config replaces global -c overrides. Put transport
 * options in the effective scope, before a literal -- and after other options. */
export function preparedCommand(command: string[], args: string[]): string[] {
  const boundary = command.indexOf("--");
  const at = boundary < 0 ? command.length : boundary;
  return [...command.slice(0, at), ...args, ...command.slice(at)];
}
export async function balanceSpec(
  env: Environ,
  spec: LaunchSpec,
  request: BalanceRequest,
): Promise<BalancedLaunch> {
  rejectProviderOverrides(spec); // Refuse conflicting explicit overrides before reserving anything.
  const argv = ["agentusage", "prepare", spec.harness, "--json"];
  if (request.model !== undefined) argv.push("--model", request.model);
  if (request.account !== undefined) argv.push("--account", request.account);
  if (request.dryRun) argv.push("--dry-run");
  request.narrator.detail("balance", shellLine(argv));
  const bin = whichInEnv("agentusage", env);
  if (!bin)
    throw new CliError(
      "balance_unavailable",
      "agentusage is not on PATH; balanced launches need it",
      "install AgentUsage or pass --x-no-balance",
    );
  const result = await spawnBounded({
    cmd: [bin, ...argv.slice(1)],
    env,
    timeoutMs: 65_000,
    maxOutputBytes: 64 * 1024,
    label: "agentusage prepare",
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = object(JSON.parse(result.stdout));
  } catch {
    contract();
  }
  const lease = parseLease(body?.["lease"]);
  try {
    if (body?.["schema_version"] !== 1 || body["provider"] !== spec.harness) contract();
    if (result.code !== 0 || body["ok"] !== true) {
      const refusal = text(body["refusal"]) ? body["refusal"] : "failed";
      const detail = text(body["detail"]) ? body["detail"] : "Account preparation failed";
      throw new CliError(
        `balance_${refusal.replaceAll("-", "_")}`,
        detail,
        "inspect agentusage status, or pass --x-no-balance",
      );
    }
    const key = body["account_key"],
      args = body["args"],
      additions = object(body["env"]),
      unset = body["unset_env"];
    if (
      !text(key) ||
      !new RegExp(`^${spec.harness}-[1-9]\\d*$`, "u").test(key) ||
      !text(body["reason"]) ||
      !Array.isArray(args) ||
      !args.every(text) ||
      !additions ||
      !Object.values(additions).every(text) ||
      !Array.isArray(unset) ||
      !unset.every((x) => typeof x === "string" && UNSET.has(x))
    )
      contract();
    if (
      request.dryRun
        ? body["lease"] !== null
        : !lease || lease.expires_at_ms <= Date.now() || lease.expires_at_ms > Date.now() + 95_000
    )
      contract();
    if (additions["AGENTUSAGE_ACCOUNT"] !== key) contract();
    const allowed = request.dryRun
      ? ["AGENTUSAGE_ACCOUNT"]
      : spec.harness === "codex"
        ? ["AGENTUSAGE_ACCOUNT", "AGENTUSAGE_AUTH_TOKEN"]
        : [
            "AGENTUSAGE_ACCOUNT",
            "AGENTUSAGE_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
          ];
    if (
      Object.keys(additions).length !== allowed.length ||
      Object.keys(additions).some((k) => !allowed.includes(k))
    )
      contract();
    if (lease && additions["AGENTUSAGE_AUTH_TOKEN"] !== lease.token) contract();
    if (spec.harness === "claude") {
      if (
        args.length ||
        (lease &&
          (additions["CLAUDE_CODE_OAUTH_TOKEN"] !== lease.token ||
            additions["ANTHROPIC_BASE_URL"] !== lease.url.replace(/\/lease$/u, "/claude")))
      )
        contract();
    } else {
      if (
        args.length !== 4 ||
        args[0] !== "-c" ||
        args[1] !== 'model_provider="agentusage"' ||
        args[2] !== "-c" ||
        !/^model_providers\.agentusage=\{name="AgentUsage",base_url="http:\/\/127\.0\.0\.1:\d+\/codex",env_key="AGENTUSAGE_AUTH_TOKEN",wire_api="responses",supports_websockets=false\}$/u.test(
          args[3]!,
        )
      )
        contract();
      if (lease && !args[3]!.includes(`base_url="${lease.url.replace(/\/lease$/u, "/codex")}"`))
        contract();
    }
    return {
      spec: {
        ...spec,
        command: preparedCommand(spec.command, args),
        ...(lease
          ? {
              accountSession: {
                lease,
                env: additions as Record<string, string>,
                unsetEnv: unset as string[],
                accountKey: key,
              },
            }
          : {}),
      },
      decision: {
        provider: spec.harness,
        route: spec.harness === "claude" ? { id: key, slot: Number(key.slice(7)) } : null,
        accountKey: key,
        leaseId: lease?.id ?? null,
        reason: body["reason"] as string,
      },
    };
  } catch (error) {
    if (lease) await releaseLease(lease);
    throw error;
  }
}
