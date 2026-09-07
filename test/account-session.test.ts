import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AccountSession, maintainLease, releaseLease } from "../src/account-session.ts";
import { launch } from "../src/launch.ts";
import { createNarrator } from "../src/narrate.ts";
import { spawnBounded } from "../src/subprocess.ts";

const roots: string[] = [];
const servers: Array<{ stop(force: boolean): unknown }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "agentlaunch-lease-"));
  roots.push(root);
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      calls.push(req.method);
      expect(req.headers.get("authorization")).toBe("Bearer private-test-token");
      return Response.json({ schema_version: 1, ok: true, account_key: "codex-2" });
    },
  });
  servers.push(server);
  const session: AccountSession = {
    lease: {
      id: "fixture",
      token: "private-test-token",
      url: `${server.url.origin}/lease`,
      expires_at_ms: Date.now() + 90_000,
    },
    env: { AGENTUSAGE_AUTH_TOKEN: "private-test-token" },
    unsetEnv: ["OPENAI_API_KEY"],
    accountKey: "codex-1",
  };
  return { root, calls, session };
}
const narrator = () => createNarrator({ silent: true, verbose: false });
test("lease released on executable resolution failure and failed spawn", async () => {
  const f = setup();
  await expect(
    launch(
      { harness: "codex", command: ["missing"], sessionId: null, accountSession: f.session },
      narrator(),
      { PATH: f.root },
    ),
  ).rejects.toThrow("not on PATH");
  await expect(
    launch(
      { harness: "codex", command: ["/bin/sh"], sessionId: null, accountSession: f.session },
      narrator(),
      {},
      join(f.root, "missing-cwd"),
    ),
  ).rejects.toThrow();
  expect(f.calls).toEqual(["DELETE", "DELETE"]);
});
test("native exit status and homes survive private env injection and cleanup", async () => {
  const f = setup();
  const record = join(f.root, "record");
  const file = join(f.root, "codex");
  writeFileSync(
    file,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal shell parameter expansion.
    '#!/bin/sh\nprintf "%s|%s|%s|%s" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$AGENTUSAGE_AUTH_TOKEN" "${OPENAI_API_KEY-unset}" > "$RECORD"\nexit 7\n',
    { mode: 0o700 },
  );
  const code = await launch(
    { harness: "codex", command: [file], sessionId: null, accountSession: f.session },
    narrator(),
    {
      RECORD: record,
      CODEX_HOME: "/native/codex",
      CLAUDE_CONFIG_DIR: "/native/claude",
      OPENAI_API_KEY: "ambient",
    },
  );
  expect(code).toBe(7);
  expect(readFileSync(record, "utf8")).toBe(
    "/native/codex|/native/claude|private-test-token|unset",
  );
  expect(f.calls).toEqual(["DELETE"]);
});
test("parent renews, observes reassignment, stops heartbeat before release", async () => {
  const f = setup();
  const identities: string[] = [];
  const stop = maintainLease(
    f.session,
    () => {
      throw new Error("unexpected expiry");
    },
    (key) => identities.push(key),
    5,
  );
  await Bun.sleep(25);
  await stop();
  await releaseLease(f.session.lease);
  expect(identities).toEqual(["codex-2"]);
  expect(f.calls.at(-1)).toBe("DELETE");
  const count = f.calls.length;
  await Bun.sleep(15);
  expect(f.calls.length).toBe(count);
});
test("sleep past TTL fails closed without reviving a lease", async () => {
  const f = setup();
  f.session.lease.expires_at_ms = Date.now() - 1;
  let lost = 0;
  const stop = maintainLease(
    f.session,
    () => {
      lost++;
    },
    () => {},
    5,
  );
  await Bun.sleep(15);
  await stop();
  expect(lost).toBe(1);
  expect(f.calls).toEqual([]);
});
test("prepare subprocess output and lifetime are bounded and children reaped", async () => {
  await expect(
    spawnBounded({
      cmd: ["/bin/sh", "-c", "while :; do printf 1234567890; done"],
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 100,
      label: "fixture",
    }),
  ).rejects.toThrow("output limit");
  await expect(
    spawnBounded({
      cmd: ["/bin/sh", "-c", "while :; do :; done"],
      env: {},
      timeoutMs: 20,
      label: "fixture",
    }),
  ).rejects.toThrow("did not finish");
});
