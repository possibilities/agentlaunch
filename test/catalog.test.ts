import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, parseHarnessValue, resolveRequest } from "../src/catalog.ts";
import { CliError, UsageError } from "../src/errors.ts";
import type { Environ } from "../src/paths.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function emptyHome(): { env: Environ; home: string } {
  const root = mkdtempSync(join(tmpdir(), "agentsurface-catalog-"));
  roots.push(root);
  return { env: {}, home: join(root, "home") };
}

function writeCatalog(content: string): { env: Environ; home: string } {
  const { env, home } = emptyHome();
  const directory = join(home, ".config", "agentsurface");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "catalog.json"), content);
  return { env, home };
}

/** A minimal valid custom catalog to mutate per test: family-level efforts
 * and defaults, one narrowed member. */
const CUSTOM = {
  families: {
    gpt: {
      efforts: ["low", "high", "max"],
      models: [{ model: "gpt-a" }, { model: "gpt-b", efforts: ["high"] }],
      defaults: { model: "gpt-a", effort: "high" },
    },
  },
  harnesses: [
    { harness: "codex", families: [{ family: "gpt" }] },
    { harness: "pi", families: [{ family: "gpt", provider: "prov" }] },
  ],
};

describe("parseHarnessValue", () => {
  test("a bare harness name pins that harness", () => {
    expect(parseHarnessValue("claude")).toEqual({ harness: "claude" });
    expect(parseHarnessValue("pi")).toEqual({ harness: "pi" });
  });

  test("one colon is model:effort, both parts required", () => {
    expect(parseHarnessValue("gpt-5.6-sol:high")).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(() => parseHarnessValue("gpt-5.6-sol:")).toThrow(/needs both parts/);
    expect(() => parseHarnessValue(":high")).toThrow(/needs both parts/);
  });

  test("two colons are harness:model:effort, all parts required", () => {
    expect(parseHarnessValue("pi:gpt-5.6-luna:max")).toEqual({
      harness: "pi",
      model: "gpt-5.6-luna",
      effort: "max",
    });
    expect(() => parseHarnessValue("claude:opus:")).toThrow(/needs all three parts/);
    expect(() => parseHarnessValue("::")).toThrow(/needs all three parts/);
    expect(() => parseHarnessValue("cursor:m:e")).toThrow(/"cursor" is not a harness/);
  });

  test("anything else is a pointed usage fault", () => {
    expect(() => parseHarnessValue("opus")).toThrow(/is not a harness value/);
    expect(() => parseHarnessValue("a:b:c:d")).toThrow(/is not a harness value/);
  });
});

describe("loadCatalog", () => {
  test("no custom file loads the built-in: family-shaped, in stated order", () => {
    const { env, home } = emptyHome();
    const catalog = loadCatalog(env, home);
    expect(catalog.source).toBe("built-in");
    expect(catalog.harnesses.map((entry) => entry.harness)).toEqual(["claude", "codex", "pi"]);
    const claude = catalog.harnesses[0]!;
    expect(claude.models.map((model) => model.model)).toEqual([
      "fable",
      "opus-1m",
      "opus",
      "sonnet-1m",
      "sonnet",
      "haiku",
    ]);
    expect(claude.model).toBe("opus-1m");
    expect(claude.effort).toBe("medium");
    expect(claude.models[0]?.family).toBe("claude");
  });

  test("family defaults supply both including harnesses; provider shapes pi's spellings", () => {
    const { env, home } = emptyHome();
    const catalog = loadCatalog(env, home);
    const codex = catalog.harnesses.find((entry) => entry.harness === "codex");
    const pi = catalog.harnesses.find((entry) => entry.harness === "pi");
    expect(codex?.model).toBe("gpt-5.6-sol");
    expect(codex?.effort).toBe("high");
    expect(pi?.model).toBe("gpt-5.6-sol");
    expect(pi?.models.find((model) => model.model === "gpt-5.6-sol")?.spelling).toBe(
      "openai-codex/gpt-5.6-sol",
    );
    expect(codex?.models.find((model) => model.model === "gpt-5.6-sol")?.spelling).toBe(
      "gpt-5.6-sol",
    );
  });

  test("a family member's spelling carries a name the typed grammar forbids", () => {
    const { env, home } = emptyHome();
    const catalog = loadCatalog(env, home);
    const claude = catalog.harnesses[0]!;
    expect(claude.models.find((model) => model.model === "opus-1m")?.spelling).toBe("opus[1m]");
    expect(claude.models.find((model) => model.model === "opus")?.spelling).toBe("opus");
  });

  test("efforts inherit member > family > harness", () => {
    const { env, home } = writeCatalog(JSON.stringify(CUSTOM));
    const catalog = loadCatalog(env, home);
    const codex = catalog.harnesses[0]!;
    expect(codex.models.find((model) => model.model === "gpt-a")?.efforts).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(codex.models.find((model) => model.model === "gpt-b")?.efforts).toEqual(["high"]);
  });

  test("a local model with no efforts anywhere is a fault; the harness set covers it", () => {
    const local = {
      harnesses: [
        {
          harness: "claude",
          efforts: ["low", "high"],
          models: [{ model: "fable" }],
          defaults: { model: "fable", effort: "high" },
        },
      ],
    };
    const { env, home } = writeCatalog(JSON.stringify(local));
    expect(loadCatalog(env, home).harnesses[0]?.models[0]?.efforts).toEqual(["low", "high"]);

    const bare = {
      harnesses: [
        {
          harness: "claude",
          models: [{ model: "fable" }],
          defaults: { model: "fable", effort: "high" },
        },
      ],
    };
    const { env: env2, home: home2 } = writeCatalog(JSON.stringify(bare));
    expect(() => loadCatalog(env2, home2)).toThrow(/has no efforts and the harness declares none/);
  });

  test("harness defaults win over family defaults", () => {
    const overridden = structuredClone(CUSTOM);
    overridden.harnesses[0] = {
      ...overridden.harnesses[0],
      defaults: { model: "gpt-b", effort: "high" },
    } as never;
    const { env, home } = writeCatalog(JSON.stringify(overridden));
    const codex = loadCatalog(env, home).harnesses[0]!;
    expect(codex.model).toBe("gpt-b");
    expect(codex.effort).toBe("high");
  });

  test("defaults must come from somewhere, and from one place", () => {
    const none = structuredClone(CUSTOM);
    none.families.gpt = { ...none.families.gpt, defaults: undefined } as never;
    const { env: env1, home: home1 } = writeCatalog(JSON.stringify(none));
    expect(() => loadCatalog(env1, home1)).toThrow(/has no defaults/);

    const two = {
      families: {
        a: {
          efforts: ["low"],
          models: [{ model: "m-a" }],
          defaults: { model: "m-a", effort: "low" },
        },
        b: {
          efforts: ["low"],
          models: [{ model: "m-b" }],
          defaults: { model: "m-b", effort: "low" },
        },
      },
      harnesses: [{ harness: "pi", families: [{ family: "a" }, { family: "b" }] }],
    };
    const { env: env2, home: home2 } = writeCatalog(JSON.stringify(two));
    expect(() => loadCatalog(env2, home2)).toThrow(/2 defaults-bearing families/);
  });

  test("default declarations are validated where they land", () => {
    const modelUnknown = structuredClone(CUSTOM);
    modelUnknown.families.gpt.defaults = { model: "ghost", effort: "high" } as never;
    const { env: env1, home: home1 } = writeCatalog(JSON.stringify(modelUnknown));
    expect(() => loadCatalog(env1, home1)).toThrow(/default model "ghost" is not among its models/);

    const effortOutside = structuredClone(CUSTOM);
    effortOutside.families.gpt.defaults = { model: "gpt-b", effort: "max" } as never;
    const { env: env2, home: home2 } = writeCatalog(JSON.stringify(effortOutside));
    expect(() => loadCatalog(env2, home2)).toThrow(
      /default effort "max" is not allowed by its default model "gpt-b"/,
    );

    const memberOutside = structuredClone(CUSTOM);
    memberOutside.families.gpt.models[1] = {
      model: "gpt-b",
      efforts: ["high"],
      defaults: { effort: "max" },
    } as never;
    const { env: env3, home: home3 } = writeCatalog(JSON.stringify(memberOutside));
    expect(() => loadCatalog(env3, home3)).toThrow(
      /model "gpt-b" default effort "max" is not in its efforts/,
    );
  });

  test("a model's own default effort wins for the name route", () => {
    const owned = structuredClone(CUSTOM);
    owned.families.gpt.models[0] = { model: "gpt-a", defaults: { effort: "max" } } as never;
    const { env, home } = writeCatalog(JSON.stringify(owned));
    const resolved = resolveRequest(loadCatalog(env, home), { harness: "codex" });
    expect(resolved.effort).toBe("max");
  });

  test("a custom catalog replaces the built-in outright; $schema is stripped", () => {
    const { env, home } = writeCatalog(JSON.stringify({ $schema: "x", ...CUSTOM }));
    const catalog = loadCatalog(env, home);
    expect(catalog.source).toBe("custom");
    expect(catalog.harnesses.map((entry) => entry.harness)).toEqual(["codex", "pi"]);
  });

  test("a malformed custom catalog is catalog_invalid, never a fall-back", () => {
    const { env, home } = writeCatalog("not json");
    try {
      loadCatalog(env, home);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("catalog_invalid");
    }
  });

  test("unknown keys, bad names, and structural faults are rejected", () => {
    for (const bad of [
      JSON.stringify({ ...CUSTOM, extra: 1 }),
      JSON.stringify({ ...CUSTOM, harness: "codex" }),
      JSON.stringify({ harnesses: [{ harness: "cursor" }] }),
      JSON.stringify({
        harnesses: [
          {
            harness: "pi",
            efforts: [],
            models: [{ model: "m" }],
            defaults: { model: "m", effort: "low" },
          },
        ],
      }),
      JSON.stringify([1]),
    ]) {
      const { env, home } = writeCatalog(bad);
      expect(() => loadCatalog(env, home)).toThrow(CliError);
    }
  });

  test("unknown families, foreign providers, and duplicates are faults", () => {
    const ghost = {
      harnesses: [{ harness: "pi", families: [{ family: "ghost" }] }],
    };
    const { env: env1, home: home1 } = writeCatalog(JSON.stringify(ghost));
    expect(() => loadCatalog(env1, home1)).toThrow(/unknown family "ghost"/);

    const withProvider = structuredClone(CUSTOM);
    withProvider.harnesses[0] = {
      harness: "codex",
      families: [{ family: "gpt", provider: "prov" }],
    } as never;
    const { env: env2, home: home2 } = writeCatalog(JSON.stringify(withProvider));
    expect(() => loadCatalog(env2, home2)).toThrow(/no provider semantics/);

    const twice = {
      families: CUSTOM.families,
      harnesses: [CUSTOM.harnesses[0], CUSTOM.harnesses[0]],
    };
    const { env: env3, home: home3 } = writeCatalog(JSON.stringify(twice));
    expect(() => loadCatalog(env3, home3)).toThrow(/more than once/);

    const shadowed = structuredClone(CUSTOM);
    shadowed.harnesses[1] = {
      ...shadowed.harnesses[1],
      models: [{ model: "gpt-a", efforts: ["low"] }],
    } as never;
    const { env: env4, home: home4 } = writeCatalog(JSON.stringify(shadowed));
    expect(() => loadCatalog(env4, home4)).toThrow(/"gpt-a" more than once \(via family "gpt"\)/);
  });
});

describe("resolveRequest", () => {
  const builtin = () => {
    const { env, home } = emptyHome();
    return loadCatalog(env, home);
  };

  test("a harness name resolves to its defaults, marked defaulted", () => {
    const resolved = resolveRequest(builtin(), { harness: "claude" });
    expect(resolved.harness).toBe("claude");
    expect(resolved.model.model).toBe("opus-1m");
    expect(resolved.effort).toBe("medium");
    expect(resolved.modelDefaulted).toBe(true);
    expect(resolved.effortDefaulted).toBe(true);
  });

  test("model:effort walks catalog order; earliest offering wins", () => {
    const sol = resolveRequest(builtin(), { model: "gpt-5.6-sol", effort: "ultra" });
    expect(sol.harness).toBe("codex");
    expect(sol.model.spelling).toBe("gpt-5.6-sol");
    expect(sol.modelDefaulted).toBe(false);
    const sonnet = resolveRequest(builtin(), { model: "sonnet", effort: "high" });
    expect(sonnet.harness).toBe("claude");
  });

  test("a pinned triple validates and keeps the pi spelling", () => {
    const pinned = resolveRequest(builtin(), {
      harness: "pi",
      model: "gpt-5.6-luna",
      effort: "max",
    });
    expect(pinned.model.spelling).toBe("openai-codex/gpt-5.6-luna");
    expect(() =>
      resolveRequest(builtin(), { harness: "codex", model: "gpt-5.5", effort: "ultra" }),
    ).toThrow(/does not take effort "ultra"/);
    expect(() =>
      resolveRequest(builtin(), { harness: "claude", model: "gpt-5.5", effort: "high" }),
    ).toThrow(/does not offer model "gpt-5.5"/);
  });

  test("misses name what would have been accepted where", () => {
    expect(() => resolveRequest(builtin(), { model: "nope", effort: "high" })).toThrow(
      /no harness in the catalog offers model "nope"/,
    );
    expect(() => resolveRequest(builtin(), { model: "gpt-5.5", effort: "ultra" })).toThrow(
      /codex allows low, medium, high, xhigh; pi allows low, medium, high, xhigh/,
    );
  });

  test("a sparse request without a harness is guarded", () => {
    expect(() => resolveRequest(builtin(), { model: "opus" })).toThrow(UsageError);
    expect(() => resolveRequest(builtin(), {})).toThrow(UsageError);
  });

  test("an unlisted harness is a usage fault", () => {
    const { env, home } = writeCatalog(JSON.stringify(CUSTOM));
    expect(() => resolveRequest(loadCatalog(env, home), { harness: "claude" })).toThrow(
      /the catalog does not list harness "claude"/,
    );
  });
});
