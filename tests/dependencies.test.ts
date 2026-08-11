import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDependencies } from "../src/dependencies.js";
import { Logger } from "../src/logger.js";
import type { LicenseEyeConfig } from "../src/types.js";

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
    );
    expect(report.checked).toBe(1);
    expect(report.failures).toHaveLength(0);
    expect(report.results[0]?.resolution).toBe("configured");
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
    );

    expect(report.results[0]).toMatchObject({
      name: "example.com/non-github",
      license: "Apache-2.0",
      source: "vendor/example.com/non-github/LICENCE",
      resolution: "manifest",
      compatible: "compatible",
    });
  });

  it("reports non-blocking distribution review warnings", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-distribution-"));
    writeFileSync(
      join(root, "go.mod"),
      "module example.com/app\n\nrequire example.com/reciprocal v1.2.3\n",
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["go.mod"],
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
    );

    expect(report.failures).toHaveLength(0);
    expect(report.results[0]).toMatchObject({
      compatible: "compatible",
      distributionWarning: expect.stringContaining("LGPL"),
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
    writeFileSync(join(root, "package.json"), "{}\n");
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
      report.results.map((result) => `${result.name}@${result.version}`),
    ).toEqual([
      "foo@1.2.3",
      "@scope/bar@2.1.0",
      "@docusaurus/react-loadable@6.0.0",
    ]);
    expect(report.failures).toHaveLength(0);
  });

  it("prefers the adjacent Poetry lockfile's exact package versions", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-poetry-"));
    writeFileSync(
      join(root, "pyproject.toml"),
      `[project]\ndependencies = [\n  "markdown (>=3.8.2,<4.0.0)",\n]\n`,
    );
    writeFileSync(
      join(root, "poetry.lock"),
      `[[package]]\nname = "markdown"\nversion = "3.8.2"\n\n[[package]]\nname = "transitive-package"\nversion = "1.2.3"\n`,
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

  it("selects the latest non-yanked PyPI release within a pyproject constraint", async () => {
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
      version: "1.5.0",
      normalized: "MIT",
      compatible: "compatible",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://pypi.org/pypi/range-package/1.5.0/json",
      expect.any(Object),
    );
  });

  it("parses npm, pnpm, Go, Pipfile, requirements, and unlocked Poetry manifests", async () => {
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
          "go.sum",
          "requirements.txt",
          "pyproject.toml",
          "Pipfile.lock",
        ],
        licenses: [{ name: "**", license: "Apache-2.0" }],
      },
    };

    const report = await checkDependencies(
      root,
      config,
      undefined,
      false,
      new Logger("error"),
    );

    expect(report.results).toHaveLength(16);
    expect(
      report.results.every((result) => result.resolution === "configured"),
    ).toBe(true);
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

  it("uses all package.json dependency sections when no lockfile exists", async () => {
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
      "development",
      "optional",
      "peer",
    ]);
  });
});
