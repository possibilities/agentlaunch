import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, catalogCommand } from "../src/commands.ts";
import { UsageError } from "../src/errors.ts";
import { createNarrator } from "../src/narrate.ts";
import { partition, type XSpec } from "../src/partition.ts";
import type { Environ } from "../src/paths.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function contextFor(env: Environ, home: string): Context {
  return { env, home, cwd: home, narrator: createNarrator({ silent: true, verbose: false }) };
}

function emptyHome(): { env: Environ; home: string } {
  const root = mkdtempSync(join(tmpdir(), "agentlaunch-catalog-command-"));
  roots.push(root);
  return { env: {}, home: join(root, "home") };
}

const SPEC: XSpec = {
  value: new Set<string>(),
  bool: new Set(["--x-json", "--x-help"]),
  repeatable: new Set<string>(),
  scoped: new Map(),
};

interface CatalogData {
  source: string;
  path: string;
  harnesses: Array<{
    harness: string;
    default_model: string;
    default_effort: string;
    metadata_level: string | null;
    models: Array<{
      model: string;
      efforts: readonly string[];
      default_effort: string | null;
      family: string | null;
    }>;
  }>;
}

describe("catalogCommand", () => {
  test("reports the resolved built-in catalog", async () => {
    const { env, home } = emptyHome();
    const outcome = await catalogCommand(contextFor(env, home), partition([], SPEC));
    if (outcome.kind !== "result") throw new Error("expected a result outcome");
    const data = outcome.data as CatalogData;

    expect(data.source).toBe("built-in");
    expect(data.harnesses.map((entry) => entry.harness)).toEqual(["claude", "codex"]);

    const claude = data.harnesses[0]!;
    expect(claude.default_model).toBe("opus-1m");
    expect(claude.default_effort).toBe("medium");
    expect(claude.metadata_level).toBe("haiku:low");
    expect(data.harnesses[1]?.metadata_level).toBe("gpt-5.4-mini:low");
    const fable = claude.models.find((model) => model.model === "fable");
    expect(fable).toBeDefined();
    expect(fable?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(fable?.family).toBe("claude");

    // A per-model effort narrowing survives resolution: luna has no ultra.
    const codex = data.harnesses[1]!;
    const luna = codex.models.find((model) => model.model === "gpt-5.6-luna");
    expect(luna?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const sol = codex.models.find((model) => model.model === "gpt-5.6-sol");
    expect(sol?.efforts).toContain("ultra");
  });

  test("human output names the source and lists every model", async () => {
    const { env, home } = emptyHome();
    const outcome = await catalogCommand(contextFor(env, home), partition([], SPEC));
    if (outcome.kind !== "result") throw new Error("expected a result outcome");
    expect(outcome.human).toContain("catalog  built-in");
    expect(outcome.human).toContain("claude  default opus-1m:medium · metadata haiku:low");
    expect(outcome.human).toContain("gpt-5.3-codex-spark");
  });

  test("a custom catalog replaces the built-in", async () => {
    const { env, home } = emptyHome();
    const directory = join(home, ".config", "agentlaunch");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "catalog.json"),
      JSON.stringify({
        harnesses: [
          {
            harness: "claude",
            efforts: ["low", "high"],
            models: [{ model: "solo" }],
            defaults: { model: "solo", effort: "high" },
          },
        ],
      }),
    );
    const outcome = await catalogCommand(contextFor(env, home), partition([], SPEC));
    if (outcome.kind !== "result") throw new Error("expected a result outcome");
    const data = outcome.data as CatalogData;
    expect(data.source).toBe("custom");
    expect(data.harnesses).toHaveLength(1);
    expect(data.harnesses[0]?.models[0]).toEqual({
      model: "solo",
      efforts: ["low", "high"],
      default_effort: null,
      family: null,
    });
  });

  test("arguments are a usage fault", async () => {
    const { env, home } = emptyHome();
    let caught: unknown;
    try {
      await catalogCommand(contextFor(env, home), partition(["extra"], SPEC));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
  });
});
