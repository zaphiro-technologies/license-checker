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

import { describe, expect, it } from "vitest";
import {
  checkCompatibility,
  checkProprietaryCompatibility,
  distributionWarningFor,
  licenseCompatAdviceUrl,
  normalizeLicenseExpression,
  normalizeLicenseId,
} from "../src/spdx.js";

describe("SPDX normalization", () => {
  it("normalizes common package-manager license names", () => {
    expect(normalizeLicenseId("MIT License")).toBe("MIT");
    expect(normalizeLicenseId("Apache License 2.0")).toBe("Apache-2.0");
    expect(normalizeLicenseId("ISC license")).toBe("ISC");
    expect(normalizeLicenseId("ISC License (ISCL)")).toBe("ISC");
    expect(normalizeLicenseId("LicenseRef-Acme-Proprietary")).toBe(
      "LicenseRef-Acme-Proprietary",
    );
    for (const license of ["PSF-2.0", "CAL-1.0", "CNRI-Python", "MIT-CMU"])
      expect(normalizeLicenseId(license)).toBe(license);
    expect(normalizeLicenseExpression("MIT OR Apache-2.0")).toBe(
      "(MIT OR Apache-2.0)",
    );
    expect(
      normalizeLicenseExpression("GPL-2.0-only WITH Classpath-exception-2.0"),
    ).toBe("GPL-2.0-only WITH Classpath-exception-2.0");
  });

  it("evaluates supported compatibility categories", () => {
    expect(checkCompatibility("Apache-2.0", "MIT", false)).toBe("compatible");
    expect(checkCompatibility("Apache-2.0", "MPL-2.0", false)).toBe(
      "compatible",
    );
    for (const license of [
      "BlueOak-1.0.0",
      "CC0-1.0",
      "PSF-2.0",
      "CNRI-Python",
      "MIT-CMU",
    ]) {
      expect(checkCompatibility("Apache-2.0", license, false)).toBe(
        "compatible",
      );
    }
    expect(checkCompatibility("Apache-2.0", "MPL-1.1", false)).toBe("unknown");
    expect(checkCompatibility("Apache-2.0", "GPL-3.0-only", false)).toBe(
      "incompatible",
    );
    expect(checkCompatibility("Apache-2.0", "CAL-1.0", false)).toBe("unknown");
    expect(checkCompatibility("Apache-2.0", "BSD-4-Clause", false)).toBe(
      "unknown",
    );
    expect(checkCompatibility("BSD-4-Clause", "BSD-4-Clause", false)).toBe(
      "unknown",
    );
    for (const license of ["CC-BY-3.0", "CC-BY-4.0"]) {
      expect(checkCompatibility("Apache-2.0", license, false)).toBe("unknown");
      expect(checkCompatibility("MPL-2.0", license, false)).toBe("unknown");
      expect(checkCompatibility("Apache-2.0", license, true)).toBe("unknown");
      expect(checkCompatibility(license, "MIT", false)).toBe("unknown");
    }
    expect(checkCompatibility("Apache-2.0", "GPL-3.0-only OR MIT", false)).toBe(
      "compatible",
    );
    expect(distributionWarningFor("MIT")).toBeUndefined();
    expect(distributionWarningFor("LGPL-3.0-or-later")).toContain("LGPL");
    expect(distributionWarningFor("GPL-3.0-only OR MIT")).toContain("GPL");
  });

  it("follows the configured compatibility matrix", () => {
    const licenses = [
      "MIT",
      "GPL-3.0-only",
      "GPL-2.0-only",
      "LGPL-3.0-only",
      "LGPL-2.1-only",
      "MPL-2.0",
      "AGPL-3.0-only",
      "CC0-1.0",
      "Unlicense",
    ];
    const matrix = [
      ["c", "i", "i", "c", "c", "c", "i", "c", "c"],
      ["i", "c", "w", "c", "c", "w", "w", "w", "c"],
      ["i", "w", "c", "i", "c", "w", "w", "w", "c"],
      ["c", "i", "i", "c", "w", "w", "i", "i", "c"],
      ["c", "i", "i", "w", "c", "w", "i", "i", "c"],
      ["c", "w", "w", "w", "w", "c", "i", "i", "c"],
      ["i", "w", "w", "i", "i", "i", "i", "c", "c"],
      ["c", "c", "c", "c", "c", "c", "c", "c", "c"],
      ["c", "c", "c", "c", "c", "c", "c", "c", "c"],
    ];

    for (const [rowIndex, main] of licenses.entries()) {
      for (const [columnIndex, dependency] of licenses.entries()) {
        const expected = matrix[rowIndex][columnIndex];
        expect(checkCompatibility(main, dependency, false)).toBe(
          expected === "c"
            ? "compatible"
            : expected === "i"
              ? "incompatible"
              : "unknown",
        );
      }
    }

    expect(checkCompatibility("GPL-3.0-only", "GPL-2.0-only", true)).toBe(
      "weak-compatible",
    );
  });

  it("keeps pair compatibility separate from distribution models", () => {
    expect(checkCompatibility("MIT", "MPL-2.0", false)).toBe("compatible");
  });

  it("checks proprietary use by licensecompat distribution model", () => {
    expect(
      checkProprietaryCompatibility(
        "AGPL-3.0-only",
        "public-saas",
      ),
    ).toBe("unknown");
    expect(
      checkProprietaryCompatibility("GPL-3.0-only", "public-saas"),
    ).toBe("compatible");
    expect(
      checkProprietaryCompatibility("GPL-3.0-only", "proprietary-binary"),
    ).toBe("incompatible");
    expect(
      checkProprietaryCompatibility("LGPL-3.0-or-later", "dynamic-linking"),
    ).toBe("unknown");
    expect(
      checkProprietaryCompatibility("BSD-4-Clause", "public-saas"),
    ).toBe("unknown");
    expect(
      checkProprietaryCompatibility("CC-BY-4.0", "public-saas"),
    ).toBe("unknown");
  });

  it("links licenses and distribution model to licensecompat", () => {
    expect(licenseCompatAdviceUrl("MIT", "MPL-2.0", "dynamic-linking")).toBe(
      "https://licensecompat.com/?licenses=MIT%2CMPL-2.0&model=dynamic_linking",
    );
    expect(licenseCompatAdviceUrl(undefined, "BSD-4-Clause")).toBe(
      "https://licensecompat.com/?licenses=BSD-4-Clause&model=saas_public",
    );
  });

  it.each([
    ["internal-use", "internal_only"],
    ["proprietary-binary", "proprietary_binary"],
    ["public-saas", "saas_public"],
    ["open-source-redistribution", "open_source_redistribution"],
    ["static-linking", "static_linking"],
    ["dynamic-linking", "dynamic_linking"],
  ] as const)("maps %s to licensecompat model %s", (distribution, model) => {
    expect(licenseCompatAdviceUrl(undefined, "MIT", distribution)).toBe(
      `https://licensecompat.com/?licenses=MIT&model=${model}`,
    );
  });
});
