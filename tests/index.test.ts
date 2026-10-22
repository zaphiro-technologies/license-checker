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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckReport, DependencyResult } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  annotate: vi.fn(),
  checkDependencies: vi.fn(),
  commentOnPullRequest: vi.fn(),
  core: {
    getInput: vi.fn(),
    setFailed: vi.fn(),
  },
  distributionWarnings: vi.fn(),
  headerRules: vi.fn(),
  loadConfig: vi.fn(),
  Logger: vi.fn(),
  writeSummary: vi.fn(),
}));

vi.mock("@actions/core", () => mocks.core);
vi.mock("../src/config.js", () => ({
  headerRules: mocks.headerRules,
  loadConfig: mocks.loadConfig,
}));
vi.mock("../src/dependencies.js", () => ({
  checkDependencies: mocks.checkDependencies,
}));
vi.mock("../src/logger.js", () => ({ Logger: mocks.Logger }));
vi.mock("../src/report.js", () => ({
  annotate: mocks.annotate,
  commentOnPullRequest: mocks.commentOnPullRequest,
  distributionWarnings: mocks.distributionWarnings,
  writeSummary: mocks.writeSummary,
}));

const originalArgv = [...process.argv];

function dependency(name: string): DependencyResult {
  return {
    name,
    version: "1.0.0",
    ecosystem: "npm",
    manifest: "package-lock.json",
    license: "MIT",
    normalized: "MIT",
    resolution: "registry",
    compatible: "compatible",
  };
}

function report(
  results: DependencyResult[],
  failures: DependencyResult[],
): CheckReport {
  return {
    dependency: { checked: results.length, results, failures },
    failed: failures.length > 0,
  };
}

describe("action entry point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.argv = [...originalArgv];
    process.env.GITHUB_WORKSPACE = "/workspace";
    mocks.core.getInput.mockReturnValue("");
    mocks.headerRules.mockReturnValue([]);
    mocks.distributionWarnings.mockReturnValue([]);
    mocks.writeSummary.mockResolvedValue(undefined);
    mocks.commentOnPullRequest.mockResolvedValue(undefined);
    mocks.Logger.mockImplementation(function loggerMock() {
      return { info: vi.fn() };
    });
    mocks.loadConfig.mockReturnValue({ config: {} });
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    delete process.env.GITHUB_WORKSPACE;
  });

  it("reads CLI options, writes the report, and comments for distribution warnings", async () => {
    process.argv.push(
      "--log",
      "debug",
      "--config",
      "custom.yaml",
      "--token",
      "token-value",
      "--weak-compatible",
      "true",
      "--report-all",
      "true",
      "--distribution",
      "proprietary-binary",
    );
    const warning = dependency("reciprocal-package");
    const value = report([warning], []);
    mocks.checkDependencies.mockResolvedValue(value.dependency);
    mocks.distributionWarnings.mockReturnValue([warning]);

    await import("../src/index.js");

    expect(mocks.loadConfig).toHaveBeenCalledWith("/workspace", "custom.yaml");
    expect(mocks.checkDependencies).toHaveBeenCalledWith(
      "/workspace",
      {},
      "token-value",
      true,
      expect.any(Object),
      undefined,
      "proprietary-binary",
    );
    expect(mocks.writeSummary).toHaveBeenCalledWith(value, "all");
    expect(mocks.commentOnPullRequest).toHaveBeenCalledWith(
      "token-value",
      value,
    );
  });

  it("uses action inputs and reports license failures", async () => {
    const failure = {
      ...dependency("unknown-package"),
      compatible: "unknown" as const,
    };
    const value = report([failure], [failure]);
    mocks.checkDependencies.mockResolvedValue(value.dependency);
    mocks.core.getInput.mockImplementation((name: string) => {
      if (name === "config") return "action.yaml";
      if (name === "token") return "action-token";
      return "";
    });

    await import("../src/index.js");

    expect(mocks.loadConfig).toHaveBeenCalledWith("/workspace", "action.yaml");
    expect(mocks.writeSummary).toHaveBeenCalledWith(value, "issues");
    expect(mocks.commentOnPullRequest).toHaveBeenCalledWith(
      "action-token",
      value,
    );
    expect(mocks.core.setFailed).toHaveBeenCalledWith(
      "License check failed: 1 dependency failure(s).",
    );
  });

  it("uses the configured distribution when no input overrides it", async () => {
    mocks.loadConfig.mockReturnValue({
      config: { dependency: { distribution: "open-source-redistribution" } },
    });
    mocks.checkDependencies.mockResolvedValue(report([], []).dependency);

    await import("../src/index.js");

    expect(mocks.checkDependencies).toHaveBeenCalledWith(
      "/workspace",
      { dependency: { distribution: "open-source-redistribution" } },
      undefined,
      false,
      expect.any(Object),
      undefined,
      "open-source-redistribution",
    );
  });

  it("skips comments when disabled in the header configuration", async () => {
    const warning = dependency("reciprocal-package");
    const value = report([warning], []);
    mocks.checkDependencies.mockResolvedValue(value.dependency);
    mocks.distributionWarnings.mockReturnValue([warning]);
    mocks.headerRules.mockReturnValue([{ comment: "never" }]);

    await import("../src/index.js");

    expect(mocks.commentOnPullRequest).not.toHaveBeenCalled();
    expect(mocks.core.setFailed).not.toHaveBeenCalled();
  });
});
