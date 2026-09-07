import { CliError } from "./errors.ts";

/**
 * One bounded subprocess call: a deadline past which the child is killed and
 * then waited on rather
 * than left to leak, a typed `subprocess_timeout` domain error naming the
 * command instead of the caller hanging forever, and a capped stderr tail so
 * a runaway child cannot grow an error message without bound. Defaults are
 * generous per caller so a slow-but-alive operation never false-trips; a
 * timeout means the child did not finish, not that it was merely slow to start.
 */

const MAX_STDERR_CHARS = 4000;

/**
 * Resolves an executable against the supplied env's own PATH (S14), not the
 * parent process's — every spawn site here hands a child a caller-supplied
 * env, so lookup must agree with what that child will actually see. Falls
 * back to `Bun.which`'s default (parent PATH) only when the env carries no
 * PATH at all, matching Bun.spawn's own fallback for an env without one.
 */
export function whichInEnv(name: string, env: Record<string, string | undefined>): string | null {
  const path = env["PATH"];
  return path === undefined ? Bun.which(name) : Bun.which(name, { PATH: path });
}

export interface BoundedSpawnOptions {
  cmd: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes?: number;
  /** Names the command in a timeout's domain error. */
  label: string;
}

export interface BoundedSpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function spawnBounded(options: BoundedSpawnOptions): Promise<BoundedSpawnResult> {
  const child = Bun.spawn(options.cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: options.env as Record<string, string>,
  });
  const abort = new AbortController();
  const terminate = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Already exited. */
    }
    abort.abort();
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  let capped = false;
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    abort.signal.addEventListener("abort", cancel, { once: true });
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (!abort.signal.aborted) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > (options.maxOutputBytes ?? 4 * 1024 * 1024)) {
          capped = true;
          terminate();
          break;
        }
        chunks.push(part.value);
      }
      return Buffer.concat(chunks).toString();
    } finally {
      abort.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  };
  const stdoutRead = read(child.stdout),
    stderrRead = read(child.stderr);
  try {
    const [stdout, stderr, code] = await Promise.all([stdoutRead, stderrRead, child.exited]);
    if (capped)
      throw new CliError("subprocess_output_limit", `${options.label} exceeded its output limit`);
    if (timedOut) {
      throw new CliError(
        "subprocess_timeout",
        `${options.label} did not finish within ${options.timeoutMs}ms`,
        "check the command's own status and retry",
      );
    }
    return { code, stdout, stderr: stderr.slice(0, MAX_STDERR_CHARS) };
  } finally {
    clearTimeout(timer);
    terminate();
    await Promise.allSettled([stdoutRead, stderrRead, child.exited]);
  }
}
