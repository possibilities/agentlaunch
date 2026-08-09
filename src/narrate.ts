/**
 * The launch narrative: what agentsurface decided, in order, before the
 * harness takes the terminal. Bare `claude` now balances accounts and
 * injects permission flags on its own, so the story is the only thing
 * making that legible.
 *
 * It goes to stderr, never stdout: stdout carries the result — a dry run's
 * runnable shell line, or the JSON envelope — and narration there would
 * corrupt both. On a terminal the two are indistinguishable.
 */
export interface Narrator {
  /** A decision worth seeing on every launch. */
  say(line: string): void;
  /** Mechanism, shown only under --x-verbose. */
  detail(line: string): void;
  readonly verbose: boolean;
}

export interface NarratorOptions {
  /** Machine consumers get the envelope instead; narration stays silent. */
  silent: boolean;
  verbose: boolean;
  write?: ((line: string) => void) | undefined;
}

export function createNarrator(options: NarratorOptions): Narrator {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (options.silent) {
    return { say: () => {}, detail: () => {}, verbose: false };
  }
  return {
    say: (line) => write(line),
    detail: (line) => {
      if (options.verbose) write(`  ${line}`);
    },
    verbose: options.verbose,
  };
}

/** Paths read better as ~/code/foo than as the full home prefix. */
export function tildePath(path: string, home: string): string {
  if (home === "" || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  if (rest === "") return "~";
  return rest.startsWith("/") ? `~${rest}` : path;
}

const SHELL_SAFE = /^[A-Za-z0-9@%+=:,./_-]+$/;

/** The command as a human could retype it. */
export function shellLine(command: string[]): string {
  return command
    .map((word) => (SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}
