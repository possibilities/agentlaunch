import { CliError } from "./errors.ts";

export interface AccountLease {
  id: string;
  token: string;
  url: string;
  expires_at_ms: number;
}
export interface AccountSession {
  env: Record<string, string>;
  unsetEnv: string[];
  lease: AccountLease;
  accountKey: string;
}

export function loopbackLeaseURL(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/lease" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function leaseRequest(lease: AccountLease, method: "POST" | "DELETE", signal?: AbortSignal) {
  if (!loopbackLeaseURL(lease.url)) throw new Error("Invalid lease endpoint");
  const response = await fetch(lease.url, {
    method,
    redirect: "error",
    headers: { authorization: `Bearer ${lease.token}` },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
      : AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CliError("lease_rejected", "Account session lease was rejected");
  }
  const reader = response.body?.getReader();
  let text = "",
    size = 0;
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          throw new Error("Lease response too large");
        }
        text += new TextDecoder().decode(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = JSON.parse(text) as Record<string, unknown>;
  if (
    body["schema_version"] !== 1 ||
    body["ok"] !== true ||
    typeof body["account_key"] !== "string" ||
    !/^(claude|codex)-[1-9]\d*$/u.test(body["account_key"])
  )
    throw new Error("Invalid lease response");
  return body["account_key"];
}

export async function releaseLease(lease: AccountLease): Promise<void> {
  try {
    await leaseRequest(lease, "DELETE");
  } catch {
    /* Expired or already released cleanup never changes native exit status. */
  }
}

/** Runs in the existing parent. A suspended parent cannot revive an expired lease. */
export function maintainLease(
  session: AccountSession,
  onLost: () => void,
  onAccount: (key: string) => void,
  intervalMs = 25_000,
) {
  const stop = new AbortController();
  let expires = session.lease.expires_at_ms,
    account = session.accountKey;
  const sleep = () =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        stop.signal.removeEventListener("abort", wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.min(intervalMs, Math.max(1, expires - Date.now())));
      stop.signal.addEventListener("abort", wake, { once: true });
    });
  const running = (async () => {
    while (!stop.signal.aborted) {
      await sleep();
      if (stop.signal.aborted) return;
      if (Date.now() >= expires) {
        onLost();
        return;
      }
      try {
        const key = await leaseRequest(session.lease, "POST", stop.signal);
        expires = Date.now() + 85_000; // Conservative bound below the daemon's 90 second TTL.
        if (key !== account) {
          account = key;
          onAccount(key);
        }
      } catch (error) {
        if (stop.signal.aborted) return;
        if (error instanceof CliError || Date.now() >= expires) {
          onLost();
          return;
        }
      }
    }
  })();
  return async () => {
    stop.abort();
    await running;
  };
}
