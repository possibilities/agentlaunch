import { maintainLease, releaseLease } from "./account-session.ts";
import { CliError } from "./errors.ts";
import type { LaunchSpec } from "./harness.ts";
import type { Narrator } from "./narrate.ts";
import type { Environ } from "./paths.ts";
import { ROLE_RESOURCES_MARKER } from "./role-resources.ts";
import { whichInEnv } from "./subprocess.ts";

const SIGNAL_EXIT: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
};

/** Launch the native harness process. AgentLaunch owns no Codex server,
 * socket, remote client, or session registry. The existing parent maintains
 * its AgentUsage lease; Codex owns trust, history, resume and its terminal UI. */
export async function launch(
  spec: LaunchSpec,
  narrator: Narrator,
  env: Environ = process.env,
  cwd: string | null = null,
): Promise<number> {
  const session = spec.accountSession;
  const childEnv = { ...env };
  if (session) {
    for (const key of session.unsetEnv) delete childEnv[key];
    Object.assign(childEnv, session.env);
  }
  // The role resource marker applies only to this AgentLaunch shim. Keeping
  // the role name/path lets role skills inspect their context; consuming the
  // marker keeps later AgentLaunch invocations on the normal fleet default.
  delete childEnv[ROLE_RESOURCES_MARKER];
  let stopHeartbeat: (() => Promise<void>) | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = spawnInteractive(spec.command, narrator, childEnv, cwd);
    if (session)
      stopHeartbeat = maintainLease(
        session,
        () => {
          narrator.row(
            "account",
            "session lease expired or was rejected; resume to prepare a fresh account",
          );
          try {
            child.kill("SIGTERM");
          } catch {
            /* Already exited. */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* Already exited. */
            }
          }, 2000);
        },
        (key) => narrator.row("account", `rebalanced to ${key} after quota exhaustion`),
      );
    return await adoptInteractive(child);
  } finally {
    clearTimeout(killTimer);
    await stopHeartbeat?.();
    if (session) await releaseLease(session.lease);
  }
}

function spawnInteractive(command: string[], narrator: Narrator, env: Environ, cwd: string | null) {
  const [resolved, ...rest] = resolveCommand(command, env);
  narrator.detail("bin", resolved);
  narrator.detail("env", "AGENTLAUNCH_LAUNCH=1 · PATH shims exec the real binary");
  return Bun.spawn([resolved, ...rest], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    ...(cwd === null ? {} : { cwd }),
    env: { ...env, AGENTLAUNCH_LAUNCH: "1" } as Record<string, string>,
  });
}

function resolveCommand(command: string[], env: Environ): [string, ...string[]] {
  const [bin, ...rest] = command;
  if (bin === undefined) throw new CliError("empty_command", "launch spec has no command");
  const resolved = whichInEnv(bin, env);
  if (resolved === null) {
    throw new CliError(
      "harness_not_installed",
      `${bin} is not on PATH`,
      `install ${bin} or run agentlaunch from a shell where it resolves`,
    );
  }
  return [resolved, ...rest];
}

async function adoptInteractive(child: ReturnType<typeof spawnInteractive>): Promise<number> {
  const onInterrupt = (): void => {};
  const forward = (signal: "SIGTERM" | "SIGHUP") => (): void => {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  };
  const onTerminate = forward("SIGTERM");
  const onHangup = forward("SIGHUP");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("SIGHUP", onHangup);
  try {
    const code = await child.exited;
    if (child.signalCode !== null) return SIGNAL_EXIT[child.signalCode] ?? 1;
    return code;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("SIGHUP", onHangup);
  }
}
