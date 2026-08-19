import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Environ } from "../paths.ts";
import { stateDirectory } from "../paths.ts";

/**
 * The form's own bookkeeping, all of it losable: the interrupted draft, and
 * the submitted log — one JSON line per directive handed to the surface,
 * which orders the project list by use and replays the last cascade. What
 * the surface did with a directive is the surface's log, not this one.
 */

/** The interrupted form, shadowed on every repaint and cleared only on
 * submit: an escape, a crash, or a closed popup loses nothing, and the next
 * form opens exactly where this one stopped. A submitted launch starts
 * fresh through the normal default resolution instead. */
export interface FormDraft {
  prompt: string;
  project: string;
  worktree: boolean;
  harness: string;
  model: string;
  effort: string;
  priming: string;
}

export function formDraftPath(env: Environ, home: string): string {
  return join(stateDirectory(env, home, "agentlaunch"), "form-draft.json");
}

export function readFormDraft(path: string): FormDraft | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FormDraft>;
    if (
      typeof parsed.prompt !== "string" ||
      typeof parsed.project !== "string" ||
      typeof parsed.worktree !== "boolean" ||
      typeof parsed.harness !== "string" ||
      typeof parsed.model !== "string" ||
      typeof parsed.effort !== "string" ||
      typeof parsed.priming !== "string"
    ) {
      return null;
    }
    return {
      prompt: parsed.prompt,
      project: parsed.project,
      worktree: parsed.worktree,
      harness: parsed.harness,
      model: parsed.model,
      effort: parsed.effort,
      priming: parsed.priming,
    };
  } catch {
    return null;
  }
}

export function writeFormDraft(path: string, draft: FormDraft | null): void {
  try {
    if (draft === null) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(draft)}\n`);
  } catch {
    // Draft persistence is insurance, never a reason to block editing.
  }
}

/** One submitted launch, appended the moment its directive is written. */
export interface SubmittedRecord {
  at: string;
  project: string;
  harness: string;
  model: string;
  effort: string;
  worktree: boolean;
  priming: string | null;
  focus: boolean;
}

export function submittedLogPath(env: Environ, home: string): string {
  return join(stateDirectory(env, home, "agentlaunch"), "submitted.jsonl");
}

export function appendSubmitted(path: string, record: Omit<SubmittedRecord, "at">): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch {
    // Bookkeeping, never a launch blocker.
  }
}

export function readSubmittedCounts(path: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of readSubmitted(path)) {
    if (typeof record["project"] === "string") {
      counts.set(record["project"], (counts.get(record["project"]) ?? 0) + 1);
    }
  }
  return counts;
}

/** The last submission's cascade choices, for the next form's defaults.
 * Priming is not remembered; it defaults from configuration order. */
export interface LastLevel {
  harness: string;
  model: string;
  effort: string;
}

export function readLastSubmitted(path: string): LastLevel | null {
  let last: LastLevel | null = null;
  for (const record of readSubmitted(path)) {
    const { harness, model, effort } = record;
    if (typeof harness === "string" && typeof model === "string" && typeof effort === "string") {
      last = { harness, model, effort };
    }
  }
  return last;
}

function readSubmitted(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A garbled line loses one record, nothing more.
    }
  }
  return records;
}
