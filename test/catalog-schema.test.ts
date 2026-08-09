import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchema } from "../scripts/generate-schema.ts";

describe("catalog.schema.json", () => {
  test("the checked-in file matches the zod source of truth", () => {
    const path = join(import.meta.dir, "..", "catalog.schema.json");
    const checked = JSON.parse(readFileSync(path, "utf8"));
    expect(checked).toEqual(JSON.parse(JSON.stringify(buildSchema())));
  });
});
