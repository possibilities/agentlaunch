#!/usr/bin/env bun

import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const root = process.argv[2];
if (root === undefined || !root.startsWith("/") || root === "/") {
  throw new Error(`Refusing unsafe retired capability receipt root: ${root ?? "<missing>"}`);
}

const uid = process.getuid?.();
const harnesses = new Set(["claude", "codex", "pi"]);
const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const capabilityId = /^[a-z][a-z0-9-]*$/;
const digest = /^[0-9a-f]{24}$/;

function refuse(message: string): never {
  throw new Error(`Refusing unrecognized retired capability receipts: ${message}`);
}

function safeStat(path: string, kind: "directory" | "receipt") {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) refuse(`symlink at ${path}`);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    refuse(`unexpected ${kind === "directory" ? "non-directory" : "non-file"} at ${path}`);
  }
  if (uid !== undefined && stat.uid !== uid) refuse(`foreign owner at ${path}`);
  if ((stat.mode & 0o022) !== 0) refuse(`unsafe writable permissions at ${path}`);
  if (kind === "receipt" && (stat.mode & 0o777) !== 0o600) {
    refuse(`receipt permissions are not 0600 at ${path}`);
  }
  if (kind === "receipt" && stat.nlink !== 1) refuse(`hardlinked receipt at ${path}`);
}

safeStat(root, "directory");
for (const harness of readdirSync(root)) {
  if (!harnesses.has(harness)) refuse(`unknown harness directory ${harness}`);
  const harnessRoot = join(root, harness);
  safeStat(harnessRoot, "directory");
  for (const name of readdirSync(harnessRoot)) {
    const path = join(harnessRoot, name);
    safeStat(path, "receipt");
    const id = basename(name, ".json");
    if (`${id}.json` !== name || !sessionId.test(id)) refuse(`invalid receipt name ${path}`);

    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      refuse(`invalid JSON in ${path}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      refuse(`non-object receipt ${path}`);
    }
    const receipt = value as Record<string, unknown>;
    const keys = Object.keys(receipt).sort().join(",");
    if (keys !== "capabilities,digest,harness,schema_version,session_id") {
      refuse(`unexpected fields in ${path}`);
    }
    if (
      receipt["schema_version"] !== 1 ||
      receipt["harness"] !== harness ||
      receipt["session_id"] !== id ||
      typeof receipt["digest"] !== "string" ||
      !digest.test(receipt["digest"]) ||
      !Array.isArray(receipt["capabilities"]) ||
      !receipt["capabilities"].every(
        (entry) => typeof entry === "string" && capabilityId.test(entry),
      ) ||
      new Set(receipt["capabilities"]).size !== receipt["capabilities"].length
    ) {
      refuse(`malformed receipt ${path}`);
    }
  }
}

rmSync(root, { recursive: true });
console.log(`Removed retired AgentLaunch capability receipts: ${root}`);
