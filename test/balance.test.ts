import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeCodex } from "../src/balance.ts";
import type { Envelope } from "../src/envelope.ts";
import { seedFleetResources } from "./resource-fixture.ts";

type AnyEnvelope = Envelope<Record<string, unknown>>;

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const SESSION_ID = "05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60";
const SHADCN_MCP = 'mcp_servers.shadcn={command="npx",args=["shadcn@latest","mcp"]}';

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface World {
  root: string;
  binDir: string;
  recordPath: string;
}

/**
 * A world with a fake `agentusage` first on PATH: it records its argv and
 * answers from canned per-provider JSON files, so balanced dry runs compose
 * real prefixes without the real stack.
 */
function makeWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "agentlaunch-balance-"));
  roots.push(root);
  const binDir = join(root, "bin");
  seedFleetResources(join(root, "home"));
  mkdirSync(binDir, { recursive: true });
  const recordPath = join(root, "balance-argv.jsonl");
  const fake = join(binDir, "agentusage");
  writeFileSync(
    fake,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(recordPath)}`,
      `dir="$(dirname "$0")"`,
      `if [ "$2" = "claude" ]; then cat "$dir/claude.json"; else cat "$dir/codex.json"; fi`,
      `exit "$(cat "$dir/exit-code" 2>/dev/null || echo 0)"`,
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  writeFileSync(
    join(binDir, "claude.json"),
    JSON.stringify({
      schema_version: 1,
      provider: "claude",
      ok: true,
      route: { id: "claude-swap:2", kind: "managed", slot: 2 },
      reason: "selected",
    }),
  );
  writeFileSync(
    join(binDir, "codex.json"),
    JSON.stringify({
      schema_version: 1,
      provider: "codex",
      ok: true,
      accountKey: "account:org-test",
      lease: null,
      reason: "highest headroom",
    }),
  );
  return { root, binDir, recordPath };
}

function run(world: World, args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const result = Bun.spawnSync({
    cmd: ["bun", MAIN, ...args],
    cwd: world.root,
    env: {
      PATH: `${world.binDir}:${process.env["PATH"] ?? ""}`,
      HOME: join(world.root, "home"),
      CLAUDE_CONFIG_DIR: join(world.root, "claude"),
      CODEX_HOME: join(world.root, "codex"),
      ...extraEnv,
    },
  });
  let stdout = result.stdout.toString();
  const home = join(world.root, "home");
  const plugin = join(home, ".local", "share", "agentstart", "resources", "claude", "agent");
  const skill = join(home, ".local", "share", "agentstart", "resources", "skills", "collab");
  const policy = 'skills.config=[{name="agent:collab",enabled=true}]';
  try {
    const envelope = JSON.parse(stdout) as AnyEnvelope;
    const data = envelope.data as { command?: string[] } | null;
    if (Array.isArray(data?.command)) {
      data.command = withoutFleetResources(data.command, plugin, skill, policy);
      stdout = `${JSON.stringify(envelope)}\n`;
    }
  } catch {
    stdout = stdout
      .replace(`--plugin-dir ${plugin} `, "")
      .replace(`--skill ${skill} `, "")
      .replace(`-c '${policy}' `, "");
  }
  return {
    code: result.exitCode,
    stdout,
    stderr: result.stderr.toString(),
  };
}

function withoutFleetResources(
  command: string[],
  plugin: string,
  skill: string,
  policy: string,
): string[] {
  const result: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const token = command[i];
    const value = command[i + 1];
    if (
      (token === "--plugin-dir" && value === plugin) ||
      (token === "--skill" && value === skill) ||
      (token === "-c" && value === policy)
    ) {
      i += 1;
      continue;
    }
    if (token !== undefined) result.push(token);
  }
  return result;
}

function balanceCalls(world: World): string[] {
  try {
    return readFileSync(world.recordPath, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

describe("balanced launch", () => {
  test("retired capability flags fail before launch", () => {
    const world = makeWorld();
    for (const flag of ["--x-no-common", "--x-capability=extra"]) {
      const result = run(world, ["--x-harness", "codex", flag]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`${flag} is retired`);
      expect(result.stdout).toBe("");
    }
    expect(balanceCalls(world)).toEqual([]);
  });

  test("claude composes the cswap prefix around the injected defaults", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "claude",
      "hi there",
      "--x-no-yolo",
      "--x-dry-run",
      "--x-json",
    ]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    const data = envelope.data as {
      command: string[];
      balance: { provider: string; route: { slot: number } };
    };
    expect(data.command).toEqual([
      "cswap",
      "run",
      "2",
      "--share-history",
      "--",
      "--model",
      "opus[1m]",
      "--effort",
      "medium",
      "hi there",
    ]);
    expect(data.balance.route.slot).toBe(2);
    expect(balanceCalls(world)).toEqual(["balance claude --json --model opus-1m --dry-run"]);
  });

  test("a forwarded model yields the dimension and drives routing", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "claude",
      "--x-no-yolo",
      "--x-dry-run",
      "--model",
      "fable",
      "-p",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(
      "cswap run 2 --share-history -- --effort medium --model fable -p",
    );
    expect(balanceCalls(world)).toEqual(["balance claude --json --model fable --dry-run"]);
  });

  test("the injected yolo flag rides inside the wrapped command", () => {
    const world = makeWorld();
    const result = run(world, ["--x-harness", "claude", "--x-dry-run", "--x-json"]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as { command: string[] };
    expect(data.command).toEqual([
      "cswap",
      "run",
      "2",
      "--share-history",
      "--",
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "--model",
      "opus[1m]",
      "--effort",
      "medium",
    ]);
  });

  test("codex composes the copy-runnable --account spelling around its spellings", () => {
    const world = makeWorld();
    const result = run(world, ["--x-harness", "codex", "--x-no-yolo", "--x-dry-run", "--x-json"]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as {
      command: string[];
      balance: { accountKey: string; leaseId: string | null };
    };
    expect(data.command).toEqual([
      "codex-swap",
      "run",
      "--account",
      "account:org-test",
      "--",
      "-c",
      SHADCN_MCP,
      // A launch anchors Codex to the directory it was typed in.
      "--cd",
      realpathSync(world.root),
      "--model",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
    ]);
    expect(data.balance.leaseId).toBeNull();
    // Dry runs never claim.
    expect(balanceCalls(world)).toEqual(["balance codex --json --model gpt-5.6-sol"]);
  });

  test("codex's -m short yields the model dimension and drives routing", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "codex",
      "-m",
      "gpt-x",
      "--x-no-yolo",
      "--x-dry-run",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(
      `codex-swap run --account account:org-test -- -c '${SHADCN_MCP}' --cd ${realpathSync(world.root)} -c 'model_reasoning_effort="high"' -m gpt-x`,
    );
    expect(balanceCalls(world)).toEqual(["balance codex --json --model gpt-x"]);
  });

  test("codex exec stays native while fleet resources and balance compose", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "codex",
      "--x-no-yolo",
      "--x-dry-run",
      "--x-json",
      "exec",
      "hello",
    ]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as {
      command: string[];
      balance: { accountKey: string };
    };
    expect(data.command).toEqual([
      "codex-swap",
      "run",
      "--account",
      "account:org-test",
      "--",
      "--cd",
      realpathSync(world.root),
      "--model",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      "exec",
      "-c",
      SHADCN_MCP,
      "hello",
    ]);
    expect(data.command).not.toContain("--remote");
    expect(data.balance.accountKey).toBe("account:org-test");
    expect(balanceCalls(world)).toEqual(["balance codex --json --model gpt-5.6-sol"]);
  });

  test("a level routes on its requested model", () => {
    const world = makeWorld();
    const result = run(world, ["--x-level", "gpt-5.6-luna:max", "--x-no-yolo", "--x-dry-run"]);
    expect(result.code).toBe(0);
    expect(balanceCalls(world)).toEqual(["balance codex --json --model gpt-5.6-luna"]);
  });

  test("--x-account pins codex without a balance call", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "codex",
      "--x-account",
      "you@example.com",
      "--x-no-yolo",
      "--x-dry-run",
      "--x-json",
    ]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as {
      command: string[];
      balance: { reason: string };
    };
    expect(data.command.slice(0, 4)).toEqual(["codex-swap", "run", "--account", "you@example.com"]);
    expect(data.balance.reason).toBe("requested-account");
    expect(balanceCalls(world)).toEqual([]);
  });

  test("--x-account forwards to balance for claude", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "claude",
      "--x-account",
      "c1",
      "--x-no-yolo",
      "--x-dry-run",
    ]);
    expect(result.code).toBe(0);
    expect(balanceCalls(world)).toEqual([
      "balance claude --json --model opus-1m --account c1 --dry-run",
    ]);
  });

  test("--x-no-balance and AGENTLAUNCH_NO_BALANCE launch raw", () => {
    const world = makeWorld();
    const flagged = run(world, [
      "--x-harness",
      "claude",
      "--x-no-balance",
      "--x-no-yolo",
      "--x-dry-run",
      "--x-json",
    ]);
    expect(flagged.code).toBe(0);
    const flaggedData = (JSON.parse(flagged.stdout) as AnyEnvelope).data as {
      command: string[];
      balance: null;
    };
    expect(flaggedData.command).toEqual(["claude", "--model", "opus[1m]", "--effort", "medium"]);
    expect(flaggedData.balance).toBeNull();

    const env = run(world, ["--x-harness", "codex", "--x-no-yolo", "--x-dry-run", "--x-json"], {
      AGENTLAUNCH_NO_BALANCE: "1",
    });
    expect(env.code).toBe(0);
    expect(((JSON.parse(env.stdout) as AnyEnvelope).data as { command: string[] }).command[0]).toBe(
      "codex",
    );
    expect(balanceCalls(world)).toEqual([]);
  });

  test("--x-account with --x-no-balance is a usage fault", () => {
    const world = makeWorld();
    const result = run(world, ["--x-harness", "claude", "--x-account", "c1", "--x-no-balance"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--x-account pins a balanced launch");
  });

  test("balance refusal is a domain error with the recovery, never a raw launch", () => {
    const world = makeWorld();
    writeFileSync(
      join(world.binDir, "codex.json"),
      JSON.stringify({
        schema_version: 1,
        ok: false,
        error: { code: "no-eligible-account", message: "every account is exhausted" },
      }),
    );
    writeFileSync(join(world.binDir, "exit-code"), "3");
    const result = run(world, ["--x-harness", "codex", "--x-dry-run", "--x-json"]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("balance_no_eligible_account");
    expect(envelope.error?.recovery).toContain("--x-no-balance");
  });

  test("a missing stack refuses with an actionable recovery", () => {
    const world = makeWorld();
    rmSync(join(world.binDir, "agentusage"));
    // PATH without the real stack — only the fake bin dir and bun itself —
    // so the real agentusage can never leak into this refusal.
    const result = run(world, ["--x-harness", "claude", "--x-dry-run", "--x-json"], {
      PATH: `${world.binDir}:${dirname(process.execPath)}`,
    });
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    expect(envelope.error?.code).toBe("balance_unavailable");
    expect(envelope.error?.recovery).toContain("AGENTLAUNCH_NO_BALANCE");
  });

  test("a utility invocation passes through without balance or injection", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "codex",
      "--x-dry-run",
      "--x-json",
      "login",
      "--device-auth",
    ]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as {
      command: string[];
      balance: null;
      utility: boolean;
    };
    expect(data.command).toEqual(["codex", "login", "--device-auth"]);
    expect(data.balance).toBeNull();
    expect(data.utility).toBe(true);
    expect(balanceCalls(world)).toEqual([]);
  });

  test("a utility invocation works even when the stack is missing entirely", () => {
    const world = makeWorld();
    rmSync(join(world.binDir, "agentusage"));
    const result = run(world, ["--x-harness", "codex", "--x-dry-run", "--x-json", "--version"], {
      PATH: `${world.binDir}:${dirname(process.execPath)}`,
    });
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as { command: string[] };
    expect(data.command).toEqual(["codex", "--version"]);
  });

  test("--x-account on a utility invocation is a usage fault, not a silent drop", () => {
    const world = makeWorld();
    const result = run(world, ["--x-harness", "codex", "--x-account", "acc_x", "login"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("utility invocation");
    expect(balanceCalls(world)).toEqual([]);
  });
});

describe("balanced resume", () => {
  test("claude resume leaves the session's model native and out of balance routing", () => {
    const world = makeWorld();
    const store = join(world.root, "claude", "projects", "-some-cwd");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, `${SESSION_ID}.jsonl`),
      `${JSON.stringify({ cwd: "/some/cwd" })}\n${JSON.stringify({
        message: { model: "claude-fable-5" },
      })}\n${" ".repeat(300_000)}\n${JSON.stringify({
        message: { model: "claude-opus-5" },
      })}\n`,
    );
    const result = run(world, ["x-resume", SESSION_ID, "--x-no-yolo", "--x-dry-run", "--x-json"]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as { command: string[] };
    expect(data.command).toEqual([
      "cswap",
      "run",
      "2",
      "--share-history",
      "--",
      "--resume",
      SESSION_ID,
    ]);
    expect(balanceCalls(world)).toEqual(["balance claude --json --dry-run"]);
  });

  test("codex resume moves the session id into the wrapper grammar", () => {
    const world = makeWorld();
    const result = run(world, [
      "x-resume",
      SESSION_ID,
      "--x-harness",
      "codex",
      "--x-no-yolo",
      "--x-dry-run",
      "--x-json",
    ]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as { command: string[] };
    expect(data.command).toEqual([
      "codex-swap",
      "resume",
      SESSION_ID,
      "--account",
      "account:org-test",
      "--",
      "-c",
      SHADCN_MCP,
    ]);
  });
});

describe("compose units", () => {
  test("claimed codex launches use --claim", () => {
    expect(
      composeCodex(
        {
          harness: "codex",
          command: ["codex", "-p", "x"],
          sessionId: null,
        },
        ["--claim", "lease-1"],
      ),
    ).toEqual(["codex-swap", "run", "--claim", "lease-1", "--", "-p", "x"]);
    expect(
      composeCodex(
        {
          harness: "codex",
          command: ["codex", "resume", SESSION_ID, "--search"],
          sessionId: SESSION_ID,
        },
        ["--claim", "lease-1"],
      ),
    ).toEqual(["codex-swap", "resume", SESSION_ID, "--claim", "lease-1", "--", "--search"]);
  });
});

describe("shim support", () => {
  test("real launches carry the AGENTLAUNCH_LAUNCH sentinel", () => {
    const world = makeWorld();
    const probe = join(world.binDir, "claude");
    const out = join(world.root, "sentinel.txt");
    writeFileSync(
      probe,
      `#!/usr/bin/env bash\nprintf '%s' "\${AGENTLAUNCH_LAUNCH:-unset}" > ${JSON.stringify(out)}\n`,
    );
    chmodSync(probe, 0o755);
    const result = run(world, ["--x-harness", "claude", "--x-no-balance"]);
    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("1");
  });
});
