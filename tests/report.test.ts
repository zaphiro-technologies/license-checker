import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckReport, DependencyResult } from "../src/types.js";

const actionMocks = vi.hoisted(() => {
  const summary = {
    addHeading: vi.fn(),
    addTable: vi.fn(),
    write: vi.fn(),
  };
  summary.addHeading.mockReturnValue(summary);
  summary.addTable.mockReturnValue(summary);
  return { error: vi.fn(), summary, warning: vi.fn() };
});

const githubMocks = vi.hoisted(() => ({
  context: {
    issue: { number: 42 },
    payload: {} as { pull_request?: unknown },
    repo: { owner: "zaphiro-technologies", repo: "license-checker" },
  },
  getOctokit: vi.fn(),
}));

vi.mock("@actions/core", () => actionMocks);
vi.mock("@actions/github", () => githubMocks);

import {
  annotate,
  commentOnPullRequest,
  distributionWarnings,
  summaryDependencies,
  writeSummary,
} from "../src/report.js";

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

function report(): CheckReport {
  const failure = dependency("unknown-license", "unknown");
  const warning = {
    ...dependency("lgpl-license", "compatible"),
    distributionWarning: "Include LGPL notices | review distribution.",
  };
  const approval = {
    ...dependency("commercial-license", "approved-exception"),
    approval: {
      reason: "Approved | by legal\nfor this version.",
      url: "https://example.com/terms",
    },
  };
  return {
    dependency: {
      checked: 4,
      results: [
        dependency("compatible-license", "compatible"),
        approval,
        warning,
        failure,
      ],
      failures: [failure],
    },
    failed: true,
  };
}

describe("summary reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubMocks.context.payload.pull_request = { number: 42 };
  });

  afterEach(() => {
    delete process.env.GITHUB_STEP_SUMMARY;
  });

  it("shows only dependency issues by default", () => {
    const value = report();

    expect(
      summaryDependencies(value, false).map((result) => result.name),
    ).toEqual(["lgpl-license", "unknown-license"]);
    expect(summaryDependencies(value, true)).toEqual(value.dependency.results);
    expect(distributionWarnings(value).map((result) => result.name)).toEqual([
      "lgpl-license",
    ]);
  });

  it("writes issue-focused and complete GitHub summaries", async () => {
    process.env.GITHUB_STEP_SUMMARY = "/tmp/license-checker-summary";
    const value = report();

    await writeSummary(value);

    expect(actionMocks.summary.addHeading).toHaveBeenCalledWith(
      "License Checker",
    );
    expect(actionMocks.summary.addHeading).toHaveBeenCalledWith(
      "Dependency license issues",
      3,
    );
    expect(actionMocks.summary.addHeading).toHaveBeenCalledWith(
      "Manual license approvals",
      3,
    );
    expect(actionMocks.summary.addTable).toHaveBeenCalledTimes(3);
    expect(actionMocks.summary.write).toHaveBeenCalledOnce();

    await writeSummary(value, true);
    expect(actionMocks.summary.addHeading).toHaveBeenCalledWith(
      "Dependency licenses",
      3,
    );
  });

  it("reports passing and warning-only dependency summaries", async () => {
    const passing: CheckReport = {
      dependency: {
        checked: 1,
        results: [dependency("mit", "compatible")],
        failures: [],
      },
      failed: false,
    };
    await writeSummary(passing);
    expect(actionMocks.summary.addTable).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.arrayContaining(["Dependencies", "pass", expect.any(String)]),
      ]),
    );

    vi.clearAllMocks();
    const warningOnly: CheckReport = {
      ...passing,
      dependency: {
        ...passing.dependency,
        results: [
          {
            ...dependency("mpl", "compatible"),
            distributionWarning: "Review MPL distribution obligations.",
          },
        ],
      },
    };
    await writeSummary(warningOnly);
    expect(actionMocks.summary.addTable).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.arrayContaining(["Dependencies", "warning", expect.any(String)]),
      ]),
    );
  });

  it("emits failure and distribution annotations", () => {
    annotate(report());

    expect(actionMocks.error).toHaveBeenCalledWith(
      "unknown-license@1.0.0: MIT (unknown)",
      { file: "package.json", startLine: 1 },
    );
    expect(actionMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining("lgpl-license@1.0.0"),
      { file: "package.json", startLine: 1 },
    );
  });

  it("creates, updates, and safely handles pull-request comments", async () => {
    const issues = {
      createComment: vi.fn().mockResolvedValue({}),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
      updateComment: vi.fn().mockResolvedValue({}),
    };
    githubMocks.getOctokit.mockReturnValue({ rest: { issues } });

    await commentOnPullRequest("token", report());
    expect(issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        owner: "zaphiro-technologies",
      }),
    );
    expect(issues.createComment.mock.calls[0]?.[0].body).toContain(
      "Manual license approvals",
    );

    issues.listComments.mockResolvedValueOnce({
      data: [{ body: "<!-- license-checker-action -->", id: 99 }],
    });
    await commentOnPullRequest("token", report());
    expect(issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 99 }),
    );

    githubMocks.context.payload.pull_request = undefined;
    await commentOnPullRequest("token", report());
    await commentOnPullRequest(undefined, report());
    expect(githubMocks.getOctokit).toHaveBeenCalledTimes(2);

    githubMocks.context.payload.pull_request = { number: 42 };
    issues.listComments.mockRejectedValueOnce(new Error("network unavailable"));
    await commentOnPullRequest("token", report());
    expect(actionMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining("network unavailable"),
    );
  });
});
