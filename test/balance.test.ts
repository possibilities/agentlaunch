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
import { balanceDisabledBy } from "../src/balance.ts";
import type { Envelope } from "../src/envelope.ts";
import { seedFleetResources } from "./resource-fixture.ts";

type AnyEnvelope = Envelope<Record<string, unknown>>;

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const SESSION_ID = "05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60";
const PROVIDER_ARGS = [
  "-c",
  'model_provider="agentusage"',
  "-c",
  'model_providers.agentusage={name="AgentUsage",base_url="http://127.0.0.1:43623/codex",env_key="AGENTUSAGE_AUTH_TOKEN",wire_api="responses",requires_openai_auth=false,supports_websockets=false}',
];
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
 * planned native commands without the real account service.
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
      account_key: "claude-2",
      args: [],
      env: { AGENTUSAGE_ACCOUNT: "claude-2" },
      unset_env: [],
      lease: null,
      reason: "selected",
    }),
  );
  writeFileSync(
    join(binDir, "codex.json"),
    JSON.stringify({
      schema_version: 1,
      provider: "codex",
      ok: true,
      account_key: "codex-1",
      args: PROVIDER_ARGS,
      env: { AGENTUSAGE_ACCOUNT: "codex-1" },
      unset_env: [],
      lease: null,
      reason: "highest headroom",
    }),
  );
  return { root, binDir, recordPath };
}

function run(
  world: World,
  args: string[],
  extraEnv: Record<string, string> = {},
  stripFleet = true,
): RunResult {
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
    if (stripFleet && Array.isArray(data?.command)) {
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
  test("an explicit role composes with yolo and account preparation without fleet resources", () => {
    const world = makeWorld();
    const role = join(world.root, "roles", "worker");
    mkdirSync(role, { recursive: true });
    const roleMcp = 'mcp_servers.agentchats={command="agentchats",args=["mcp"]}';
    const result = run(
      world,
      ["--x-harness", "codex", "--x-dry-run", "--x-json", "-c", roleMcp, "hello"],
      {
        AGENTLAUNCH_ROLE_RESOURCES: "agentroles-v1",
        AGENTROLES_ROLE: role,
        AGENTROLES_NAME: "worker",
      },
      false,
    );
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as {
      command: string[];
      reprepare_command: string[];
      resources: { root: string };
      balance: { accountKey: string };
      yolo: boolean;
    };
    expect(data.command).toContain(roleMcp);
    expect(data.command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(data.command).toContain('model_provider="agentusage"');
    expect(data.command.some((token) => token.startsWith("skills.config="))).toBe(false);
    expect(data.command).not.toContain(SHADCN_MCP);
    expect(data.resources).toEqual({ root: role });
    expect(data.balance.accountKey).toBe("codex-1");
    expect(data.yolo).toBe(true);
    expect(data.reprepare_command.slice(0, 5)).toEqual([
      "/usr/bin/env",
      "AGENTLAUNCH_ROLE_RESOURCES=agentroles-v1",
      `AGENTROLES_ROLE=${role}`,
      "AGENTROLES_NAME=worker",
      "agentlaunch",
    ]);
    expect(balanceCalls(world)).toEqual(["prepare codex --json --model gpt-5.6-sol --dry-run"]);
  });

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

  test("Claude prepares with the injected defaults", () => {
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
      "claude",
      "--model",
      "opus[1m]",
      "--effort",
      "medium",
      "hi there",
    ]);
    expect(data.balance.route.slot).toBe(2);
    expect(balanceCalls(world)).toEqual(["prepare claude --json --model opus-1m --dry-run"]);
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
      `(cd ${realpathSync(world.root)} && agentlaunch --x-harness claude --x-account claude-2 --x-no-yolo --effort medium --model fable -p)`,
    );
    expect(balanceCalls(world)).toEqual(["prepare claude --json --model fable --dry-run"]);
  });

  test("the injected yolo flag rides inside the native command", () => {
    const world = makeWorld();
    const result = run(world, ["--x-harness", "claude", "--x-dry-run", "--x-json"]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as { command: string[] };
    expect(data.command).toEqual([
      "claude",
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "--model",
      "opus[1m]",
      "--effort",
      "medium",
    ]);
  });

  test("Codex exposes a planned native command without a lease", () => {
    const world = makeWorld();
    const result = run(world, ["--x-harness", "codex", "--x-no-yolo", "--x-dry-run", "--x-json"]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as {
      command: string[];
      balance: { accountKey: string; leaseId: string | null };
    };
    expect(data.command).toEqual([
      "codex",
      "-c",
      SHADCN_MCP,
      // A launch anchors Codex to the directory it was typed in.
      "--cd",
      realpathSync(world.root),
      "--model",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      ...PROVIDER_ARGS,
    ]);
    expect(data.balance.leaseId).toBeNull();
    // Dry runs never claim.
    expect(balanceCalls(world)).toEqual(["prepare codex --json --model gpt-5.6-sol --dry-run"]);
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
      `(cd ${realpathSync(world.root)} && agentlaunch --x-harness codex --x-account codex-1 --x-no-yolo --cd ${realpathSync(world.root)} -c 'model_reasoning_effort="high"' -m gpt-x)`,
    );
    expect(balanceCalls(world)).toEqual(["prepare codex --json --model gpt-x --dry-run"]);
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
      "codex",
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
      ...PROVIDER_ARGS,
    ]);
    expect(data.command).not.toContain("--remote");
    expect(data.balance.accountKey).toBe("codex-1");
    expect(balanceCalls(world)).toEqual(["prepare codex --json --model gpt-5.6-sol --dry-run"]);
  });

  test("a level routes on its requested model", () => {
    const world = makeWorld();
    const result = run(world, ["--x-level", "gpt-5.6-luna:max", "--x-no-yolo", "--x-dry-run"]);
    expect(result.code).toBe(0);
    expect(balanceCalls(world)).toEqual(["prepare codex --json --model gpt-5.6-luna --dry-run"]);
  });

  test("explicit Codex pins prepare afresh", () => {
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
    expect(data.command.slice(-4)).toEqual(PROVIDER_ARGS);
    expect(balanceCalls(world)).toEqual([
      "prepare codex --json --model gpt-5.6-sol --account you@example.com --dry-run",
    ]);
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
      "prepare claude --json --model opus-1m --account c1 --dry-run",
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
        provider: "codex",
        refusal: "no-eligible-account",
        detail: "every account is exhausted",
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
    expect(envelope.error?.recovery).toContain("--x-no-balance");
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
    expect(data.command).toEqual(["claude", "--resume", SESSION_ID]);
    expect(balanceCalls(world)).toEqual(["prepare claude --json --dry-run"]);
  });

  test("Codex resume keeps transport config in its native scope", () => {
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
      "codex",
      "resume",
      SESSION_ID,
      "-c",
      SHADCN_MCP,
      ...PROVIDER_ARGS,
    ]);
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

describe("balance defaults", () => {
  test("disable controls override config and stay scoped", () => {
    for (const harness of ["claude", "codex"] as const) {
      const own = `AGENTLAUNCH_${harness.toUpperCase()}_NO_BALANCE`;
      const other =
        harness === "claude" ? "AGENTLAUNCH_CODEX_NO_BALANCE" : "AGENTLAUNCH_CLAUDE_NO_BALANCE";
      expect(balanceDisabledBy({}, false, harness, true)).toBeNull();
      expect(balanceDisabledBy({}, false, harness, false)).toBe(`config balance.${harness}`);
      expect(balanceDisabledBy({ [other]: "1" }, false, harness, true)).toBeNull();
      expect(balanceDisabledBy({ [own]: "" }, false, harness, true)).toBeNull();
      for (const value of ["1", "0", "false"]) {
        expect(balanceDisabledBy({ [own]: value }, false, harness, true)).toBe(own);
        expect(
          balanceDisabledBy({ AGENTLAUNCH_NO_BALANCE: value, [own]: "" }, false, harness, true),
        ).toBe("AGENTLAUNCH_NO_BALANCE");
      }
      expect(balanceDisabledBy({ [own]: "1" }, true, harness, false)).toBe("--x-no-balance");
    }
  });

  test.each([
    "claude",
    "codex",
  ] as const)("config and environment skip account preparation for %s", (harness) => {
    const world = makeWorld();
    const directory = join(world.root, "home", ".config", "agentlaunch");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "config.json");
    const args = ["--x-harness", harness, "--x-dry-run", "--x-json"];
    writeFileSync(path, JSON.stringify({ balance: { [harness]: false } }));
    const configured = run(world, args);
    expect(configured.code).toBe(0);
    expect(JSON.parse(configured.stdout).data.command[0]).toBe(harness);
    expect(JSON.parse(configured.stdout).data.balance).toBeNull();
    expect(balanceCalls(world)).toEqual([]);
    const pinned = run(world, [...args, "--x-account", "1"]);
    expect(pinned.code).toBe(2);
    expect(pinned.stderr).toContain("balancing is disabled");
    writeFileSync(path, JSON.stringify({ balance: true }));
    const switched = run(world, args, { [`AGENTLAUNCH_${harness.toUpperCase()}_NO_BALANCE`]: "1" });
    expect(switched.code).toBe(0);
    expect(JSON.parse(switched.stdout).data.command[0]).toBe(harness);
    expect(balanceCalls(world)).toEqual([]);
    const other = harness === "claude" ? "codex" : "claude";
    writeFileSync(path, JSON.stringify({ balance: { [other]: false } }));
    const balanced = run(world, args);
    expect(balanced.code).toBe(0);
    expect(JSON.parse(balanced.stdout).data.command[0]).toBe(harness);
    expect(balanceCalls(world).length).toBe(1);
  });
});

describe("native auth resume defaults", () => {
  test.each(["claude", "codex"] as const)("resumes %s without selection or swap", (harness) => {
    const world = makeWorld();
    const directory = join(world.root, "home", ".config", "agentlaunch");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "config.json"), JSON.stringify({ balance: false }));
    const args = [
      "x-resume",
      SESSION_ID,
      "--x-harness",
      harness,
      "--x-no-yolo",
      "--x-dry-run",
      "--x-json",
    ];
    const result = run(world, args);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data.command[0]).toBe(harness);
    expect(data.command).toContain(SESSION_ID);
    expect(data.balance).toBeNull();
    expect(balanceCalls(world)).toEqual([]);
    writeFileSync(join(directory, "config.json"), JSON.stringify({ balance: true }));
    const switched = run(world, args, { [`AGENTLAUNCH_${harness.toUpperCase()}_NO_BALANCE`]: "1" });
    expect(switched.code).toBe(0);
    expect(JSON.parse(switched.stdout).data.command[0]).toBe(harness);
    expect(balanceCalls(world)).toEqual([]);
  });
});

describe("prepare safety", () => {
  test.each([
    "--oss",
    "--local-provider=ollama",
    "-cmodel_provider=other",
    "--config=model_providers.agentusage.base_url=evil",
  ])("rejects %s before reserving", (flag) => {
    const world = makeWorld();
    const result = run(world, ["--x-harness", "codex", flag, "--x-dry-run"]);
    expect(result.code).toBe(2);
    expect(balanceCalls(world)).toEqual([]);
  });
  test.each(
    [
      [
        "-p",
        "proof",
        "exec",
        "-c",
        'model_reasoning_effort="low"',
        "Discuss --config=model_provider=other",
      ],
      [
        "-p",
        "proof",
        "exec",
        "resume",
        SESSION_ID,
        "-c",
        'model_reasoning_effort="low"',
        "--",
        "-cmodel_provider=prompt",
      ],
      ["resume", SESSION_ID, "-c", 'model_reasoning_effort="low"', "--", "--oss"],
      ["e", "--", "--local-provider=prompt"],
      ["review", "--", "--config=model_provider=prompt"],
    ].map((native) => ({ native })),
  )("native config scope and literal prompt tokens survive %j", ({ native }) => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "codex",
      "--x-no-yolo",
      "--x-dry-run",
      "--x-json",
      ...native,
    ]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout).data;
    const command = data.command as string[];
    const boundary = command.indexOf("--");
    const at = boundary < 0 ? command.length : boundary;
    expect(command.slice(at - PROVIDER_ARGS.length, at)).toEqual(PROVIDER_ARGS);
    expect(command.indexOf(SHADCN_MCP)).toBeLessThan(at - PROVIDER_ARGS.length);
    const originalBoundary = native.indexOf("--");
    if (originalBoundary >= 0)
      expect(command.slice(boundary)).toEqual(native.slice(originalBoundary));
    if (native.includes("exec") && native.includes("resume"))
      expect(command.indexOf(SHADCN_MCP)).toBeGreaterThan(command.indexOf("resume"));
    for (const token of native) expect(command).toContain(token);
    expect(balanceCalls(world)).toHaveLength(1);
  });
  test("native text option values that look like auth flags remain opaque", () => {
    const world = makeWorld();
    const result = run(world, [
      "--x-harness",
      "claude",
      "--system-prompt",
      "--settings=example",
      "--x-dry-run",
      "--x-json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.command).toContain("--settings=example");
    expect(balanceCalls(world)).toHaveLength(1);
  });
  test("AgentVoice app-server stays a utility without provider or resource injection", () => {
    const world = makeWorld();
    const result = run(world, ["--x-harness", "codex", "app-server", "--x-dry-run", "--x-json"]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data.command).toEqual(["codex", "app-server"]);
    expect(data.balance).toBeNull();
    expect(balanceCalls(world)).toEqual([]);
  });
  test("JSON dry run documents a planned command and a credential-free re-prepare invocation", () => {
    const world = makeWorld();
    const result = run(world, ["--x-harness", "codex", "exec", "hello", "--x-dry-run", "--x-json"]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data.command_requires_prepare).toBe(true);
    expect(data.reprepare_command.slice(0, 5)).toEqual([
      "agentlaunch",
      "--x-harness",
      "codex",
      "--x-account",
      "codex-1",
    ]);
    expect(data.reprepare_command).not.toContain("--x-dry-run");
    expect(data.balance.leaseId).toBeNull();
    expect(data.env).toBeUndefined();
    expect(data.lease).toBeUndefined();
  });
});
