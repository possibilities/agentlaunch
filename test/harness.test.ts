import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/errors.ts";
import {
  applyYolo,
  buildOpen,
  buildResume,
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
      "--dangerously-skip-permissions",
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
