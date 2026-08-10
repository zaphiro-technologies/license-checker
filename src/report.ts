import * as core from "@actions/core";
import * as github from "@actions/github";
import type { CheckReport, DependencyResult } from "./types.js";

const COMMENT_MARKER = "<!-- license-checker-action -->";

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function approvalDetails(result: DependencyResult): string {
  if (!result.approval) return "";
  return `${escapeTableCell(result.approval.reason)} ([terms](${result.approval.url}))`;
}

function dependencyRows(results: DependencyResult[]): string[][] {
  return results.map((result) => [
    result.name,
    result.version,
    result.normalized,
    result.compatible,
    result.resolution,
    approvalDetails(result),
    result.distributionWarning ?? "",
  ]);
}

export function distributionWarnings(report: CheckReport): DependencyResult[] {
  return report.dependency.results.filter(
    (result) => result.distributionWarning,
  );
}

export function summaryDependencies(
  report: CheckReport,
  reportAll: boolean,
): DependencyResult[] {
  return reportAll
    ? report.dependency.results
    : report.dependency.results.filter(
        (result) =>
          report.dependency.failures.includes(result) ||
          result.distributionWarning,
      );
}

function commentBody(report: CheckReport): string {
  const lines = [COMMENT_MARKER, "## License Checker", ""];
  if (report.dependency.failures.length > 0) {
    lines.push(
      "### Dependency license failures",
      "",
      "| Dependency | Version | License | Result |",
      "|---|---:|---|---|",
    );
    for (const result of report.dependency.failures.slice(0, 100)) {
      lines.push(
        `| ${result.name} | ${result.version} | ${result.normalized} | ${result.compatible} |`,
      );
    }
    lines.push("");
  }
  const warnings = distributionWarnings(report);
  if (warnings.length > 0) {
    lines.push(
      "### Distribution review warnings",
      "",
      "| Dependency | Version | License | Review required |",
      "|---|---:|---|---|",
    );
    for (const result of warnings.slice(0, 100)) {
      lines.push(
        `| ${result.name} | ${result.version} | ${result.normalized} | ${escapeTableCell(result.distributionWarning ?? "")} |`,
      );
    }
    lines.push("");
  }
  const approvals = report.dependency.results.filter(
    (result) => result.compatible === "approved-exception" && result.approval,
  );
  if (approvals.length > 0) {
    lines.push(
      "### Manual license approvals",
      "",
      "| Dependency | Version | Terms | Reason |",
      "|---|---:|---|---|",
    );
    for (const result of approvals) {
      lines.push(
        `| ${result.name} | ${result.version} | [terms](${result.approval?.url}) | ${escapeTableCell(result.approval?.reason ?? "")} |`,
      );
    }
    lines.push("");
  }
  lines.push(`Checked ${report.dependency.checked} dependencies.`);
  return lines.join("\n");
}

export async function writeSummary(
  report: CheckReport,
  reportAll = false,
): Promise<void> {
  const approvals = report.dependency.results.filter(
    (result) => result.compatible === "approved-exception",
  );
  const warnings = distributionWarnings(report);
  const dependencyRowsForSummary =
    report.dependency.failures.length === 0
      ? warnings.length === 0
        ? [
            [
              "Dependencies",
              "pass",
              `${report.dependency.checked} checked; ${approvals.length} manual approval(s)`,
            ],
          ]
        : [
            [
              "Dependencies",
              "warning",
              `${report.dependency.checked} checked; ${warnings.length} distribution review warning(s)`,
            ],
          ]
      : [
          [
            "Dependencies",
            "fail",
            `${report.dependency.failures.length} failure(s); ${warnings.length} distribution review warning(s)`,
          ],
        ];

  core.summary.addHeading("License Checker").addTable([
    [
      { data: "Area", header: true },
      { data: "Result", header: true },
      { data: "Details", header: true },
    ],
    ...dependencyRowsForSummary,
  ]);

  const displayedDependencies = summaryDependencies(report, reportAll);
  if (displayedDependencies.length > 0) {
    core.summary
      .addHeading(
        reportAll ? "Dependency licenses" : "Dependency license issues",
        3,
      )
      .addTable([
        [
          { data: "Dependency", header: true },
          { data: "Version", header: true },
          { data: "License", header: true },
          { data: "Compatibility", header: true },
          { data: "Resolution", header: true },
          { data: "Manual approval", header: true },
          { data: "Distribution review", header: true },
        ],
        ...dependencyRows(displayedDependencies),
      ]);
  }
  if (!reportAll && approvals.length > 0) {
    core.summary.addHeading("Manual license approvals", 3).addTable([
      [
        { data: "Dependency", header: true },
        { data: "Version", header: true },
        { data: "License", header: true },
        { data: "Compatibility", header: true },
        { data: "Resolution", header: true },
        { data: "Manual approval", header: true },
        { data: "Distribution review", header: true },
      ],
      ...dependencyRows(approvals),
    ]);
  }
  if (process.env.GITHUB_STEP_SUMMARY) await core.summary.write();
}

export function annotate(report: CheckReport): void {
  for (const result of report.dependency.failures) {
    core.error(
      `${result.name}@${result.version}: ${result.normalized} (${result.compatible})`,
      {
        file: result.manifest,
        startLine: 1,
      },
    );
  }
  for (const result of distributionWarnings(report)) {
    core.warning(
      `${result.name}@${result.version}: ${result.distributionWarning}`,
      {
        file: result.manifest,
        startLine: 1,
      },
    );
  }
}

export async function commentOnPullRequest(
  token: string | undefined,
  report: CheckReport,
): Promise<void> {
  if (!token || !github.context.payload.pull_request) return;
  const { owner, repo } = github.context.repo;
  const octokit = github.getOctokit(token);
  const body = commentBody(report);
  try {
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: github.context.issue.number,
      per_page: 100,
    });
    const existing = comments.data.find((comment) =>
      comment.body?.includes(COMMENT_MARKER),
    );
    if (existing) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: github.context.issue.number,
        body,
      });
    }
  } catch (error) {
    core.warning(
      `Unable to update the pull-request license comment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
