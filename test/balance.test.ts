import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeCodexFamily, normalizePiModel } from "../src/balance.ts";
import type { Envelope } from "../src/envelope.ts";

type AnyEnvelope = Envelope<Record<string, unknown>>;

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const SESSION_ID = "05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60";

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
  const root = mkdtempSync(join(tmpdir(), "agentsurface-balance-"));
  roots.push(root);
  const binDir = join(root, "bin");
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
      PI_CODING_AGENT_DIR: join(world.root, "pi"),
      ...extraEnv,
    },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function balanceCalls(world: World): string[] {
  try {
    return readFileSync(world.recordPath, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

describe("balanced open", () => {
  test("claude composes the cswap prefix and forwards the model", () => {
    const world = makeWorld();
    const result = run(world, [
      "open",
      "claude",
      "hi there",
      "--model",
      "fable",
      "--dry-run",
      "--json",
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
      "fable",
      "hi there",
    ]);
    expect(data.balance.route.slot).toBe(2);
    expect(balanceCalls(world)).toEqual(["balance claude --json --model fable --dry-run"]);
  });

  test("codex dry run composes the copy-runnable --account spelling", () => {
    const world = makeWorld();
    const result = run(world, ["open", "codex", "--effort", "xhigh", "--dry-run", "--json"]);
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
      'model_reasoning_effort="xhigh"',
    ]);
    expect(data.balance.leaseId).toBeNull();
    // Dry runs never claim.
    expect(balanceCalls(world)).toEqual(["balance codex --json"]);
  });

  test("pi normalizes the provider-prefixed model for lane selection", () => {
    const world = makeWorld();
    const result = run(world, [
      "open",
      "pi",
      "--model",
      "openai-codex/gpt-5.3-codex-spark",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as { command: string[] };
    expect(data.command.slice(0, 5)).toEqual([
      "codex-swap",
      "pi",
      "run",
      "--account",
      "account:org-test",
    ]);
    expect(data.command.slice(5)).toEqual(["--", "--model", "openai-codex/gpt-5.3-codex-spark"]);
    expect(balanceCalls(world)).toEqual(["balance codex --json --model gpt-5.3-codex-spark"]);
  });

  test("--x-account pins codex without a balance call", () => {
    const world = makeWorld();
    const result = run(world, [
      "open",
      "codex",
      "--x-account",
      "you@example.com",
      "--dry-run",
      "--json",
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
    const result = run(world, ["open", "claude", "--x-account", "c1", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(balanceCalls(world)).toEqual(["balance claude --json --account c1 --dry-run"]);
  });

  test("--x-no-balance and AGENTSURFACE_NO_BALANCE launch raw", () => {
    const world = makeWorld();
    const flagged = run(world, ["open", "claude", "--x-no-balance", "--dry-run", "--json"]);
    expect(flagged.code).toBe(0);
    const flaggedData = (JSON.parse(flagged.stdout) as AnyEnvelope).data as {
      command: string[];
      balance: null;
    };
    expect(flaggedData.command).toEqual(["claude"]);
    expect(flaggedData.balance).toBeNull();

    const env = run(world, ["open", "codex", "--dry-run", "--json"], {
      AGENTSURFACE_NO_BALANCE: "1",
    });
    expect(env.code).toBe(0);
    expect(((JSON.parse(env.stdout) as AnyEnvelope).data as { command: string[] }).command).toEqual(
      ["codex"],
    );
    expect(balanceCalls(world)).toEqual([]);
  });

  test("--x-account with --x-no-balance is a usage fault", () => {
    const world = makeWorld();
    const result = run(world, ["open", "claude", "--x-account", "c1", "--x-no-balance"]);
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
    const result = run(world, ["open", "codex", "--dry-run", "--json"]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("balance_no_eligible_account");
    expect(envelope.error?.message).toBe("every account is exhausted");
    expect(envelope.error?.recovery).toContain("--x-no-balance");
  });

  test("a missing stack refuses with an actionable recovery", () => {
    const world = makeWorld();
    rmSync(join(world.binDir, "agentusage"));
    // PATH without the real stack — only the fake bin dir and bun itself —
    // so the real agentusage can never leak into this refusal.
    const result = run(world, ["open", "claude", "--dry-run", "--json"], {
      PATH: `${world.binDir}:${dirname(process.execPath)}`,
    });
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as AnyEnvelope;
    expect(envelope.error?.code).toBe("balance_unavailable");
    expect(envelope.error?.recovery).toContain("AGENTSURFACE_NO_BALANCE");
  });
});

describe("balanced resume", () => {
  test("claude resume routes on the session's last-used model", () => {
    const world = makeWorld();
    const store = join(world.root, "claude", "projects", "-some-cwd");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, `${SESSION_ID}.jsonl`),
      `${JSON.stringify({ cwd: "/some/cwd" })}\n${JSON.stringify({
        message: { model: "claude-fable-5" },
      })}\n`,
    );
    const result = run(world, ["resume", SESSION_ID, "--dry-run", "--json"]);
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
    expect(balanceCalls(world)).toEqual(["balance claude --json --model claude-fable-5 --dry-run"]);
  });

  test("an explicit --model in forwarded args wins over the sniff", () => {
    const world = makeWorld();
    const store = join(world.root, "claude", "projects", "-some-cwd");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, `${SESSION_ID}.jsonl`),
      `${JSON.stringify({ message: { model: "claude-fable-5" } })}\n`,
    );
    const result = run(world, ["resume", SESSION_ID, "--dry-run", "--", "--model", "haiku"]);
    expect(result.code).toBe(0);
    expect(balanceCalls(world)).toEqual(["balance claude --json --model haiku --dry-run"]);
  });

  test("codex resume moves the session id into the wrapper grammar", () => {
    const world = makeWorld();
    const result = run(world, ["resume", SESSION_ID, "--harness", "codex", "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as { command: string[] };
    expect(data.command).toEqual([
      "codex-swap",
      "resume",
      SESSION_ID,
      "--account",
      "account:org-test",
      "--",
    ]);
  });

  test("pi resume rides --session through the pi runner", () => {
    const world = makeWorld();
    const result = run(world, ["resume", SESSION_ID, "--harness", "pi", "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    const data = (JSON.parse(result.stdout) as AnyEnvelope).data as { command: string[] };
    expect(data.command).toEqual([
      "codex-swap",
      "pi",
      "run",
      "--account",
      "account:org-test",
      "--",
      "--session",
      SESSION_ID,
    ]);
  });
});

describe("compose units", () => {
  test("claimed codex launches use --claim", () => {
    expect(
      composeCodexFamily({ harness: "codex", command: ["codex", "-p", "x"], sessionId: null }, [
        "--claim",
        "lease-1",
      ]),
    ).toEqual(["codex-swap", "run", "--claim", "lease-1", "--", "-p", "x"]);
    expect(
      composeCodexFamily(
        {
          harness: "codex",
          command: ["codex", "resume", SESSION_ID, "--search"],
          sessionId: SESSION_ID,
        },
        ["--claim", "lease-1"],
      ),
    ).toEqual(["codex-swap", "resume", SESSION_ID, "--claim", "lease-1", "--", "--search"]);
    expect(
      composeCodexFamily(
        { harness: "pi", command: ["pi", "--session", SESSION_ID], sessionId: SESSION_ID },
        ["--claim", "lease-1"],
      ),
    ).toEqual(["codex-swap", "pi", "run", "--claim", "lease-1", "--", "--session", SESSION_ID]);
  });

  test("pi model normalization strips only the provider prefix", () => {
    expect(normalizePiModel("pi", "openai-codex/gpt-5.4")).toBe("gpt-5.4");
    expect(normalizePiModel("pi", "gpt-5.4")).toBe("gpt-5.4");
    expect(normalizePiModel("codex", "openai-codex/gpt-5.4")).toBe("openai-codex/gpt-5.4");
    expect(normalizePiModel("pi", undefined)).toBeUndefined();
  });
});
