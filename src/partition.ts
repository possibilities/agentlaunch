import { UsageError } from "./errors.ts";

/**
 * The partition grammar (ADR 0008): every token of an invocation is either
 * agentsurface's — a `--x-*` flag anywhere, or a bare `x-*` word in command
 * position — or the harness's, forwarded in the order typed. Strictness
 * applies only to our side: an unknown `--x-*` is a usage fault; an unknown
 * anything-else is the harness's to judge, so a harness upgrade never
 * changes how a command parses here.
 */

export interface XSpec {
  /** x-flags that take a value: `--x-account work` or `--x-account=work`. */
  value: Set<string>;
  /** Boolean x-flags; a value or a repeat is a usage fault. */
  bool: Set<string>;
  /** Repeatable x-flags with an optional harness scope: bare covers every
   * harness, and a following harness name (or `=name`) narrows one
   * occurrence. */
  scoped: Set<string>;
}

export interface Partitioned {
  values: Record<string, string>;
  bools: Set<string>;
  /** Occurrence scopes per flag, "all" for a bare occurrence. */
  scoped: Map<string, string[]>;
  /** Every token that is not ours, order preserved. */
  harness: string[];
}

export function partition(
  argv: string[],
  spec: XSpec,
  harnessNames: readonly string[],
): Partitioned {
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const scoped = new Map<string, string[]>();
  const harness: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (!argument.startsWith("--x-")) {
      harness.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    if (spec.scoped.has(flag)) {
      let scope = "all";
      if (inline !== undefined) {
        if (!harnessNames.includes(inline)) {
          throw new UsageError(
            `"${flag}" scopes to a harness (${harnessNames.join(", ")}), got "${inline}"`,
          );
        }
        scope = inline;
      } else {
        // The scope is positional: the next token is consumed only when it
        // names a harness, so a prompt can still follow the bare flag.
        const next = argv[i + 1];
        if (next !== undefined && harnessNames.includes(next)) {
          scope = next;
          i++;
        }
      }
      const list = scoped.get(flag.slice(2)) ?? [];
      list.push(scope);
      scoped.set(flag.slice(2), list);
      continue;
    }
    if (!spec.value.has(flag) && !spec.bool.has(flag)) {
      throw new UsageError(`unknown option "${flag}"`);
    }
    if (seen.has(flag)) {
      throw new UsageError(`option "${flag}" given more than once`);
    }
    seen.add(flag);
    if (spec.bool.has(flag)) {
      if (inline !== undefined) throw new UsageError(`"${flag}" takes no value`);
      bools.add(flag.slice(2));
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`option "${flag}" requires a value`);
      }
      value = next;
      i++;
    }
    values[flag.slice(2)] = value;
  }

  return { values, bools, scoped, harness };
}
