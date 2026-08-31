import { existsSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { UsageError } from "./errors.ts";
import type { HarnessName, SessionStore } from "./harness.ts";
import { HARNESS_NAMES, sessionStore } from "./harness.ts";
import type { Environ } from "./paths.ts";

/** Broad enough for Claude/Codex UUIDs and Codex session names; narrow enough
 * that every character is glob-literal, so an id can be spliced into a
 * pattern without escaping. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) {
    throw new UsageError(
      `session id "${sessionId}" must be alphanumeric plus dot, dash, or underscore`,
    );
  }
}

export interface SessionMatch {
  harness: HarnessName;
  path: string;
}

export async function findSessions(
  sessionId: string,
  env: Environ,
  home: string,
): Promise<SessionMatch[]> {
  const matches: SessionMatch[] = [];
  for (const harness of HARNESS_NAMES) {
    const store = sessionStore(harness, env, home);
    const path = await firstMatch(store, sessionId);
    if (path !== null) matches.push({ harness, path });
  }
  return matches;
}

async function firstMatch(store: SessionStore, sessionId: string): Promise<string | null> {
  if (!existsSync(store.root)) return null;
  for (const pattern of store.patternsFor(sessionId)) {
    const glob = new Glob(pattern);
    for await (const relative of glob.scan({ cwd: store.root, onlyFiles: true })) {
      return join(store.root, relative);
    }
  }
  return null;
}

export async function countSessions(store: SessionStore): Promise<number> {
  if (!existsSync(store.root)) return 0;
  let count = 0;
  for (const pattern of store.patternsFor("*")) {
    const glob = new Glob(pattern);
    const entries: string[] = [];
    for await (const relative of glob.scan({ cwd: store.root, onlyFiles: true })) {
      entries.push(relative);
    }
    count += entries.length;
  }
  return count;
}
