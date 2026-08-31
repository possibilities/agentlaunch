import { UsageError } from "./errors.ts";

/**
 * The partition grammar (ADR 0008): every token of an invocation is either
 * agentlaunch's — a `--x-*` flag anywhere, or a bare `x-*` word in command
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
  /** Value flags that may appear more than once, preserving occurrence order. */
  repeatable: Set<string>;
  /** Repeatable x-flags with an optional scope from a per-flag vocabulary
   * (harness names for yolo): bare covers "all",
   * and a following vocabulary word (or `=word`) narrows one occurrence. */
  scoped: Map<string, readonly string[]>;
  /** Removed scope words that must fail instead of becoming native input. */
  retiredScoped?: Map<string, readonly string[]>;
}

export interface Partitioned {
  values: Record<string, string>;
  lists: Record<string, string[]>;
  bools: Set<string>;
  /** Occurrence scopes per flag, "all" for a bare occurrence. */
  scoped: Map<string, string[]>;
  /** Every token that is not ours, order preserved. */
  harness: string[];
}

export function partition(argv: string[], spec: XSpec): Partitioned {
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
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
    const vocabulary = spec.scoped.get(flag);
    if (vocabulary !== undefined) {
      const retired = spec.retiredScoped?.get(flag) ?? [];
      let scope = "all";
      if (inline !== undefined) {
        if (retired.includes(inline)) {
          throw new UsageError(`"${flag}" scope "${inline}" names a retired harness`);
        }
        if (!vocabulary.includes(inline)) {
          throw new UsageError(
            `"${flag}" scopes to one of ${vocabulary.join(", ")}; got "${inline}"`,
          );
        }
        scope = inline;
      } else {
        // The scope is positional: the next token is consumed only when it
        // is a vocabulary word, so a prompt can still follow the bare flag.
        const next = argv[i + 1];
        if (next !== undefined && retired.includes(next)) {
          throw new UsageError(`"${flag}" scope "${next}" names a retired harness`);
        }
        if (next !== undefined && vocabulary.includes(next)) {
          scope = next;
          i++;
        }
      }
      const list = scoped.get(flag.slice(2)) ?? [];
      list.push(scope);
      scoped.set(flag.slice(2), list);
      continue;
    }
    if (!spec.value.has(flag) && !spec.bool.has(flag) && !spec.repeatable.has(flag)) {
      throw new UsageError(`unknown option "${flag}"`);
    }
    if (!spec.repeatable.has(flag) && seen.has(flag)) {
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
    if (spec.repeatable.has(flag)) {
      const key = flag.slice(2);
      const list = lists[key] ?? [];
      list.push(value);
      lists[key] = list;
    } else {
      values[flag.slice(2)] = value;
    }
  }

  return { values, lists, bools, scoped, harness };
}
