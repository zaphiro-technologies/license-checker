import { describe, expect, it } from "vitest";
import {
  checkCompatibility,
  normalizeLicenseExpression,
  normalizeLicenseId,
} from "../src/spdx.js";

describe("SPDX normalization", () => {
  it("normalizes common package-manager license names", () => {
    expect(normalizeLicenseId("MIT License")).toBe("MIT");
    expect(normalizeLicenseId("Apache License 2.0")).toBe("Apache-2.0");
    expect(normalizeLicenseId("ISC license")).toBe("ISC");
    expect(normalizeLicenseId("ISC License (ISCL)")).toBe("ISC");
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
      "MPL-1.1",
      "CC-BY-4.0",
      "CC0-1.0",
      "PSF-2.0",
      "CNRI-Python",
      "MIT-CMU",
    ]) {
      expect(checkCompatibility("Apache-2.0", license, false)).toBe(
        "compatible",
      );
    }
    expect(checkCompatibility("Apache-2.0", "GPL-3.0-only", false)).toBe(
      "incompatible",
    );
    expect(checkCompatibility("Apache-2.0", "CAL-1.0", false)).toBe(
      "incompatible",
    );
    expect(checkCompatibility("Apache-2.0", "BSD-4-Clause", false)).toBe(
      "unknown",
    );
    expect(checkCompatibility("Apache-2.0", "GPL-3.0-only OR MIT", false)).toBe(
      "compatible",
    );
  });

  it("follows the published compatibility matrix", () => {
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
      ["i", "c", "w", "i", "i", "i", "w", "w", "c"],
      ["i", "w", "c", "i", "i", "i", "w", "w", "c"],
      ["c", "i", "i", "c", "w", "w", "i", "i", "c"],
      ["c", "i", "i", "w", "c", "w", "i", "i", "c"],
      ["c", "i", "i", "w", "w", "c", "i", "i", "c"],
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
});
