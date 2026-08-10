import { describe, expect, it } from "vitest";
import { summaryDependencies } from "../src/report.js";
import type { CheckReport, DependencyResult } from "../src/types.js";

function dependency(
  name: string,
  compatible: DependencyResult["compatible"],
): DependencyResult {
  return {
    name,
    version: "1.0.0",
    ecosystem: "npm",
    manifest: "package.json",
    license: "MIT",
    normalized: "MIT",
    resolution: "registry",
    compatible,
  };
}

describe("summary reporting", () => {
  it("shows only dependency issues by default", () => {
    const failure = dependency("unknown-license", "unknown");
    const warning = {
      ...dependency("lgpl-license", "compatible"),
      distributionWarning: "Distribution review is required.",
    };
    const report: CheckReport = {
      dependency: {
        checked: 3,
        results: [
          dependency("compatible-license", "compatible"),
          dependency("manual-approval", "approved-exception"),
          warning,
          failure,
        ],
        failures: [failure],
      },
      failed: true,
    };

    expect(summaryDependencies(report, false)).toEqual([warning, failure]);
    expect(summaryDependencies(report, true)).toEqual(
      report.dependency.results,
    );
  });
});
