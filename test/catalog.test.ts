import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, resolveRequest } from "../src/catalog.ts";
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

/** A minimal valid custom catalog to mutate per test. */
const CUSTOM = {
  harness: "codex",
  families: {
    gpt: { models: [{ model: "gpt-5.6" }, { model: "gpt-5.3-codex-spark" }] },
  },
  harnesses: [
    {
      harness: "codex",
      efforts: ["low", "high"],
      effort: "high",
      families: [{ family: "gpt" }],
      model: "gpt-5.6",
    },
    {
      harness: "pi",
      efforts: ["low", "high", "max"],
      effort: "high",
      families: [{ family: "gpt", provider: "openai-codex" }],
      model: "gpt-5.6",
    },
  ],
};

describe("loadCatalog", () => {
  test("no custom file loads the built-in, in its stated order", () => {
    const { env, home } = emptyHome();
    const catalog = loadCatalog(env, home);
    expect(catalog.source).toBe("built-in");
    expect(catalog.harness).toBe("claude");
    expect(catalog.harnesses.map((entry) => entry.harness)).toEqual(["claude", "codex", "pi"]);
    expect(catalog.harnesses[0]?.models.map((model) => model.model)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  test("a family member keeps one typed name and gets per-harness spellings", () => {
    const { env, home } = emptyHome();
    const catalog = loadCatalog(env, home);
    const codex = catalog.harnesses.find((entry) => entry.harness === "codex");
    const pi = catalog.harnesses.find((entry) => entry.harness === "pi");
    const viaCodex = codex?.models.find((model) => model.model === "gpt-5.6");
    const viaPi = pi?.models.find((model) => model.model === "gpt-5.6");
    expect(viaCodex?.spelling).toBe("gpt-5.6");
    expect(viaPi?.spelling).toBe("openai-codex/gpt-5.6");
    expect(viaPi?.family).toBe("gpt");
  });

  test("a custom catalog replaces the built-in outright", () => {
    const { env, home } = writeCatalog(JSON.stringify(CUSTOM));
    const catalog = loadCatalog(env, home);
    expect(catalog.source).toBe("custom");
    expect(catalog.harness).toBe("codex");
    expect(catalog.harnesses.map((entry) => entry.harness)).toEqual(["codex", "pi"]);
  });

  test("$schema is tolerated and stripped", () => {
    const { env, home } = writeCatalog(JSON.stringify({ $schema: "x", ...CUSTOM }));
    expect(loadCatalog(env, home).source).toBe("custom");
  });

  test("members inherit the including harness's efforts unless they carry their own", () => {
    const narrowed = structuredClone(CUSTOM);
    narrowed.families.gpt.models[1] = {
      model: "gpt-5.3-codex-spark",
      efforts: ["high"],
    } as never;
    const { env, home } = writeCatalog(JSON.stringify(narrowed));
    const catalog = loadCatalog(env, home);
    const pi = catalog.harnesses.find((entry) => entry.harness === "pi");
    expect(pi?.models.find((model) => model.model === "gpt-5.6")?.efforts).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(pi?.models.find((model) => model.model === "gpt-5.3-codex-spark")?.efforts).toEqual([
      "high",
    ]);
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

  test("unknown keys, bad names, and missing required defaults are rejected", () => {
    const { harness: _dropped, ...withoutDefault } = CUSTOM;
    for (const bad of [
      JSON.stringify({ ...CUSTOM, extra: 1 }),
      JSON.stringify(withoutDefault),
      JSON.stringify({ harness: "pi", harnesses: [{ harness: "cursor", efforts: ["low"] }] }),
      JSON.stringify({ harness: "pi", harnesses: [{ harness: "pi", efforts: [] }] }),
      JSON.stringify({
        harness: "pi",
        harnesses: [
          {
            harness: "pi",
            efforts: ["low"],
            effort: "low",
            models: [{ model: "a/b" }],
            model: "a/b",
          },
        ],
      }),
      JSON.stringify([1]),
    ]) {
      const { env, home } = writeCatalog(bad);
      expect(() => loadCatalog(env, home)).toThrow(CliError);
    }
  });

  test("an include referencing an unknown family is a catalog fault", () => {
    const { env, home } = writeCatalog(
      JSON.stringify({
        harness: "pi",
        harnesses: [
          {
            harness: "pi",
            efforts: ["low"],
            effort: "low",
            model: "x",
            families: [{ family: "ghost" }],
          },
        ],
      }),
    );
    expect(() => loadCatalog(env, home)).toThrow(/unknown family "ghost"/);
  });

  test("a provider on a harness without provider semantics is a catalog fault", () => {
    const withProvider = structuredClone(CUSTOM);
    withProvider.harnesses[0] = {
      harness: "codex",
      efforts: ["low", "high"],
      effort: "high",
      model: "gpt-5.6",
      families: [{ family: "gpt", provider: "openai-codex" }],
    } as never;
    const { env, home } = writeCatalog(JSON.stringify(withProvider));
    expect(() => loadCatalog(env, home)).toThrow(/no provider semantics/);
  });

  test("duplicate harnesses and duplicate models after expansion are faults", () => {
    const twice = { harness: "codex", harnesses: [CUSTOM.harnesses[0], CUSTOM.harnesses[0]] };
    const { env: env1, home: home1 } = writeCatalog(
      JSON.stringify({ families: CUSTOM.families, ...twice }),
    );
    expect(() => loadCatalog(env1, home1)).toThrow(/more than once/);

    const shadowed = structuredClone(CUSTOM);
    shadowed.harnesses[1] = {
      ...shadowed.harnesses[1],
      models: [{ model: "gpt-5.6" }],
    } as never;
    const { env: env2, home: home2 } = writeCatalog(JSON.stringify(shadowed));
    expect(() => loadCatalog(env2, home2)).toThrow(/"gpt-5.6" more than once \(via family "gpt"\)/);
  });

  test("default declarations are validated where they are declared", () => {
    const unlisted = { ...structuredClone(CUSTOM), harness: "claude" };
    const effortOutside = structuredClone(CUSTOM);
    effortOutside.harnesses[0] = { ...effortOutside.harnesses[0], effort: "max" } as never;
    const modelUnknown = structuredClone(CUSTOM);
    modelUnknown.harnesses[0] = { ...modelUnknown.harnesses[0], model: "ghost" } as never;
    const narrowedWithoutOwn = {
      harness: "pi",
      families: { gpt: { models: [{ model: "m", efforts: ["low"] }] } },
      harnesses: [
        {
          harness: "pi",
          efforts: ["low", "max"],
          effort: "max",
          families: [{ family: "gpt", provider: "openai-codex" }],
          model: "m",
        },
      ],
    };
    const memberDefaultOutside = {
      harness: "pi",
      harnesses: [
        {
          harness: "pi",
          efforts: ["low", "max"],
          effort: "low",
          models: [{ model: "m", efforts: ["low"], effort: "max" }],
          model: "m",
        },
      ],
    };
    for (const [bad, message] of [
      [unlisted, /default harness "claude" is not listed/],
      [effortOutside, /default effort "max" is not in its efforts/],
      [modelUnknown, /default model "ghost" is not among its models/],
      [narrowedWithoutOwn, /not allowed by model "m"; give that model its own "effort"/],
      [memberDefaultOutside, /model "m" default effort "max" is not in its efforts/],
    ] as const) {
      const { env, home } = writeCatalog(JSON.stringify(bad));
      expect(() => loadCatalog(env, home)).toThrow(message);
    }
  });
});

describe("resolveRequest", () => {
  const builtin = () => {
    const { env, home } = emptyHome();
    return loadCatalog(env, home);
  };

  test("catalog order breaks the tie for a model both codex and pi offer", () => {
    const resolved = resolveRequest(builtin(), { model: "gpt-5.6" });
    expect(resolved.harness).toBe("codex");
    expect(resolved.model?.spelling).toBe("gpt-5.6");
    expect(resolved.modelDefaulted).toBe(false);
    expect(resolved.effort).toBe("xhigh");
    expect(resolved.effortDefaulted).toBe(true);
  });

  test("the effort participates in the match: max skips codex and lands on pi", () => {
    const resolved = resolveRequest(builtin(), { model: "gpt-5.6", effort: "max" });
    expect(resolved.harness).toBe("pi");
    expect(resolved.model?.spelling).toBe("openai-codex/gpt-5.6");
    expect(resolved.effort).toBe("max");
    expect(resolved.effortDefaulted).toBe(false);
  });

  test("an effort codex does take keeps the earlier harness", () => {
    expect(resolveRequest(builtin(), { model: "gpt-5.6", effort: "xhigh" }).harness).toBe("codex");
  });

  test("effort-only requests match harness sets in order and fill the default model", () => {
    const max = resolveRequest(builtin(), { effort: "max" });
    expect(max.harness).toBe("claude");
    expect(max.model?.model).toBe("fable");
    expect(max.modelDefaulted).toBe(true);
    expect(resolveRequest(builtin(), { effort: "minimal" }).harness).toBe("codex");
    expect(resolveRequest(builtin(), { effort: "off" }).harness).toBe("pi");
  });

  test("nothing requested resolves to the default harness with its defaults filled", () => {
    const resolved = resolveRequest(builtin(), {});
    expect(resolved.harness).toBe("claude");
    expect(resolved.model?.model).toBe("fable");
    expect(resolved.effort).toBe("max");
    expect(resolved.modelDefaulted).toBe(true);
    expect(resolved.effortDefaulted).toBe(true);
  });

  test("a model's own default effort overrides the harness default", () => {
    const { env, home } = writeCatalog(
      JSON.stringify({
        harness: "codex",
        harnesses: [
          {
            harness: "codex",
            efforts: ["low", "high"],
            effort: "low",
            models: [
              { model: "small", efforts: ["low"] },
              { model: "big", effort: "high" },
            ],
            model: "small",
          },
        ],
      }),
    );
    const catalog = loadCatalog(env, home);
    const big = resolveRequest(catalog, { model: "big" });
    expect(big.effort).toBe("high");
    expect(big.effortDefaulted).toBe(true);
    const small = resolveRequest(catalog, { model: "small" });
    expect(small.effort).toBe("low");
  });

  test("the default model steps aside rather than contradict an explicit effort", () => {
    const { env, home } = writeCatalog(
      JSON.stringify({
        harness: "codex",
        harnesses: [
          {
            harness: "codex",
            efforts: ["low", "high"],
            effort: "low",
            models: [{ model: "small", efforts: ["low"] }, { model: "big" }],
            model: "small",
          },
        ],
      }),
    );
    const resolved = resolveRequest(loadCatalog(env, home), { effort: "high" });
    expect(resolved.harness).toBe("codex");
    expect(resolved.model).toBeNull();
    expect(resolved.modelDefaulted).toBe(false);
    expect(resolved.effort).toBe("high");
  });

  test("a pinned harness validates instead of selecting", () => {
    const ok = resolveRequest(builtin(), { harness: "pi", model: "gpt-5.6", effort: "max" });
    expect(ok.model?.spelling).toBe("openai-codex/gpt-5.6");
    expect(() => resolveRequest(builtin(), { harness: "codex", effort: "max" })).toThrow(
      /does not take effort "max"/,
    );
    expect(() => resolveRequest(builtin(), { harness: "claude", model: "gpt-5.6" })).toThrow(
      /does not offer model "gpt-5.6" \(it offers fable, opus, sonnet, haiku\)/,
    );
  });

  test("a pinned harness fills its defaults too", () => {
    const resolved = resolveRequest(builtin(), { harness: "pi" });
    expect(resolved.model?.spelling).toBe("openai-codex/gpt-5.6");
    expect(resolved.effort).toBe("high");
    expect(resolved.modelDefaulted).toBe(true);
    expect(resolved.effortDefaulted).toBe(true);
  });

  test("misses name what would have been accepted where", () => {
    expect(() => resolveRequest(builtin(), { model: "nope" })).toThrow(
      /no harness in the catalog offers model "nope"/,
    );
    expect(() => resolveRequest(builtin(), { model: "gpt-5.6", effort: "ultra" })).toThrow(
      /codex allows minimal, low, medium, high, xhigh; pi allows/,
    );
    expect(() => resolveRequest(builtin(), { effort: "ultra" })).toThrow(UsageError);
  });
});
