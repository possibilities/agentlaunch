import { describe, expect, test } from "bun:test";

/**
 * `guide --json` is agentlaunch's fleet agent contract (agentstart's
 * config/agent-contract/schema.json, version 1). This test owns this
 * repository's conformance to that shape — the shared schema is normative
 * and lives in agentstart, but the assertions here are self-contained so
 * this suite never depends on another checkout being present on disk.
 */

interface RawArgument {
  name: string;
  type: string;
  description: string;
  positional?: boolean;
  required?: boolean;
  choices?: string[];
}

interface RawConstraint {
  kind: "one_of" | "conflicts" | "requires";
  arguments: string[];
}

interface RawCommand {
  name: string;
  summary: string;
  audience: "agent" | "operator" | "internal";
  mutates?: boolean;
  arguments?: RawArgument[];
  subcommands?: RawCommand[];
  constraints?: RawConstraint[];
}

function run(): { schema_version: number; ok: boolean; error: unknown; data: unknown } {
  const proc = Bun.spawnSync(["bun", "src/main.ts", "guide", "--json"], {
    cwd: `${import.meta.dir}/..`,
  });
  expect(proc.exitCode).toBe(0);
  return JSON.parse(proc.stdout.toString());
}

function walk(commands: RawCommand[], into: RawCommand[]): void {
  for (const command of commands) {
    into.push(command);
    if (command.subcommands !== undefined) walk(command.subcommands, into);
  }
}

describe("agent contract", () => {
  test("guide --json is a conformant envelope", () => {
    const envelope = run();
    expect(envelope.schema_version).toBe(1);
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeNull();

    const data = envelope.data as {
      contract_version: number;
      meta: { name: string; version: string; purpose: string; audience: string };
      commands: RawCommand[];
      global_arguments?: RawArgument[];
    };
    expect(data.contract_version).toBe(1);

    // meta.audience "operator": agentlaunch runs before an agent exists, so
    // it owes only meta and commands, never guidance/concepts, and never an
    // "agent" command — this is a launch layer, not a callable surface.
    expect(data.meta.audience).toBe("operator");
    expect(data.meta.name.length).toBeGreaterThan(0);
    expect(data.meta.version.length).toBeGreaterThan(0);
    expect(data.meta.purpose.length).toBeGreaterThan(0);

    const all: RawCommand[] = [];
    walk(data.commands, all);
    expect(all.length).toBeGreaterThan(0);

    // Every real invocation is present: launch, x-resume, x-doctor,
    // x-catalog, x-surface, and guide itself. Omission is never how a
    // command is hidden.
    const names = new Set(all.map((command) => command.name));
    for (const expected of ["launch", "x-resume", "x-doctor", "x-catalog", "x-surface", "guide"]) {
      expect(names.has(expected)).toBe(true);
    }

    for (const command of all) {
      // No command may be audience "agent": nothing here is a verb a
      // running agent should call on itself.
      expect(["operator", "internal"]).toContain(command.audience);
      expect(command.summary.length).toBeGreaterThan(0);

      const isGroup = command.subcommands !== undefined;
      if (isGroup) {
        expect(command.mutates).toBeUndefined();
        expect(command.arguments).toBeUndefined();
        continue;
      }
      // A leaf owes the full mechanical description.
      expect(typeof command.mutates).toBe("boolean");
      expect(Array.isArray(command.arguments)).toBe(true);

      for (const argument of command.arguments ?? []) {
        // A positional carries no leading dashes; a flag carries them.
        if (argument.positional === true) {
          expect(argument.name.startsWith("-")).toBe(false);
        } else {
          expect(argument.name.startsWith("--")).toBe(true);
        }
      }

      // Every constraint names only this command's own arguments.
      const ownNames = new Set((command.arguments ?? []).map((argument) => argument.name));
      for (const constraint of command.constraints ?? []) {
        for (const name of constraint.arguments) {
          expect(ownNames.has(name)).toBe(true);
        }
      }
    }

    // Global arguments are declared once, not repeated per command.
    for (const argument of data.global_arguments ?? []) {
      expect(argument.name.startsWith("--")).toBe(true);
      for (const command of all) {
        if (command.subcommands !== undefined) continue;
        expect((command.arguments ?? []).some((own) => own.name === argument.name)).toBe(false);
      }
    }
  });
});
