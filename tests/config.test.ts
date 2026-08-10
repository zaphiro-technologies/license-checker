import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("requires complete non-SPDX exception audit details", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  files:
    - package.json
  exceptions:
    - name: gsap
      version: 3.15.0
      url: https://gsap.com/community/standard-license/
`,
    );

    expect(() => loadConfig(root, ".licenserc.yaml")).toThrow(
      "dependency.exceptions[0] requires name, version, url, and reason.",
    );
  });

  it("loads a complete non-SPDX exception", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  files:
    - package.json
  exceptions:
    - name: gsap
      version: "3.15.0"
      url: https://gsap.com/community/standard-license/
      reason: Approved by legal
`,
    );

    expect(
      loadConfig(root, ".licenserc.yaml").config.dependency?.exceptions,
    ).toEqual([
      {
        name: "gsap",
        version: "3.15.0",
        url: "https://gsap.com/community/standard-license/",
        reason: "Approved by legal",
      },
    ]);
  });
});
