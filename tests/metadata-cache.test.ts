/*
 * Copyright 2026 Zaphiro Technologies
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  restoreCache: vi.fn(),
  saveCache: vi.fn(),
  warning: vi.fn(),
}));
const cacheTest = vi.hoisted(() => ({ directory: "" }));

vi.mock("@actions/cache", () => ({
  restoreCache: mocks.restoreCache,
  saveCache: mocks.saveCache,
}));
vi.mock("@actions/core", () => ({
  info: mocks.info,
  warning: mocks.warning,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  tmpdir: () => cacheTest.directory,
}));

const cacheEnvironment = [
  "GITHUB_ACTIONS",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_CACHE_URL",
  "ACTIONS_RUNTIME_URL",
] as const;
let originalEnvironment: Map<string, string | undefined>;

async function loadCache() {
  return import("../src/dependencies/metadata/cache/index.js");
}

describe("persistent dependency metadata cache", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalEnvironment = new Map(
      cacheEnvironment.map((name) => [name, process.env[name]]),
    );
    cacheTest.directory = mkdtempSync(join("/tmp", "license-checker-cache-"));
    process.env.GITHUB_ACTIONS = "true";
    process.env.ACTIONS_RUNTIME_TOKEN = "runtime-token";
    process.env.ACTIONS_CACHE_URL = "https://cache.example";
    mocks.restoreCache.mockResolvedValue(undefined);
    mocks.saveCache.mockResolvedValue(1);
  });

  afterEach(() => {
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(cacheTest.directory, { recursive: true, force: true });
  });

  it("does not access the GitHub cache outside an Actions runtime", async () => {
    delete process.env.GITHUB_ACTIONS;
    const cache = await loadCache();

    await cache.restoreMetadataCache("/workspace", ["package-lock.json"]);
    await cache.saveMetadataCache();

    expect(mocks.restoreCache).not.toHaveBeenCalled();
    expect(mocks.saveCache).not.toHaveBeenCalled();
  });

  it("stores only useful npm and Python release metadata", async () => {
    const cache = await loadCache();
    await cache.restoreMetadataCache("/workspace", ["package-lock.json"]);

    const { rememberNpmLicenseMetadata } =
      await import("../src/dependencies/metadata/cache/npm.js");
    const { cachedPythonLicenseMetadata, rememberPythonLicenseMetadata } =
      await import("../src/dependencies/metadata/cache/python.js");
    const npmUrl = "https://registry.npmjs.org/example/1.2.3";
    const pythonUrl = "https://pypi.org/pypi/example/1.2.3/json";
    rememberNpmLicenseMetadata(npmUrl, {
      license: "MIT",
      description: "not needed by the license resolver",
    });
    rememberNpmLicenseMetadata("https://evil.example/example/1.2.3", {
      license: "MIT",
    });
    rememberPythonLicenseMetadata(pythonUrl, { info: { summary: "empty" } });

    expect(cachedPythonLicenseMetadata(pythonUrl)).toBeUndefined();
    await cache.saveMetadataCache();

    expect(mocks.saveCache).toHaveBeenCalledOnce();
    const [paths, key] = mocks.saveCache.mock.calls[0] as [string[], string];
    expect(key).toMatch(
      /^license-checker-metadata-v1-[a-f0-9]{16}-[a-f0-9]{16}$/,
    );
    expect(JSON.parse(readFileSync(paths[0], "utf8"))).toEqual({
      [npmUrl]: { license: "MIT" },
    });
  });

  it("restores only registry metadata from a cache entry", async () => {
    const npmUrl = "https://registry.npmjs.org/example/1.2.3";
    mocks.restoreCache.mockImplementation(async (paths: string[]) => {
      mkdirSync(join(cacheTest.directory, "license-checker"), {
        recursive: true,
      });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        paths[0],
        JSON.stringify({
          [npmUrl]: { license: "MIT", unused: true },
          "https://evil.example/example/1.2.3": { license: "GPL-3.0-only" },
        }),
      );
      return "license-checker-metadata-v1-restored";
    });
    const cache = await loadCache();
    await cache.restoreMetadataCache("/workspace", ["package-lock.json"]);

    const { cachedNpmLicenseMetadata } =
      await import("../src/dependencies/metadata/cache/npm.js");
    expect(cachedNpmLicenseMetadata(npmUrl)).toEqual({ license: "MIT" });
    expect(
      cachedNpmLicenseMetadata("https://evil.example/example/1.2.3"),
    ).toBeUndefined();
    expect(mocks.info).toHaveBeenCalledWith(
      "Restored 1 dependency metadata entries from cache.",
    );
  });
});
