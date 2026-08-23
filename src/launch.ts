import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type CapabilitySet, writeCapabilityReceipt } from "./capabilities.ts";
import { type CodexAppServerClient, connectCodexAppServer } from "./codex-app-server.ts";
import { CliError } from "./errors.ts";
import { type HarnessName, type LaunchSpec, sessionFileFacts, sessionStore } from "./harness.ts";
import type { Narrator } from "./narrate.ts";
import type { Environ } from "./paths.ts";
import { whichInEnv } from "./subprocess.ts";

const SIGNAL_EXIT: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
};

const DISABLE_COMPATIBILITY_PLUGIN = 'plugins."agent@agentstart-managed".enabled=false';
const REMOTE_CLIENT_PROVIDER = [
  "-c",
  'model_provider="agentlaunch-remote"',
  "-c",
  'model_providers.agentlaunch-remote.name="AgentLaunch remote"',
  "-c",
  'model_providers.agentlaunch-remote.base_url="http://127.0.0.1"',
  "-c",
  'model_providers.agentlaunch-remote.wire_api="responses"',
  "-c",
  "model_providers.agentlaunch-remote.requires_openai_auth=false",
] as const;

export async function launch(
  spec: LaunchSpec,
  narrator: Narrator,
  env: Environ = process.env,
  cwd: string | null = null,
  home = env["HOME"] ?? "",
  capabilities: CapabilitySet | null = null,
): Promise<number> {
  if (spec.harness === "codex" && capabilities !== null) {
    return launchCodex(spec, capabilities, narrator, env, cwd, home);
  }

  const before =
    capabilities?.receiptRequired === true && spec.sessionId === null
      ? await nativeSessionIds(spec.harness, env, home)
      : null;
  const child = spawnInteractive(spec.command, narrator, env, cwd);
  const code = await adoptInteractive(child);
  if (capabilities?.receiptRequired === true) {
    const sessionId =
      spec.sessionId ??
      (before === null ? null : await discoverNativeSession(spec.harness, env, home, before));
    if (sessionId === null) {
      narrator.detail(
        "capabilities",
        "could not identify the new native session; no receipt written",
      );
    } else {
      writeCapabilityReceipt(env, home, spec.harness, sessionId, capabilities);
      narrator.detail("capabilities", `receipt ${spec.harness}:${sessionId}`);
    }
  }
  return code;
}

async function launchCodex(
  spec: LaunchSpec,
  capabilities: CapabilitySet,
  narrator: Narrator,
  env: Environ,
  cwd: string | null,
  home: string,
): Promise<number> {
  const temp = mkdtempSync("/tmp/agentlaunch-codex-");
  chmodSync(temp, 0o700);
  const socketPath = join(temp, "app-server.sock");
  const endpoint = `unix://${socketPath}`;
  const serverCommand = codexAppServerCommand(spec, endpoint, capabilities.skills);
  const serverEnv = codexAppServerEnvironment(env);
  const [serverBin, ...serverArgs] = resolveCommand(serverCommand, serverEnv);
  narrator.detail("app server", serverCommand.join(" "));
  const server = Bun.spawn([serverBin, ...serverArgs], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    ...(cwd === null ? {} : { cwd }),
    env: { ...serverEnv, AGENTLAUNCH_LAUNCH: "1" } as Record<string, string>,
  });
  const serverStdout = new Response(server.stdout).text();
  const serverStderr = new Response(server.stderr).text();
  let client: CodexAppServerClient | null = null;
  try {
    client = await connectCodexAppServer(socketPath, server.exited);
    await client.setSkillRoots(capabilities.skillRoots);
    narrator.detail(
      "skills",
      capabilities.skillRoots.length === 0 ? "no extra roots" : capabilities.skillRoots.join(", "),
    );
    const before =
      capabilities.receiptRequired && spec.sessionId === null
        ? new Set(await client.loadedThreads())
        : null;
    // Skill roots are process state, so finish setup and detach before the
    // native remote TUI takes ownership of the interactive phase. Receipt
    // discovery reconnects only after the TUI exits; control and interactive
    // lifetimes stay deliberately non-overlapping.
    client.close();
    client = null;
    const remoteCommand = codexRemoteCommand(spec, endpoint, capabilities.guidance, env);
    const child = spawnInteractive(remoteCommand, narrator, env, cwd);
    const code = await adoptInteractive(child);
    let sessionId = spec.sessionId;
    if (before !== null) {
      client = await connectCodexAppServer(socketPath, server.exited);
      sessionId = await discoverCodexThread(client, before);
    }
    if (capabilities.receiptRequired) {
      if (sessionId === null) {
        narrator.detail(
          "capabilities",
          "could not identify the new Codex thread; no receipt written",
        );
      } else {
        writeCapabilityReceipt(env, home, "codex", sessionId, capabilities);
        narrator.detail("capabilities", `receipt codex:${sessionId}`);
      }
    }
    return code;
  } catch (error) {
    if (server.exitCode !== null) {
      const detail =
        (await serverStderr).trim().slice(-4000) || (await serverStdout).trim().slice(-4000);
      throw new CliError(
        "codex_app_server_exit",
        `Codex App Server exited ${server.exitCode}${detail === "" ? "" : `: ${detail}`}`,
      );
    }
    throw error;
  } finally {
    client?.close();
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      try {
        server.kill("SIGTERM");
      } catch {
        // It already exited.
      }
    }
    await server.exited;
    await Promise.all([serverStdout, serverStderr]);
    rmSync(temp, { recursive: true, force: true });
  }
}

export function codexAppServerCommand(
  spec: LaunchSpec,
  endpoint: string,
  skills: CapabilitySet["skills"],
): string[] {
  const skillPolicy =
    skills.length === 0
      ? []
      : [
          "-c",
          `skills.config=${JSON.stringify(
            skills.map((skill) => ({ path: join(skill.path, "SKILL.md"), enabled: true })),
          )}`,
        ];
  const serverArgs = [
    "-c",
    DISABLE_COMPATIBILITY_PLUGIN,
    ...skillPolicy,
    "app-server",
    "--listen",
    endpoint,
  ];
  const command = spec.command;
  if (command[0] === "codex") return ["codex", ...serverArgs];
  if (command[0] !== "codex-swap") {
    throw new CliError(
      "codex_launch_shape",
      `cannot supervise unexpected Codex command: ${command.join(" ")}`,
    );
  }
  const separator = command.indexOf("--");
  if (separator < 0) {
    throw new CliError("codex_launch_shape", "codex-swap command has no -- separator");
  }
  if (command[1] === "run") return [...command.slice(0, separator + 1), ...serverArgs];
  if (command[1] === "resume") {
    return ["codex-swap", "run", ...command.slice(3, separator + 1), ...serverArgs];
  }
  throw new CliError("codex_launch_shape", `unsupported codex-swap command: ${command[1] ?? ""}`);
}

/** Retired sidecar integrations exported these values into long-lived shells.
 * A pinned codex-swap invocation requires ndy's runtime proxy and must never
 * inherit either kill switch, even before the shell itself is restarted. */
export function codexAppServerEnvironment(env: Environ): Environ {
  const sanitized = { ...env };
  delete sanitized["CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY"];
  delete sanitized["CODEX_MULTI_AUTH_BYPASS"];
  return sanitized;
}

export function codexRemoteCommand(
  spec: LaunchSpec,
  endpoint: string,
  guidance: string,
  env: Environ,
): string[] {
  const codex = whichInEnv("codex", env);
  if (codex === null) throw missingBinary("codex");
  let native: string[];
  if (spec.command[0] === "codex") {
    native = spec.command.slice(1);
  } else {
    const separator = spec.command.indexOf("--");
    if (separator < 0) {
      throw new CliError("codex_launch_shape", "codex-swap command has no -- separator");
    }
    native =
      spec.sessionId === null
        ? spec.command.slice(separator + 1)
        : ["resume", spec.sessionId, ...spec.command.slice(separator + 1)];
  }
  const config =
    guidance === "" ? [] : ["-c", `developer_instructions=${JSON.stringify(guidance)}`];
  // The account-bound server intentionally exposes no local account object:
  // codex-multi-auth authenticates its upstream requests through the runtime
  // proxy instead. A remote TUI still evaluates its local provider before it
  // connects, so give only that client a no-auth placeholder. Remote thread
  // params omit model_provider; the server retains its pinned runtime proxy.
  return [codex, "--remote", endpoint, ...REMOTE_CLIENT_PROVIDER, ...config, ...native];
}

function spawnInteractive(command: string[], narrator: Narrator, env: Environ, cwd: string | null) {
  const [resolved, ...rest] = resolveCommand(command, env);
  narrator.detail("bin", resolved);
  narrator.detail("env", "AGENTLAUNCH_LAUNCH=1 · PATH shims exec the real binary");
  return Bun.spawn([resolved, ...rest], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    ...(cwd === null ? {} : { cwd }),
    env: { ...env, AGENTLAUNCH_LAUNCH: "1" } as Record<string, string>,
  });
}

function resolveCommand(command: string[], env: Environ): [string, ...string[]] {
  const [bin, ...rest] = command;
  if (bin === undefined) throw new CliError("empty_command", "launch spec has no command");
  const resolved = whichInEnv(bin, env);
  if (resolved === null) throw missingBinary(bin);
  return [resolved, ...rest];
}

function missingBinary(bin: string): CliError {
  return new CliError(
    "harness_not_installed",
    `${bin} is not on PATH`,
    `install ${bin} or run agentlaunch from a shell where it resolves`,
  );
}

async function adoptInteractive(child: ReturnType<typeof spawnInteractive>): Promise<number> {
  const onInterrupt = (): void => {};
  const forward = (signal: "SIGTERM" | "SIGHUP") => (): void => {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  };
  const onTerminate = forward("SIGTERM");
  const onHangup = forward("SIGHUP");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("SIGHUP", onHangup);
  try {
    const code = await child.exited;
    if (child.signalCode !== null) return SIGNAL_EXIT[child.signalCode] ?? 1;
    return code;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("SIGHUP", onHangup);
  }
}

async function discoverCodexThread(
  client: CodexAppServerClient,
  before: Set<string>,
  timeoutMs = 2_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const added = (await client.loadedThreads()).filter((id) => !before.has(id));
    if (added.length === 1) return added[0] as string;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  return null;
}

async function nativeSessionIds(
  harness: HarnessName,
  env: Environ,
  home: string,
): Promise<Set<string>> {
  const root = sessionStore(harness, env, home).root;
  const ids = new Set<string>();
  const glob = new Bun.Glob("**/*.jsonl");
  try {
    for await (const relative of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
      const facts = await sessionFileFacts(harness, join(root, relative));
      if (facts.sessionId !== null) ids.add(facts.sessionId);
    }
  } catch {
    return ids;
  }
  return ids;
}

async function discoverNativeSession(
  harness: HarnessName,
  env: Environ,
  home: string,
  before: Set<string>,
): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const after = await nativeSessionIds(harness, env, home);
    const added = [...after].filter((id) => !before.has(id));
    if (added.length === 1) return added[0] as string;
    if (added.length > 1) return null;
    await Bun.sleep(50);
  }
  return null;
}
