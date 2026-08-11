import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isFile,
  matchesPath,
  pathForGlob,
  readJson,
  readText,
  uniqueBy,
} from "../src/util.js";

describe("file utilities", () => {
  it("normalizes and matches License Eye path patterns", () => {
    expect(pathForGlob("src/index.ts")).toBe("src/index.ts");
    expect(matchesPath("src/index.ts", ["src"])).toBe(true);
    expect(matchesPath("src/index.ts", ["./src/**/*.ts"])).toBe(true);
    expect(matchesPath(".github/workflows/check.yml", [".github"])).toBe(true);
    expect(matchesPath("src/index.ts", undefined)).toBe(false);
    expect(matchesPath("src/index.ts", [])).toBe(false);
  });

  it("reads files safely and removes duplicate values", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-util-"));
    const jsonPath = join(root, "config.json");
    const textPath = join(root, "note.txt");
    writeFileSync(jsonPath, '{"enabled":true}');
    writeFileSync(textPath, "hello");

    expect(readJson(jsonPath)).toEqual({ enabled: true });
    expect(readJson(textPath)).toBeUndefined();
    expect(readText(textPath)).toBe("hello");
    expect(readText(join(root, "missing.txt"))).toBeUndefined();
    expect(isFile(textPath)).toBe(true);
    expect(isFile(root)).toBe(false);
    expect(isFile(join(root, "missing.txt"))).toBe(false);
    expect(uniqueBy(["one", "two", "one"], (value) => value)).toEqual([
      "one",
      "two",
    ]);
  });
});
