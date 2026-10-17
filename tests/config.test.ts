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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { headerRules, loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("loads Go package targets and the development dependency flag", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  files: [go.mod]
  include-dev-dependencies: true
  go:
    packages: [./cmd]
`,
    );

    expect(loadConfig(root, ".licenserc.yaml").config.dependency?.go).toEqual({
      packages: ["./cmd"],
    });
    expect(
      loadConfig(root, ".licenserc.yaml").config.dependency
        ?.includeDevDependencies,
    ).toBe(true);
  });

  it("loads proprietary product intent", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  files: [package.json]
  project-license: proprietary
`,
    );

    expect(
      loadConfig(root, ".licenserc.yaml").config.dependency?.projectLicense,
    ).toBe("proprietary");
  });

  it("rejects the removed Go test-packages setting", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  files: [go.mod]
  go:
    test-packages: [./...]
`,
    );

    expect(() => loadConfig(root, ".licenserc.yaml")).toThrow(
      "dependency.go.test-packages is not supported",
    );
  });

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

  it("loads a license match regular expression", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  files: [package-lock.json]
  licenses:
    - name: acme-package
      match: 'Copyright \\(c\\) Acme.*All rights reserved'
      license: LicenseRef-Acme-Proprietary
`,
    );

    expect(
      loadConfig(root, ".licenserc.yaml").config.dependency?.licenses,
    ).toEqual([
      {
        name: "acme-package",
        match: "Copyright \\(c\\) Acme.*All rights reserved",
        license: "LicenseRef-Acme-Proprietary",
      },
    ]);
  });

  it("rejects an invalid license match regular expression", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  licenses:
    - name: acme-package
      match: '['
      license: LicenseRef-Acme-Proprietary
`,
    );

    expect(() => loadConfig(root, ".licenserc.yaml")).toThrow(
      "dependency.licenses[0].match must be a valid regular expression.",
    );
  });

  it("loads source-scoped license rules", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  license-rules:
    - source: license-text
      match: 'custom fingerprint'
      license: LicenseRef-Custom
    - source: python-classifier
      match: 'Acme Public License'
      license: LicenseRef-Acme
`,
    );

    expect(
      loadConfig(root, ".licenserc.yaml").config.dependency?.licenseRules,
    ).toEqual([
      {
        source: "license-text",
        match: "custom fingerprint",
        license: "LicenseRef-Custom",
      },
      {
        source: "python-classifier",
        match: "Acme Public License",
        license: "LicenseRef-Acme",
      },
    ]);
  });

  it("rejects unsupported license rule sources and invalid expressions", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  license-rules:
    - source: unknown
      match: '['
      license: MIT
`,
    );

    expect(() => loadConfig(root, ".licenserc.yaml")).toThrow(
      "dependency.license-rules[0] requires a supported source, match, and license.",
    );

    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  license-rules:
    - source: python-classifier
      match: '['
      license: MIT
`,
    );
    expect(() => loadConfig(root, ".licenserc.yaml")).toThrow(
      "dependency.license-rules[0].match must be a valid regular expression.",
    );
  });

  it("normalizes License Eye header and dependency configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    writeFileSync(
      join(root, ".licenserc.yaml"),
      `header:
  - path: packages/api
    license:
      spdx-id: Apache-2.0
      copyright-owner: Zaphiro Technologies
      copyright-year: 2026
      software-name: License Checker
      content: Copyright text
      pattern: Copyright\\s+2026
    paths: ["**/*.ts", 42]
    paths-ignore: ["dist", false]
    comment: on-failure
    license-location-threshold: 80
    language:
      TypeScript:
        extensions: [ts]
  - license:
      spdx-id: MIT
dependency:
  files: [package.json, 42]
  licenses:
    - name: example
      version: 1.2.3
      license: MIT
    - name: invalid
  threshold: 90
  excludes:
    - name: generated
      version: 1.0.0
      recursive: true
    - version: ignored
  exceptions:
    - name: approved
      version: 2.0.0
      url: http://example.com/terms
      reason: Approved by legal
  require_fsf_free: true
  require_osi_approved: true
`,
    );

    const config = loadConfig(root, ".licenserc.yaml").config;
    expect(headerRules(config)).toHaveLength(2);
    expect(headerRules(config)[0]).toMatchObject({
      path: "packages/api",
      license: {
        "spdx-id": "Apache-2.0",
        "copyright-year": 2026,
      },
      paths: ["**/*.ts"],
      "paths-ignore": ["dist"],
    });
    expect(config.dependency).toMatchObject({
      files: ["package.json"],
      licenses: [{ name: "example", version: "1.2.3", license: "MIT" }],
      threshold: 90,
      excludes: [{ name: "generated", version: "1.0.0", recursive: true }],
      require_fsf_free: true,
      require_osi_approved: true,
    });
  });

  it("rejects missing, empty, and malformed dependency configurations", () => {
    const root = mkdtempSync(join(tmpdir(), "license-checker-config-"));
    expect(() => loadConfig(root, ".licenserc.yaml")).toThrow(
      "Configuration file not found",
    );

    writeFileSync(join(root, ".licenserc.yaml"), "header: invalid\n");
    expect(() => loadConfig(root, ".licenserc.yaml")).toThrow(
      "Configuration contains neither a header nor dependency section",
    );

    writeFileSync(
      join(root, ".licenserc.yaml"),
      "dependency:\n  exceptions: invalid\n",
    );
    expect(() => loadConfig(root, ".licenserc.yaml")).toThrow(
      "dependency.exceptions must be a list.",
    );

    writeFileSync(
      join(root, ".licenserc.yaml"),
      `dependency:
  exceptions:
    - name: approved
      version: 1.0.0
      url: file:///private/terms
      reason: invalid protocol
`,
    );
    expect(() => loadConfig(root, ".licenserc.yaml")).toThrow(
      "dependency.exceptions[0].url must be an HTTP(S) URL.",
    );
  });
});
