import { describe, expect, test } from "bun:test";
import { renderTopHelp } from "../src/render.ts";

describe("contract help rendering", () => {
  test("names only supported harnesses in the top-level purpose", () => {
    const help = renderTopHelp();

    expect(help).toStartWith("agentlaunch — resolve, balance, and launch claude or codex\n");
    expect(help).not.toMatch(/\bpi\b/i);
  });
});
