import { CliError } from "./errors.ts";
import { UnixWebSocket } from "./unix-websocket.ts";

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexAppServerClient {
  private socket: UnixWebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  static async connect(path: string): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient();
    client.socket = await UnixWebSocket.connect(path, {
      text: (value) => client.dispatch(value),
      close: (error) => client.closed(error),
    });
    await client.request("initialize", {
      clientInfo: { name: "agentlaunch", title: "AgentLaunch", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    client.notify("initialized", {});
    return client;
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async setSkillRoots(roots: string[]): Promise<void> {
    await this.request("skills/extraRoots/set", { extraRoots: roots });
  }

  async loadedThreads(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const response: { data: unknown; nextCursor?: unknown } = await this.request(
        "thread/loaded/list",
        { cursor, limit: 1000 },
      );
      if (
        !Array.isArray(response.data) ||
        !response.data.every((id: unknown) => typeof id === "string")
      ) {
        throw new Error("thread/loaded/list returned malformed data");
      }
      ids.push(...(response.data as string[]));
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
    } while (cursor !== null);
    return ids;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  private send(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (socket === null) throw new Error("not connected to Codex App Server");
    socket.sendText(JSON.stringify(message));
  }

  private dispatch(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as Record<string, unknown>;
    const id = message["id"];
    const method = message["method"];
    if (typeof id === "number" && method === undefined) {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const fault = message["error"];
      if (typeof fault === "object" && fault !== null) {
        const record = fault as Record<string, unknown>;
        pending.reject(new Error(`${pending.method}: ${String(record["message"] ?? "failed")}`));
      } else {
        pending.resolve(message["result"]);
      }
      return;
    }
    if ((typeof id === "number" || typeof id === "string") && typeof method === "string") {
      // No approval-bearing request is expected on this control connection;
      // answer immediately so an unexpected one can never park the server.
      this.send({ jsonrpc: "2.0", id, result: {} });
    }
  }

  private closed(error?: string): void {
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`${pending.method}: App Server connection closed${error ? `: ${error}` : ""}`),
      );
    }
    this.pending.clear();
  }
}

export async function connectCodexAppServer(
  socketPath: string,
  serverExited: Promise<number>,
  timeoutMs = 10_000,
): Promise<CodexAppServerClient> {
  const deadline = Date.now() + timeoutMs;
  let last = "socket not ready";
  while (Date.now() < deadline) {
    const attempt = await Promise.race([
      CodexAppServerClient.connect(socketPath).then(
        (client) => ({ kind: "client" as const, client }),
        (error: unknown) => ({ kind: "retry" as const, error }),
      ),
      serverExited.then((code) => ({ kind: "exit" as const, code })),
    ]);
    if (attempt.kind === "client") return attempt.client;
    if (attempt.kind === "exit") {
      throw new CliError(
        "codex_app_server_exit",
        `Codex App Server exited ${attempt.code} before startup`,
      );
    }
    last = attempt.error instanceof Error ? attempt.error.message : String(attempt.error);
    await Bun.sleep(50);
  }
  throw new CliError(
    "codex_app_server_timeout",
    `Codex App Server did not accept connections at ${socketPath}: ${last}`,
  );
}
