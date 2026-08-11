import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "../src/errors.ts";
import type { TrustOutcome } from "../src/harness.ts";
import {
  applyYolo,
  buildOpen,
  buildResume,
  effortArguments,
  effortDimensionToken,
  ensureWorkspaceTrusted,
  modelArguments,
  modelDimensionToken,
  nameArguments,
  nameDimensionToken,
  parseHarnessName,
  sessionStore,
  utilityInvocation,
} from "../src/harness.ts";

const ON = { on: true, explicitOff: false };
const OFF = { on: false, explicitOff: false };
const EXPLICIT_OFF = { on: false, explicitOff: true };

describe("parseHarnessName", () => {
  test("accepts the three harnesses", () => {
    expect(parseHarnessName("claude")).toBe("claude");
    expect(parseHarnessName("codex")).toBe("codex");
    expect(parseHarnessName("pi")).toBe("pi");
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
});

describe("buildResume", () => {
  test("claude resumes by flag, codex by subcommand, pi by --session", () => {
    expect(buildResume("claude", "abc-123", []).command).toEqual(["claude", "--resume", "abc-123"]);
    expect(buildResume("codex", "abc-123", []).command).toEqual(["codex", "resume", "abc-123"]);
    expect(buildResume("pi", "abc-123", []).command).toEqual(["pi", "--session", "abc-123"]);
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
    expect(utilityInvocation("pi", ["auth", "status"])).toBe(true);
  });

  test("bare help and version flags pass through", () => {
    expect(utilityInvocation("codex", ["--version"])).toBe(true);
    expect(utilityInvocation("codex", ["-V"])).toBe(true);
    expect(utilityInvocation("claude", ["--help"])).toBe(true);
    expect(utilityInvocation("pi", ["-h"])).toBe(true);
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
    expect(utilityInvocation("pi", ["-p", "hello"])).toBe(false);
  });

  test("flags ahead of a subcommand classify as a session", () => {
    expect(utilityInvocation("codex", ["-c", "k=v", "login"])).toBe(false);
  });
});

describe("applyYolo", () => {
  test("on injects the canonical spelling at the head of the stream", () => {
    expect(applyYolo("claude", ["--model", "fable"], ON, false).tokens).toEqual([
      "--permission-mode",
      "auto",
      "--model",
      "fable",
    ]);
    expect(applyYolo("codex", [], ON, false).injected).toBe(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(applyYolo("pi", [], ON, false).tokens).toEqual(["--approve"]);
  });

  test("a forwarded spelling is never duplicated, aliases included", () => {
    const canonical = applyYolo("claude", ["--dangerously-skip-permissions"], ON, false);
    expect(canonical.tokens).toEqual(["--dangerously-skip-permissions"]);
    expect(canonical.injected).toBeNull();
    expect(canonical.present).toBe("--dangerously-skip-permissions");
    const short = applyYolo("pi", ["-a"], ON, false);
    expect(short.tokens).toEqual(["-a"]);
    expect(short.injected).toBeNull();
    const auto = applyYolo("claude", ["--permission-mode", "auto"], ON, false);
    expect(auto.tokens).toEqual(["--permission-mode", "auto"]);
    expect(auto.injected).toBeNull();
    expect(auto.present).toBe("--permission-mode auto");
    const attached = applyYolo("claude", ["--permission-mode=auto"], ON, false);
    expect(attached.injected).toBeNull();
    expect(attached.presentNegative).toBe(false);
  });

  test("claude's gate flag set any other way is the caller's decision", () => {
    const plan = applyYolo("claude", ["--permission-mode", "plan"], ON, false);
    expect(plan.tokens).toEqual(["--permission-mode", "plan"]);
    expect(plan.injected).toBeNull();
    expect(plan.present).toBe("--permission-mode plan");
    expect(plan.presentNegative).toBe(true);
    const attached = applyYolo("claude", ["--permission-mode=plan"], ON, false);
    expect(attached.injected).toBeNull();
    expect(attached.presentNegative).toBe(true);
    // A value the caller never chose the mode for is not a mode.
    const dangling = applyYolo("claude", ["--permission-mode"], ON, false);
    expect(dangling.injected).toBe("--permission-mode auto");
  });

  test("pi's own negative wins over injection", () => {
    const negative = applyYolo("pi", ["--no-approve"], ON, false);
    expect(negative.tokens).toEqual(["--no-approve"]);
    expect(negative.injected).toBeNull();
    expect(negative.presentNegative).toBe(true);
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
    const alias = applyYolo("pi", ["-a", "hello"], EXPLICIT_OFF, false);
    expect(alias.tokens).toEqual(["hello"]);
    expect(alias.redacted).toEqual(["-a"]);
    // A valued spelling leaves with its value.
    const pair = applyYolo(
      "claude",
      ["--permission-mode", "auto", "--model", "fable"],
      EXPLICIT_OFF,
      false,
    );
    expect(pair.tokens).toEqual(["--model", "fable"]);
    expect(pair.redacted).toEqual(["--permission-mode auto"]);
    // Another mode is the caller's own, not ours to remove.
    const other = applyYolo("claude", ["--permission-mode", "plan"], EXPLICIT_OFF, false);
    expect(other.tokens).toEqual(["--permission-mode", "plan"]);
    expect(other.redacted).toEqual([]);
  });
});

describe("model and effort spellings", () => {
  test("model emission is --model with the resolved spelling", () => {
    expect(modelArguments("openai-codex/gpt-5.6-sol")).toEqual([
      "--model",
      "openai-codex/gpt-5.6-sol",
    ]);
  });

  test("effort emission is per harness", () => {
    expect(effortArguments("claude", "medium")).toEqual(["--effort", "medium"]);
    expect(effortArguments("codex", "high")).toEqual(["-c", 'model_reasoning_effort="high"']);
    expect(effortArguments("pi", "max")).toEqual(["--thinking", "max"]);
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
    expect(modelDimensionToken("pi", ["hello"])).toBeNull();
  });

  test("effort-dimension detection is per harness, codex via -c pairs", () => {
    expect(effortDimensionToken("claude", ["--effort", "max"])).toBe("--effort");
    expect(effortDimensionToken("claude", ["--effort=max"])).toBe("--effort=max");
    expect(effortDimensionToken("pi", ["--thinking", "high"])).toBe("--thinking");
    expect(effortDimensionToken("codex", ["-c", 'model_reasoning_effort="low"'])).toBe(
      '-c model_reasoning_effort="low"',
    );
    expect(effortDimensionToken("codex", ["--config", "model_reasoning_effort=low"])).toBe(
      "--config model_reasoning_effort=low",
    );
    expect(effortDimensionToken("codex", ["-c", "other=1"])).toBeNull();
    expect(effortDimensionToken("codex", ["--effort", "max"])).toBeNull();
    expect(effortDimensionToken("claude", ["--thinking", "high"])).toBeNull();
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

describe("run-name spellings", () => {
  test("claude and pi take --name; codex has none at launch", () => {
    expect(nameArguments("claude", "auth flow")).toEqual(["--name", "auth flow"]);
    expect(nameArguments("pi", "auth flow")).toEqual(["--name", "auth flow"]);
    expect(nameArguments("codex", "auth flow")).toBeNull();
  });

  test("name-dimension detection sees --name, --name=, and the -n alias", () => {
    expect(nameDimensionToken("claude", ["-p", "hi", "--name", "x"])).toBe("--name");
    expect(nameDimensionToken("pi", ["--name=x"])).toBe("--name=x");
    expect(nameDimensionToken("claude", ["-n", "x"])).toBe("-n");
    // Codex has no launch-time name, so nothing there can conflict.
    expect(nameDimensionToken("codex", ["--name", "x"])).toBeNull();
    expect(nameDimensionToken("pi", ["hello"])).toBeNull();
  });
});

describe("sessionStore", () => {
  const home = "/home/user";

  test("defaults live under the home directory", () => {
    expect(sessionStore("claude", {}, home).root).toBe("/home/user/.claude/projects");
    expect(sessionStore("codex", {}, home).root).toBe("/home/user/.codex");
    expect(sessionStore("pi", {}, home).root).toBe("/home/user/.pi/agent/sessions");
  });

  test("env overrides relocate the store and are reported active", () => {
    const claude = sessionStore("claude", { CLAUDE_CONFIG_DIR: "/profiles/a" }, home);
    expect(claude.root).toBe("/profiles/a/projects");
    expect(claude.overrideActive).toBe(true);

    const codex = sessionStore("codex", { CODEX_HOME: "~/codex-home" }, home);
    expect(codex.root).toBe("/home/user/codex-home");
    expect(codex.overrideActive).toBe(true);

    const pi = sessionStore("pi", { PI_CODING_AGENT_DIR: "/pi/agent" }, home);
    expect(pi.root).toBe("/pi/agent/sessions");
    expect(pi.overrideActive).toBe(true);
  });

  test("empty overrides do not count as active", () => {
    const store = sessionStore("codex", { CODEX_HOME: "" }, home);
    expect(store.root).toBe("/home/user/.codex");
    expect(store.overrideActive).toBe(false);
  });
});

describe("ensureWorkspaceTrusted", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    homes.length = 0;
  });

  interface TrustWorld {
    codexHome: string;
    config: string;
    workspace: string;
  }

  function makeTrustWorld(): TrustWorld {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentsurface-trust-")));
    homes.push(root);
    const workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    const codexHome = join(root, "codex");
    return { codexHome, config: join(codexHome, "config.toml"), workspace };
  }

  function trust(world: TrustWorld, workspace = world.workspace): TrustOutcome {
    return ensureWorkspaceTrusted(
      "codex",
      { CODEX_HOME: world.codexHome },
      "/home/user",
      workspace,
    );
  }

  test("only codex is asked, because only codex asks", () => {
    const world = makeTrustWorld();
    expect(ensureWorkspaceTrusted("claude", { CODEX_HOME: world.codexHome }, "/h", "/ws")).toBe(
      "not applicable",
    );
    expect(existsSync(world.config)).toBe(false);
  });

  test("the answer is written once, and read back as already given", () => {
    const world = makeTrustWorld();
    expect(trust(world)).toBe("trusted");
    const written = readFileSync(world.config, "utf8");
    expect(written).toContain(`[projects.${JSON.stringify(world.workspace)}]`);
    expect(written).toContain('trust_level = "trusted"');
    expect(trust(world)).toBe("already");
    expect(readFileSync(world.config, "utf8")).toBe(written);
  });

  test("an operator's own answer is matched however it is spelled, and never rewritten", () => {
    const world = makeTrustWorld();
    mkdirSync(world.codexHome, { recursive: true });
    // Literal-string key, spaces around the dot, and an answer that refuses:
    // a judgement is a judgement whatever it says (ADR 0021).
    const operator = `model = "gpt-5.6"\n\n[ projects . '${world.workspace}' ]\ntrust_level = "untrusted"\n`;
    writeFileSync(world.config, operator);
    expect(trust(world)).toBe("already");
    expect(readFileSync(world.config, "utf8")).toBe(operator);
  });

  test("an answer under a [projects] table counts, whichever key spelling it uses", () => {
    const world = makeTrustWorld();
    mkdirSync(world.codexHome, { recursive: true });
    const operator = `[projects]\n"${world.workspace}" = { trust_level = "trusted" }\n`;
    writeFileSync(world.config, operator);
    expect(trust(world)).toBe("already");
    expect(readFileSync(world.config, "utf8")).toBe(operator);
  });

  test("everything the operator wrote survives the write byte for byte", () => {
    const world = makeTrustWorld();
    mkdirSync(world.codexHome, { recursive: true });
    const operator = [
      "# codex settings this repository knows nothing about",
      'model = "gpt-5.6"',
      "",
      "[mcp_servers.docs]",
      'command = "docs-server"',
      "",
      `[projects."${join(world.workspace, "elsewhere")}"]`,
      'trust_level = "trusted"',
      "",
    ].join("\n");
    writeFileSync(world.config, operator);
    expect(trust(world)).toBe("trusted");
    const written = readFileSync(world.config, "utf8");
    expect(written.startsWith(operator)).toBe(true);
    expect(written.slice(operator.length)).toBe(
      `\n[projects.${JSON.stringify(world.workspace)}]\ntrust_level = "trusted"\n`,
    );
  });

  test("an inline projects table is refused rather than corrupted", () => {
    const world = makeTrustWorld();
    mkdirSync(world.codexHome, { recursive: true });
    const operator = `projects = { "/elsewhere" = { trust_level = "trusted" } }\n`;
    writeFileSync(world.config, operator);
    expect(() => trust(world)).toThrow(/inline table/);
    expect(readFileSync(world.config, "utf8")).toBe(operator);
  });

  test("concurrent processes answering for the same workspaces write one table each", async () => {
    const world = makeTrustWorld();
    const workspaces = Array.from({ length: 60 }, (_, index) => {
      const path = join(world.workspace, `w${index}`);
      mkdirSync(path, { recursive: true });
      return path;
    });
    // Other agentsurface *processes* are what the lock has to exclude, so the
    // race is run as processes: an in-process mutex would pass this trivially.
    const script = join(dirname(world.codexHome), "answer.ts");
    // Every child answers for the same directory at the same instant: without
    // a shared start they simply take turns, and take turns is what the bug
    // looks like when it is not reproduced.
    const startAt = Date.now() + 2_000;
    writeFileSync(
      script,
      [
        `import { ensureWorkspaceTrusted } from ${JSON.stringify(join(import.meta.dir, "..", "src", "harness.ts"))};`,
        `while (Date.now() < ${startAt}) Bun.sleepSync(1);`,
        `for (const workspace of ${JSON.stringify(workspaces)}) {`,
        `  ensureWorkspaceTrusted("codex", { CODEX_HOME: ${JSON.stringify(world.codexHome)} }, "/home/user", workspace);`,
        "}",
        "",
      ].join("\n"),
    );
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn({ cmd: ["bun", script], stdout: "pipe", stderr: "pipe" }),
    );
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    const written = readFileSync(world.config, "utf8");
    for (const workspace of workspaces) {
      const header = `[projects.${JSON.stringify(workspace)}]`;
      expect(written.split(header).length - 1).toBe(1);
    }
    expect(written.split("\n").filter((line) => line.startsWith("[projects.")).length).toBe(
      workspaces.length,
    );
  }, 30_000);
});
