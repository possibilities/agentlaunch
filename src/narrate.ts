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
  row(label: string, value: string): void;
  /** Mechanism, shown only under --x-verbose. */
  detail(label: string, value: string): void;
  readonly verbose: boolean;
}

/** Wide enough for the longest label (workspace), so values line up in one
 * column. */
const LABEL_WIDTH = 10;

/** Values are lists of facts, not sentences. */
export function facts(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
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
    return { row: () => {}, detail: () => {}, verbose: false };
  }
  const row = (label: string, value: string): void => {
    write(`${label.padEnd(LABEL_WIDTH)}${value}`);
  };
  return {
    row,
    detail: (label, value) => {
      if (options.verbose) row(label, value);
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
