import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDependencies } from "../src/dependencies.js";
import { Logger } from "../src/logger.js";
import type { LicenseEyeConfig } from "../src/types.js";

describe("dependency checker", () => {
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
      `__metadata:\n  version: 6\n\n"documentation@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "documentation@workspace:."\n\nfoo@npm:^1.0.0:\n  version: 1.2.3\n\n"@scope/bar@npm:^2.0.0":\n  version: 2.1.0\n`,
    );
    const config: LicenseEyeConfig = {
      header: { license: { "spdx-id": "Apache-2.0" } },
      dependency: {
        files: ["package.json"],
        licenses: [
          { name: "foo", license: "Apache-2.0" },
          { name: "@scope/bar", license: "Apache-2.0" },
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
    ).toEqual(["foo@1.2.3", "@scope/bar@2.1.0"]);
    expect(report.failures).toHaveLength(0);
  });
});
