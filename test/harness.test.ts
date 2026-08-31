import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../src/errors.ts";
import {
  applyYolo,
  buildOpen,
  buildResume,
  codexNonInteractiveCommandIndex,
  effortArguments,
  effortDimensionToken,
  modelArguments,
  modelDimensionToken,
  parseHarnessName,
  sessionFileFacts,
  sessionStore,
  utilityInvocation,
} from "../src/harness.ts";

const ON = { on: true, explicitOff: false };
const OFF = { on: false, explicitOff: false };
const EXPLICIT_OFF = { on: false, explicitOff: true };

describe("parseHarnessName", () => {
  test("accepts the two harnesses", () => {
    expect(parseHarnessName("claude")).toBe("claude");
    expect(parseHarnessName("codex")).toBe("codex");
  });

  test("rejects anything else", () => {
    expect(() => parseHarnessName("cursor")).toThrow(UsageError);
  });
});

describe("buildOpen", () => {
  test("the command is the harness followed by the forwarded tokens, verbatim", () => {
    expect(buildOpen("claude", []).command).toEqual(["claude"]);
    expect(buildOpen("claude", ["fix it", "--model", "fable"]).command).toEqual([
      "claude",
      "fix it",
      "--model",
      "fable",
    ]);
    expect(buildOpen("codex", ["--", "--weird"]).command).toEqual(["codex", "--", "--weird"]);
    expect(buildOpen("claude", []).sessionId).toBeNull();
  });

  test("recognizes Codex non-interactive subcommands without changing transport", () => {
    expect(codexNonInteractiveCommandIndex(["-mgpt-x", "review"])).toBe(1);
  });
});

describe("buildResume", () => {
  test("claude resumes by flag and codex by subcommand", () => {
    expect(buildResume("claude", "abc-123", []).command).toEqual(["claude", "--resume", "abc-123"]);
    expect(buildResume("codex", "abc-123", []).command).toEqual(["codex", "resume", "abc-123"]);
  });

  test("forwarded tokens land after the id and the spec carries the id", () => {
    const spec = buildResume("codex", "abc-123", ["--last-ish"]);
    expect(spec.command).toEqual(["codex", "resume", "abc-123", "--last-ish"]);
    expect(spec.sessionId).toBe("abc-123");
  });
});

describe("utilityInvocation", () => {
  test("management and service words pass through", () => {
    expect(utilityInvocation("codex", ["login", "--device-auth"])).toBe(true);
    expect(utilityInvocation("codex", ["app-server", "--enable", "realtime"])).toBe(true);
    expect(utilityInvocation("codex", ["mcp-server"])).toBe(true);
    expect(utilityInvocation("codex", ["doctor"])).toBe(true);
    expect(utilityInvocation("claude", ["mcp", "list"])).toBe(true);
    expect(utilityInvocation("claude", ["setup-token"])).toBe(true);
  });

  test("bare help and version flags pass through", () => {
    expect(utilityInvocation("codex", ["--version"])).toBe(true);
    expect(utilityInvocation("codex", ["-V"])).toBe(true);
    expect(utilityInvocation("claude", ["--help"])).toBe(true);
  });

  test("session launches balance: bare, prompts, flags, session words", () => {
    expect(utilityInvocation("codex", [])).toBe(false);
    expect(utilityInvocation("codex", ["fix the failing tests"])).toBe(false);
    expect(utilityInvocation("codex", ["--search"])).toBe(false);
    expect(utilityInvocation("codex", ["exec", "hello"])).toBe(false);
    expect(utilityInvocation("codex", ["review"])).toBe(false);
    expect(utilityInvocation("codex", ["resume", "abc"])).toBe(false);
    expect(utilityInvocation("codex", ["fork"])).toBe(false);
    expect(utilityInvocation("claude", ["fix the failing tests"])).toBe(false);
  });

  test("flags ahead of a subcommand classify as a session", () => {
    expect(utilityInvocation("codex", ["-c", "k=v", "login"])).toBe(false);
  });
});

describe("applyYolo", () => {
  test("on injects the canonical spelling at the head of the stream", () => {
    expect(applyYolo("claude", ["--model", "fable"], ON, false).tokens).toEqual([
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "--model",
      "fable",
    ]);
    expect(applyYolo("codex", [], ON, false).injected).toBe(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  test("a forwarded spelling is never duplicated, aliases included", () => {
    const canonical = applyYolo("claude", ["--dangerously-skip-permissions"], ON, false);
    expect(canonical.tokens).toEqual(["--dangerously-skip-permissions"]);
    expect(canonical.injected).toBeNull();
    expect(canonical.present).toBe("--dangerously-skip-permissions");
    // The permitting half alone says nothing about the gates: the missing
    // half is injected, and only that half.
    const permit = applyYolo("claude", ["--allow-dangerously-skip-permissions"], ON, false);
    expect(permit.tokens).toEqual([
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
    ]);
    expect(permit.injected).toBe("--dangerously-skip-permissions");
    const both = applyYolo(
      "claude",
      ["--allow-dangerously-skip-permissions", "--dangerously-skip-permissions"],
      ON,
      false,
    );
    expect(both.injected).toBeNull();
  });

  test("claude's gate flag set any other way is the caller's decision", () => {
    const plan = applyYolo("claude", ["--permission-mode", "plan"], ON, false);
    expect(plan.tokens).toEqual(["--permission-mode", "plan"]);
    expect(plan.injected).toBeNull();
    expect(plan.present).toBe("--permission-mode plan");
    expect(plan.presentNegative).toBe(true);
    // Auto is a mode the caller chose, not the spelling this launcher emits.
    const auto = applyYolo("claude", ["--permission-mode", "auto"], ON, false);
    expect(auto.injected).toBeNull();
    expect(auto.presentNegative).toBe(true);
    const attached = applyYolo("claude", ["--permission-mode=plan"], ON, false);
    expect(attached.injected).toBeNull();
    expect(attached.presentNegative).toBe(true);
    // A value the caller never chose the mode for is not a mode.
    const dangling = applyYolo("claude", ["--permission-mode"], ON, false);
    expect(dangling.injected).toBe(
      "--dangerously-skip-permissions --allow-dangerously-skip-permissions",
    );
  });

  test("utility invocations never get the flag", () => {
    expect(applyYolo("codex", ["login", "--device-auth"], ON, true).tokens).toEqual([
      "login",
      "--device-auth",
    ]);
  });

  test("config-off declines to inject but strips nothing", () => {
    const kept = applyYolo("claude", ["--dangerously-skip-permissions"], OFF, false);
    expect(kept.tokens).toEqual(["--dangerously-skip-permissions"]);
    expect(kept.redacted).toEqual([]);
  });

  test("an explicit off redacts forwarded spellings and reports them", () => {
    const redacted = applyYolo(
      "claude",
      ["--dangerously-skip-permissions", "--model", "fable"],
      EXPLICIT_OFF,
      false,
    );
    expect(redacted.tokens).toEqual(["--model", "fable"]);
    expect(redacted.redacted).toEqual(["--dangerously-skip-permissions"]);
    // A canonical pair leaves whole.
    const pair = applyYolo(
      "claude",
      [
        "--dangerously-skip-permissions",
        "--allow-dangerously-skip-permissions",
        "--model",
        "fable",
      ],
      EXPLICIT_OFF,
      false,
    );
    expect(pair.tokens).toEqual(["--model", "fable"]);
    expect(pair.redacted).toEqual([
      "--dangerously-skip-permissions --allow-dangerously-skip-permissions",
    ]);
    // A mode is the caller's own, not ours to remove.
    const mode = applyYolo("claude", ["--permission-mode", "auto"], EXPLICIT_OFF, false);
    expect(mode.tokens).toEqual(["--permission-mode", "auto"]);
    expect(mode.redacted).toEqual([]);
    const other = applyYolo("claude", ["--permission-mode", "plan"], EXPLICIT_OFF, false);
    expect(other.tokens).toEqual(["--permission-mode", "plan"]);
    expect(other.redacted).toEqual([]);
  });
});

describe("model and effort spellings", () => {
  test("model emission is --model with the resolved spelling", () => {
    expect(modelArguments("opus[1m]")).toEqual(["--model", "opus[1m]"]);
  });

  test("effort emission is per harness", () => {
    expect(effortArguments("claude", "medium")).toEqual(["--effort", "medium"]);
    expect(effortArguments("codex", "high")).toEqual(["-c", 'model_reasoning_effort="high"']);
  });

  test("model-dimension detection sees --model, --model=, and every codex -m and config shape", () => {
    expect(modelDimensionToken("claude", ["-p", "hi", "--model", "opus"])).toBe("--model");
    expect(modelDimensionToken("claude", ["--model=opus"])).toBe("--model=opus");
    expect(modelDimensionToken("codex", ["-m", "gpt-x"])).toBe("-m");
    expect(modelDimensionToken("codex", ["-m=gpt-x"])).toBe("-m=gpt-x");
    // clap's attached short form: one fewer space must not bypass the refusal.
    expect(modelDimensionToken("codex", ["-mgpt-x"])).toBe("-mgpt-x");
    // The config spelling sets the same dimension, in all three clap shapes.
    expect(modelDimensionToken("codex", ["-c", "model=gpt-x"])).toBe("-c model=gpt-x");
    expect(modelDimensionToken("codex", ["--config", "model=gpt-x"])).toBe("--config model=gpt-x");
    expect(modelDimensionToken("codex", ["-c=model=gpt-x"])).toBe("-c=model=gpt-x");
    expect(modelDimensionToken("codex", ["-cmodel=gpt-x"])).toBe("-cmodel=gpt-x");
    // Other config keys are not the model dimension.
    expect(modelDimensionToken("codex", ["-c", "model_provider=oss"])).toBeNull();
    expect(modelDimensionToken("codex", ["-cmodel_reasoning_effort=high"])).toBeNull();
    expect(modelDimensionToken("claude", ["-m", "gpt-x"])).toBeNull();
  });

  test("effort-dimension detection is per harness, codex via -c pairs", () => {
    expect(effortDimensionToken("claude", ["--effort", "max"])).toBe("--effort");
    expect(effortDimensionToken("claude", ["--effort=max"])).toBe("--effort=max");
    expect(effortDimensionToken("codex", ["-c", 'model_reasoning_effort="low"'])).toBe(
      '-c model_reasoning_effort="low"',
    );
    expect(effortDimensionToken("codex", ["--config", "model_reasoning_effort=low"])).toBe(
      "--config model_reasoning_effort=low",
    );
    expect(effortDimensionToken("codex", ["-c", "other=1"])).toBeNull();
    expect(effortDimensionToken("codex", ["--effort", "max"])).toBeNull();
  });

  test("effort-dimension detection covers split, inline, and attached codex spellings", () => {
    // split form: `-c value` / `--config value`
    expect(effortDimensionToken("codex", ["-c", "model_reasoning_effort=high"])).toBe(
      "-c model_reasoning_effort=high",
    );
    expect(effortDimensionToken("codex", ["--config", "model_reasoning_effort=high"])).toBe(
      "--config model_reasoning_effort=high",
    );
    // inline form: `-c=value` / `--config=value`
    expect(effortDimensionToken("codex", ["-c=model_reasoning_effort=high"])).toBe(
      "-c=model_reasoning_effort=high",
    );
    expect(effortDimensionToken("codex", ["--config=model_reasoning_effort=high"])).toBe(
      "--config=model_reasoning_effort=high",
    );
    // attached short form: `-cvalue`, which codex's parser accepts with no
    // separator at all — verified against `codex -cmodel_reasoning_effort=high
    // features`, which parses exactly as `codex features` does.
    expect(effortDimensionToken("codex", ["-cmodel_reasoning_effort=high"])).toBe(
      "-cmodel_reasoning_effort=high",
    );
    // unrelated keys do not match in any of the three spellings
    expect(effortDimensionToken("codex", ["-c=other=1"])).toBeNull();
    expect(effortDimensionToken("codex", ["--config=other=1"])).toBeNull();
    expect(effortDimensionToken("codex", ["-cother=1"])).toBeNull();
  });
});

describe("sessionStore", () => {
  const home = "/home/user";

  test("defaults live under the home directory", () => {
    expect(sessionStore("claude", {}, home).root).toBe("/home/user/.claude/projects");
    expect(sessionStore("codex", {}, home).root).toBe("/home/user/.codex");
  });

  test("env overrides relocate the store and are reported active", () => {
    const claude = sessionStore("claude", { CLAUDE_CONFIG_DIR: "/profiles/a" }, home);
    expect(claude.root).toBe("/profiles/a/projects");
    expect(claude.overrideActive).toBe(true);

    const codex = sessionStore("codex", { CODEX_HOME: "~/codex-home" }, home);
    expect(codex.root).toBe("/home/user/codex-home");
    expect(codex.overrideActive).toBe(true);
  });

  test("empty overrides do not count as active", () => {
    const store = sessionStore("codex", { CODEX_HOME: "" }, home);
    expect(store.root).toBe("/home/user/.codex");
    expect(store.overrideActive).toBe(false);
  });
});

describe("sessionFileFacts", () => {
  test("reads native cwd and ids from claude and codex files", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlaunch-session-facts-"));
    try {
      const claude = join(root, "claude-id.jsonl");
      const codex = join(root, "rollout-codex-id.jsonl");
      writeFileSync(claude, `${JSON.stringify({ cwd: "/work/claude" })}\n`);
      writeFileSync(
        codex,
        `${JSON.stringify({ type: "session_meta", payload: { id: "codex-id", cwd: "/work/codex" } })}\n`,
      );

      expect(await sessionFileFacts("claude", claude)).toEqual({
        cwd: "/work/claude",
        sessionId: "claude-id",
      });
      expect(await sessionFileFacts("codex", codex)).toEqual({
        cwd: "/work/codex",
        sessionId: "codex-id",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
