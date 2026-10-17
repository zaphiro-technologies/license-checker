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

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDependencies } from "../src/dependencies.js";
import { Logger } from "../src/logger.js";
import type { LicenseEyeConfig } from "../src/types.js";
import type { GoPackageListRunner } from "../src/dependencies.js";

function goList(...entries: string[]): GoPackageListRunner {
  return () =>
    entries
      .map((entry) => {
        const [Path, Version] = entry.split(/\s+/);
        return JSON.stringify({ Module: { Path, Version } });
      })
      .join("\n");
}

describe("dependency checker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses configured license overrides before remote resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-deps-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "go.mod"),
      `module example.com/app\n\nrequire (\n  github.com/zaphiro-technologies/roger v1.2.3\n)\n`,
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["go.mod"],
        licenses: [
          {
            name: "github.com/zaphiro-technologies/roger",
            match: ".*",
            license: "LicenseRef-Wildcard",
          },
          {
            name: "github.com/zaphiro-technologies/roger",
            license: "Apache-2.0",
          },
        ],
      },
    };
    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      goList("github.com/zaphiro-technologies/roger v1.2.3"),
    );
    expect(report.checked).toBe(1);
    expect(report.failures).toHaveLength(0);
    expect(report.results[0]).toMatchObject({
      license: "Apache-2.0",
      resolution: "configured",
    });
  });

  it("uses the exact npm lockfile version instead of the manifest range", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "license-checker-npm-lock-version-"),
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "locked-package": "^2.0.0" } }),
    );
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/locked-package": { version: "2.4.1" },
        },
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        licenses: [
          { name: "locked-package", version: "2.4.1", license: "MIT" },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "locked-package",
      version: "2.4.1",
      license: "MIT",
      resolution: "configured",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("excludes npm lock entries marked as development-only by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-npm-dev-lock-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { runtime: "^1.0.0" },
        devDependencies: { tooling: "^2.0.0" },
      }),
    );
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/runtime": { version: "1.2.0" },
          "node_modules/tooling": { version: "2.3.0", dev: true },
        },
      }),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        licenses: [
          { name: "runtime", license: "MIT" },
          { name: "tooling", license: "MIT" },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results.map((result) => result.name)).toEqual(["runtime"]);
  });

  it("includes npm dev-only lock entries when development dependencies are opted in", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-npm-dev-opt-in-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { tooling: "^2.0.0" } }),
    );
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/tooling": { version: "2.3.0", dev: true },
        },
      }),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        includeDevDependencies: true,
        licenses: [{ name: "tooling", license: "MIT" }],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results.map((result) => result.name)).toEqual(["tooling"]);
  });

  it("resolves pnpm production dependency closure without dev-only packages", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-pnpm-prod-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { runtime: "^1.0.0" } }),
    );
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      runtime:\n        specifier: ^1.0.0\n        version: 1.2.0\n    devDependencies:\n      testTool:\n        specifier: ^2.0.0\n        version: 2.1.0\npackages:\n  runtime@1.2.0: {}\n  shared@3.0.0: {}\n  testTool@2.1.0: {}\nsnapshots:\n  runtime@1.2.0:\n    dependencies:\n      shared: 3.0.0\n  shared@3.0.0: {}\n  testTool@2.1.0: {}\n`,
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        licenses: [
          { name: "runtime", license: "MIT" },
          { name: "shared", license: "MIT" },
          { name: "testTool", license: "MIT" },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results.map((result) => result.name).sort()).toEqual([
      "runtime",
      "shared",
    ]);
  });

  it("uses the exact Pipfile lock version for Python dependencies", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-pipfile-lock-"));
    writeFileSync(
      join(root, "Pipfile.lock"),
      JSON.stringify({
        default: { "locked-package": { version: "==1.7.2" } },
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["Pipfile.lock"],
        licenses: [
          { name: "locked-package", version: "1.7.2", license: "MIT" },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "locked-package",
      version: "1.7.2",
      license: "MIT",
      resolution: "configured",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes Pipfile development dependencies only when opted in", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-pipfile-dev-"));
    writeFileSync(
      join(root, "Pipfile.lock"),
      JSON.stringify({
        default: { runtime: { version: "==1.0.0" } },
        develop: { pytest: { version: "==8.0.0" } },
      }),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["Pipfile.lock"],
        licenses: [
          { name: "runtime", license: "MIT" },
          { name: "pytest", license: "MIT" },
        ],
      },
    };

    const runtimeReport = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );
    const developmentReport = await checkDependencies(
      root,
      {
        ...config,
        dependency: { ...config.dependency, includeDevDependencies: true },
      },
      undefined,
      false,
      new Logger("error"),
    );

    expect(runtimeReport.results.map((result) => result.name)).toEqual([
      "runtime",
    ]);
    expect(
      developmentReport.results.map((result) => result.name).sort(),
    ).toEqual(["pytest", "runtime"]);
  });

  it("requires a lockfile for opted-in pyproject development groups", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-pyproject-dev-"));
    writeFileSync(
      join(root, "pyproject.toml"),
      `[dependency-groups]\ndev = ["pytest>=8.0"]\n\n[tool.poetry.group.test.dependencies]\ncoverage = "^7.0"\n`,
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["pyproject.toml"],
        includeDevDependencies: true,
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.failures.map((result) => result.name).sort()).toEqual([
      "coverage",
      "pytest",
    ]);
    expect(
      report.failures.every((result) => result.versionResolved === false),
    ).toBe(true);
  });

  it("uses the Go package graph version selected above the go.mod requirement", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-go-build-list-"));
    writeFileSync(
      join(root, "go.mod"),
      `module example.com/app\n\ngo 1.23\n\nrequire example.com/locked v1.2.0\n`,
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["go.mod"],
        licenses: [
          {
            name: "example.com/locked",
            version: "v1.5.0",
            license: "MIT",
          },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      goList("example.com/locked v1.5.0"),
    );

    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "example.com/locked",
      version: "v1.5.0",
      license: "MIT",
      resolution: "configured",
    });
  });

  it("uses the configured Go target graph and deduplicates module providers", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-go-targets-"));
    writeFileSync(join(root, "go.mod"), "module example.com/app\n\ngo 1.23\n");
    const packageList: GoPackageListRunner = vi.fn(() =>
      [
        {
          ImportPath: "example.com/app/cmd",
          Module: { Path: "example.com/app", Main: true },
        },
        {
          ImportPath: "example.com/app/cmd",
          Module: { Path: "example.com/shared", Version: "v1.2.3" },
        },
        {
          ImportPath: "example.com/app/other",
          Module: { Path: "example.com/shared", Version: "v1.2.3" },
        },
        { ImportPath: "fmt" },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n"),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["go.mod"],
        licenses: [{ name: "example.com/shared", license: "MIT" }],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      packageList,
    );

    expect(packageList).toHaveBeenCalledWith(root, ["./..."], false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "example.com/shared",
      version: "v1.2.3",
      license: "MIT",
    });
  });

  it("includes Go test dependencies when development dependencies are opted in", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-go-dev-opt-in-"));
    writeFileSync(join(root, "go.mod"), "module example.com/app\n\ngo 1.23\n");
    const packageList: GoPackageListRunner = vi.fn(
      (_directory, _packages, includeTests) =>
        JSON.stringify({
          Module: {
            Path: includeTests
              ? "example.com/test-dependency"
              : "example.com/runtime-dependency",
            Version: "v1.0.0",
          },
        }),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["go.mod"],
        includeDevDependencies: true,
        go: { packages: ["./cmd"] },
        licenses: [
          { name: "example.com/runtime-dependency", license: "MIT" },
          { name: "example.com/test-dependency", license: "MIT" },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      packageList,
    );

    expect(packageList).toHaveBeenNthCalledWith(1, root, ["./cmd"], false);
    expect(packageList).toHaveBeenNthCalledWith(2, root, ["./cmd"], true);
    expect(report.results.map((result) => result.name).sort()).toEqual([
      "example.com/runtime-dependency",
      "example.com/test-dependency",
    ]);
  });

  it("assigns a configured license when declared metadata matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-match-metadata-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/acme-package": {
            version: "2.0.0",
            license: "MIT",
          },
        },
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        licenses: [
          {
            name: "acme-package",
            match: "Copyright.*All rights reserved",
            license: "LicenseRef-Text-Match",
          },
          {
            name: "acme-package",
            match: "MIT",
            license: "LicenseRef-Acme-Proprietary",
          },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results[0]).toMatchObject({
      license: "LicenseRef-Acme-Proprietary",
      normalized: "LicenseRef-Acme-Proprietary",
      resolution: "configured",
      source: "configuration",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("assigns a configured license when downloaded repository text matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-match-text-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/acme-package": { version: "2.0.0" },
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "https://registry.npmjs.org/acme-package/2.0.0")
          return Promise.resolve({
            ok: true,
            json: async () => ({
              license: "MIT",
              repository: {
                url: "git+https://github.com/acme/acme-package.git",
              },
            }),
          });
        if (url === "https://api.github.com/repos/acme/acme-package/license")
          return Promise.resolve({
            ok: true,
            json: async () => ({
              license: { spdx_id: "MIT" },
              download_url: "https://raw.example/acme/acme-package/LICENSE",
            }),
          });
        if (url === "https://raw.example/acme/acme-package/LICENSE")
          return Promise.resolve({
            ok: true,
            text: async () =>
              "Copyright (c) Acme Corporation. All rights reserved.",
          });
        return Promise.resolve({ ok: false, json: async () => ({}) });
      }),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        licenses: [
          {
            name: "acme-package",
            match: "Copyright \\(c\\) Acme.*All rights reserved",
            license: "LicenseRef-Acme-Proprietary",
          },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results[0]).toMatchObject({
      license: "LicenseRef-Acme-Proprietary",
      normalized: "LicenseRef-Acme-Proprietary",
      resolution: "configured",
      source: "configuration",
    });
  });

  it("prefers vendored Go license files before remote resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-go-vendor-"));
    writeFileSync(
      join(root, "go.mod"),
      "module example.com/app\n\nrequire example.com/non-github v1.2.3\n",
    );
    const vendorModule = join(root, "vendor", "example.com", "non-github");
    mkdirSync(vendorModule, { recursive: true });
    writeFileSync(
      join(vendorModule, "LICENCE"),
      "Apache License\nVersion 2.0, January 2004\n",
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: { files: ["go.mod"] },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      goList("example.com/non-github v1.2.3"),
    );

    expect(report.results[0]).toMatchObject({
      name: "example.com/non-github",
      license: "Apache-2.0",
      source: "vendor/example.com/non-github/LICENCE",
      resolution: "manifest",
      compatible: "compatible",
    });
  });

  it("uses configured license text rules for vendored Go licenses", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "license-checker-go-license-rule-"),
    );
    writeFileSync(
      join(root, "go.mod"),
      "module example.com/app\n\nrequire example.com/non-github v1.2.3\n",
    );
    const vendorModule = join(root, "vendor", "example.com", "non-github");
    mkdirSync(vendorModule, { recursive: true });
    writeFileSync(
      join(vendorModule, "LICENSE"),
      "Custom permit terms apply to this package.\n",
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["go.mod"],
        licenseRules: [
          {
            source: "license-text",
            match: "custom permit terms",
            license: "MIT",
          },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      goList("example.com/non-github v1.2.3"),
    );

    expect(report.results[0]).toMatchObject({
      license: "MIT",
      source: "configuration",
      resolution: "configured",
      compatible: "compatible",
    });
  });

  it("requires approval for reciprocal licenses in a proprietary binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-distribution-"));
    writeFileSync(
      join(root, "go.mod"),
      "module example.com/app\n\nrequire example.com/reciprocal v1.2.3\n",
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["go.mod"],
        projectLicense: "proprietary",
        licenses: [
          {
            name: "example.com/reciprocal",
            license: "LGPL-3.0-or-later",
          },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      goList("example.com/reciprocal v1.2.3"),
      "proprietary-binary",
    );

    expect(report.failures).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      compatible: "unknown",
      distributionWarning: expect.stringContaining("LGPL"),
      reason: expect.stringContaining("Manual approval required"),
      adviceUrl: expect.stringContaining("licensecompat.com"),
    });
  });

  it("records a version-pinned non-SPDX exception as a manual approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-exception-"));
    writeFileSync(
      join(root, "go.mod"),
      "module example.com/app\n\nrequire example.com/proprietary v1.2.3\n",
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["go.mod"],
        exceptions: [
          {
            name: "example.com/proprietary",
            version: "v1.2.3",
            url: "https://example.com/license",
            reason: "Approved by legal for this pinned dependency version.",
          },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      goList("example.com/proprietary v1.2.3"),
    );

    expect(report.failures).toHaveLength(0);
    expect(report.results[0]).toMatchObject({
      compatible: "approved-exception",
      resolution: "exception",
      approval: {
        url: "https://example.com/license",
        reason: "Approved by legal for this pinned dependency version.",
      },
    });
  });

  it("parses Yarn Berry selectors and versions", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-yarn-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: {
          foo: "^1.0.0",
          "@scope/bar": "^2.0.0",
          "react-loadable": "npm:@docusaurus/react-loadable@6.0.0",
        },
      }),
    );
    writeFileSync(
      join(root, "yarn.lock"),
      `__metadata:\n  version: 6\n\n"documentation@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "documentation@workspace:."\n\nfoo@npm:^1.0.0:\n  version: 1.2.3\n\n"@scope/bar@npm:^2.0.0":\n  version: 2.1.0\n\n"react-loadable@npm:@docusaurus/react-loadable@6.0.0":\n  version: 6.0.0\n`,
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        licenses: [
          { name: "foo", license: "Apache-2.0" },
          { name: "@scope/bar", license: "Apache-2.0" },
          { name: "@docusaurus/react-loadable", license: "MIT" },
        ],
      },
    };
    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );
    expect(
      report.results.map((result) => `${result.name}@${result.version}`).sort(),
    ).toEqual(
      [
        "@scope/bar@2.1.0",
        "@docusaurus/react-loadable@6.0.0",
        "foo@1.2.3",
      ].sort(),
    );
    expect(report.failures).toHaveLength(0);
  });

  it("omits Yarn development-only dependency trees unless opted in", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-yarn-dev-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { runtime: "^1.0.0" },
        devDependencies: { testTool: "^2.0.0" },
      }),
    );
    writeFileSync(
      join(root, "yarn.lock"),
      `runtime@npm:^1.0.0:\n  version: 1.2.0\n  resolution: "runtime@npm:1.2.0"\n  dependencies:\n    shared: "npm:^3.0.0"\n\nshared@npm:^3.0.0:\n  version: 3.1.0\n\ntestTool@npm:^2.0.0:\n  version: 2.4.0\n  dependencies:\n    testOnly: "npm:^4.0.0"\n\ntestOnly@npm:^4.0.0:\n  version: 4.1.0\n`,
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        licenses: [
          { name: "runtime", license: "MIT" },
          { name: "shared", license: "MIT" },
          { name: "testTool", license: "MIT" },
          { name: "testOnly", license: "MIT" },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results.map((result) => result.name).sort()).toEqual([
      "runtime",
      "shared",
    ]);
  });

  it("resolves Yarn dependency ranges through package resolutions", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "license-checker-yarn-resolutions-"),
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { runtime: "^1.0.0" },
        resolutions: { overridden: "2.0.0" },
      }),
    );
    writeFileSync(
      join(root, "yarn.lock"),
      `runtime@npm:^1.0.0:\n  version: 1.2.0\n  dependencies:\n    overridden: "npm:^1.0.0"\n\n"overridden@npm:2.0.0":\n  version: 2.0.0\n`,
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        licenses: [
          { name: "runtime", license: "MIT" },
          { name: "overridden", license: "MIT" },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.failures).toHaveLength(0);
    expect(
      report.results.map((result) => `${result.name}@${result.version}`).sort(),
    ).toEqual(["overridden@2.0.0", "runtime@1.2.0"]);
  });

  it("prefers the adjacent Poetry lockfile's exact package versions", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-poetry-"));
    writeFileSync(
      join(root, "pyproject.toml"),
      `[project]\ndependencies = [\n  "markdown (>=3.8.2,<4.0.0)",\n]\n`,
    );
    writeFileSync(
      join(root, "poetry.lock"),
      `[[package]]\nname = "markdown"\nversion = "3.8.2"\ngroups = ["main"]\n\n[[package]]\nname = "transitive-package"\nversion = "1.2.3"\ngroups = ["main"]\n\n[[package]]\nname = "test-tool"\nversion = "4.5.6"\ngroups = ["test"]\n`,
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["pyproject.toml"],
        licenses: [
          { name: "markdown", version: "3.8.2", license: "BSD-3-Clause" },
          {
            name: "transitive-package",
            version: "1.2.3",
            license: "Apache-2.0",
          },
          { name: "test-tool", version: "4.5.6", license: "MIT" },
        ],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(
      report.results.map((result) => `${result.name}@${result.version}`),
    ).toEqual(["markdown@3.8.2", "transitive-package@1.2.3"]);
    expect(
      report.results.every((result) => result.resolution === "configured"),
    ).toBe(true);

    const developmentReport = await checkDependencies(
      root,
      {
        ...config,
        dependency: { ...config.dependency, includeDevDependencies: true },
      },
      undefined,
      false,
      new Logger("error"),
    );
    expect(
      developmentReport.results.map((result) => result.name).sort(),
    ).toEqual(["markdown", "test-tool", "transitive-package"]);
  });

  it("uses PyPI SPDX license expressions", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-pypi-"));
    writeFileSync(join(root, "requirements.txt"), "pep639-package==1.0.0\n");
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        info: { version: "1.0.0", license_expression: "MIT" },
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: { files: ["requirements.txt"] },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results[0]).toMatchObject({
      name: "pep639-package",
      version: "1.0.0",
      license: "MIT",
      normalized: "MIT",
      resolution: "registry",
      compatible: "compatible",
    });
  });

  it("uses a normalized PyPI classifier when legacy license metadata is prose", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "license-checker-pypi-classifier-"),
    );
    writeFileSync(
      join(root, "requirements.txt"),
      "legacy-classifier-package==1.0.0\n",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          info: {
            version: "1.0.0",
            license:
              "GNU LESSER GENERAL PUBLIC LICENSE Version 3, 29 June 2007 " +
              "The Library is a covered work. ".repeat(30),
            classifiers: [
              "License :: OSI Approved :: GNU Lesser General Public License v3 or later (LGPLv3+)",
            ],
          },
        }),
      }),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: { files: ["requirements.txt"] },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results[0]).toMatchObject({
      license: "LGPL-3.0-or-later",
      normalized: "LGPL-3.0-or-later",
      source: "pypi.org classifier",
      compatible: "compatible",
    });
  });

  it("falls back to linked GitHub repository licenses for Python packages", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-pypi-github-"));
    writeFileSync(
      join(root, "requirements.txt"),
      "repository-metadata==1.0.0\nrepository-text==1.0.0\n",
    );
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/repository-metadata/1.0.0/json"))
        return Promise.resolve({
          ok: true,
          json: async () => ({
            info: {
              project_urls: {
                Repository: "https://github.com/example/repository-metadata",
              },
            },
          }),
        });
      if (url.endsWith("/repository-text/1.0.0/json"))
        return Promise.resolve({
          ok: true,
          json: async () => ({
            info: {
              project_urls: {
                Source: "git+https://github.com/example/repository-text.git",
              },
            },
          }),
        });
      if (url.endsWith("/repos/example/repository-metadata/license"))
        return Promise.resolve({
          ok: true,
          json: async () => ({ license: { spdx_id: "BSD-3-Clause" } }),
        });
      if (url.endsWith("/repos/example/repository-text/license"))
        return Promise.resolve({
          ok: true,
          json: async () => ({
            license: { spdx_id: "NOASSERTION" },
            download_url: "https://raw.example/repository-text/LICENSE",
            html_url:
              "https://github.com/example/repository-text/blob/main/LICENSE",
          }),
        });
      if (url === "https://raw.example/repository-text/LICENSE")
        return Promise.resolve({
          ok: true,
          text: async () =>
            "Permission is hereby granted, free of charge, to any person obtaining a copy.",
        });
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetch);
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: { files: ["requirements.txt"] },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(
      report.results.map((result) => ({
        name: result.name,
        license: result.license,
        resolution: result.resolution,
      })),
    ).toEqual([
      {
        name: "repository-metadata",
        license: "BSD-3-Clause",
        resolution: "repository",
      },
      { name: "repository-text", license: "MIT", resolution: "repository" },
    ]);
  });

  it("uses Pyphen's documented tri-license instead of its first PyPI classifier", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-pyphen-"));
    writeFileSync(join(root, "requirements.txt"), "pyphen==0.17.2\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/pyphen/0.17.2/json"))
          return Promise.resolve({
            ok: true,
            json: async () => ({
              info: {
                project_urls: {
                  Repository: "https://github.com/Kozea/Pyphen",
                },
                classifiers: [
                  "License :: OSI Approved :: GNU General Public License v2 or later (GPLv2+)",
                  "License :: OSI Approved :: GNU Lesser General Public License v2 or later (LGPLv2+)",
                  "License :: OSI Approved :: Mozilla Public License 1.1 (MPL 1.1)",
                ],
              },
            }),
          });
        if (url.endsWith("/repos/Kozea/Pyphen/license"))
          return Promise.resolve({
            ok: true,
            json: async () => ({
              license: { spdx_id: "NOASSERTION" },
              download_url: "https://raw.example/Pyphen/LICENSE",
            }),
          });
        if (url === "https://raw.example/Pyphen/LICENSE")
          return Promise.resolve({
            ok: true,
            text: async () =>
              "Pyphen is released under the GPL 2.0+/LGPL 2.1+/MPL 1.1 tri-license.",
          });
        return Promise.resolve({ ok: false, json: async () => ({}) });
      }),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: { files: ["requirements.txt"] },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results[0]).toMatchObject({
      license: "(GPL-2.0-or-later OR LGPL-2.1-or-later OR MPL-1.1)",
      normalized: "(GPL-2.0-or-later OR (LGPL-2.1-or-later OR MPL-1.1))",
      resolution: "repository",
      compatible: "compatible",
    });
  });

  it("reports pyproject ranges unresolved instead of selecting a newer release", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-pypi-range-"));
    writeFileSync(
      join(root, "pyproject.toml"),
      `[project]\ndependencies = ["range-package (>=1.0.0,<2.0.0)"]\n`,
    );
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/range-package/1.5.0/json"))
        return Promise.resolve({
          ok: true,
          json: async () => ({
            info: { version: "1.5.0", license_expression: "MIT" },
          }),
        });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          info: { version: "2.0.0" },
          releases: {
            "1.4.0": [{}],
            "1.5.0": [{}],
            "1.9.0": [{ yanked: true }],
            "2.0.0": [{}],
          },
        }),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: { files: ["pyproject.toml"] },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results[0]).toMatchObject({
      name: "range-package",
      version: "(>=1.0.0,<2.0.0)",
      normalized: "Unknown",
      resolution: "unknown",
      compatible: "unknown",
      reason:
        "A supported Python lockfile or fully pinned requirements file is required.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("parses locked and unlocked npm, Python, and Go inputs", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-manifests-"));
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/string-license": { version: "1.0.0", license: "MIT" },
          "node_modules/object-license": {
            version: "2.0.0",
            license: { type: "Apache-2.0" },
          },
          "node_modules/array-license": {
            version: "3.0.0",
            licenses: [{ type: "BSD-3-Clause" }, {}],
          },
        },
        dependencies: {
          legacy: {
            version: "4.0.0",
            dependencies: { "legacy-child": { version: "5.0.0" } },
          },
        },
      }),
    );
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      "packages:\n  /pnpm-package@1.2.3: {}\n  /@scope/pnpm-package@2.3.4(peer@1.0.0): {}\nsnapshots:\n  /snapshot-package@3.4.5: {}\n",
    );
    writeFileSync(
      join(root, "go.sum"),
      "example.com/first v1.0.0 h1:checksum\nexample.com/second v2.0.0/go.mod h1:checksum\n",
    );
    writeFileSync(join(root, "go.mod"), "module example.com/app\n\ngo 1.23\n");
    writeFileSync(
      join(root, "requirements.txt"),
      '# comment\n-r constraints.txt\nrequests[security]>=2.0.0 ; python_version >= "3.10"\nsingle==1.0.0 # inline comment\n',
    );
    writeFileSync(
      join(root, "pyproject.toml"),
      '[project]\ndependencies = ["project-package >=1.0.0"]\n\n[tool.poetry.dependencies]\npython = "^3.11"\npoetry-package = "^2.0.0"\n',
    );
    writeFileSync(join(root, "poetry.lock"), "not valid = [");
    writeFileSync(
      join(root, "Pipfile.lock"),
      JSON.stringify({
        default: { pipfile: { version: "==1.0.0" } },
        develop: { development: { version: "==2.0.0" } },
      }),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: [
          "package-lock.json",
          "pnpm-lock.yaml",
          "go.mod",
          "go.sum",
          "requirements.txt",
          "pyproject.toml",
          "Pipfile.lock",
        ],
        includeDevDependencies: true,
        licenses: [{ name: "**", license: "Apache-2.0" }],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      goList("example.com/first v1.0.0", "example.com/second v2.0.0"),
    );

    expect(report.results).toHaveLength(18);
    expect(
      report.results.filter((result) => result.compatible === "unknown").length,
    ).toBeGreaterThan(0);
    expect(report.results.map((result) => result.name)).toEqual(
      expect.arrayContaining([
        "string-license",
        "legacy-child",
        "@scope/pnpm-package",
        "example.com/second",
        "requests",
        "poetry-package",
        "development",
      ]),
    );
  });

  it("marks package.json dependencies unresolved when no lockfile exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-package-json-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { production: "1.0.0" },
        devDependencies: { development: "2.0.0" },
        optionalDependencies: { optional: "3.0.0" },
        peerDependencies: { peer: "4.0.0" },
      }),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        licenses: [{ name: "*", license: "MIT" }],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results.map((result) => result.name)).toEqual([
      "production",
      "optional",
      "peer",
    ]);
    expect(report.failures).toHaveLength(3);
    expect(
      report.results.every(
        (result) =>
          result.normalized === "Unknown" &&
          result.reason === "A supported npm lockfile is required.",
      ),
    ).toBe(true);
  });

  it("includes JavaScript development dependencies when opted in", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "license-checker-package-json-dev-"),
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { development: "2.0.0" } }),
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        includeDevDependencies: true,
        licenses: [{ name: "development", license: "MIT" }],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results.map((result) => result.name)).toEqual([
      "development",
    ]);
  });

  it("reports the Go graph unresolved when go list cannot produce it", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-go-list-error-"));
    writeFileSync(join(root, "go.mod"), "module example.com/app\n\ngo 1.23\n");
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: { files: ["go.mod"] },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      () => {
        throw new Error("go executable missing");
      },
    );

    expect(report.failures).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "(Go package graph)",
      version: "unresolved",
      normalized: "Unknown",
      compatible: "unknown",
      reason: "Unable to resolve Go packages ./...: go executable missing",
    });
  });

  it("fails when Go returns no package data for configured targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-go-empty-graph-"));
    writeFileSync(join(root, "go.mod"), "module example.com/app\n\ngo 1.23\n");
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: { files: ["go.mod"], go: { packages: ["./cmd"] } },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
      () => "",
    );

    expect(report.failures).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "(Go package graph)",
      version: "unresolved",
      reason: "Go returned no package data for ./cmd.",
    });
  });

  it("does not treat go.sum as the Go dependency graph", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-go-sum-only-"));
    writeFileSync(
      join(root, "go.sum"),
      "example.com/module v1.2.3 h1:checksum\n",
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: { files: ["go.sum"] },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.failures).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "(Go module graph)",
      normalized: "Unknown",
      compatible: "unknown",
      reason:
        "go.sum contains checksums, not the selected module graph; configure the adjacent go.mod.",
    });
  });
});
