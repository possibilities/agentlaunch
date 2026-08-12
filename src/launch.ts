import { CliError } from "./errors.ts";
import type { LaunchSpec } from "./harness.ts";
import type { Narrator } from "./narrate.ts";
import type { Environ } from "./paths.ts";
import { whichInEnv } from "./subprocess.ts";

/** Exit the way a shell reports a fatal signal, so scripts around the
 * wrapper cannot tell it from the harness itself. */
const SIGNAL_EXIT: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
};

export async function launch(
  spec: LaunchSpec,
  narrator: Narrator,
  env: Environ = process.env,
  /** Where to start the harness. Null is this process's own directory, which
   * is every launch except a resume — one runs where its conversation lived
   * (ADR 0028), since the harness cannot see its own working directory and
   * the files the conversation is about are there. */
  cwd: string | null = null,
): Promise<number> {
  const [bin, ...rest] = spec.command;
  if (bin === undefined) throw new CliError("empty_command", "launch spec has no command");
  const resolved = whichInEnv(bin, env);
  if (resolved === null) {
    throw new CliError(
      "harness_not_installed",
      `${bin} is not on PATH`,
      `install ${bin} or run agentlaunch from a shell where it resolves`,
    );
  }
  narrator.detail("bin", resolved);
  narrator.detail("env", "AGENTLAUNCH_LAUNCH=1 · PATH shims exec the real binary");
  const child = Bun.spawn([resolved, ...rest], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    ...(cwd === null ? {} : { cwd }),
    // The sentinel marks every descendant as already-routed: PATH shims
    // exec the real harness instead of re-entering agentlaunch (ADR 0004).
    env: { ...env, AGENTLAUNCH_LAUNCH: "1" },
  });
  // The terminal delivers Ctrl-C to the whole foreground group; swallowing
  // our copy keeps the wrapper alive so the harness decides what an
  // interrupt means (TUIs routinely treat it as an editing keystroke).
  const onInterrupt = (): void => {};
  const forward = (signal: "SIGTERM" | "SIGHUP") => (): void => {
    try {
      child.kill(signal);
    } catch {
      // The child already exited; there is nothing left to forward to.
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
