import * as core from '@actions/core';
import * as github from '@actions/github';
import type { CheckReport, DependencyResult, HeaderFailure } from './types.js';

const COMMENT_MARKER = '<!-- license-checker-action -->';

function dependencyRows(results: DependencyResult[]): string[][] {
  return results.map((result) => [
    result.name,
    result.version,
    result.normalized,
    result.compatible,
    result.resolution,
  ]);
}

function commentBody(report: CheckReport): string {
  const lines = [COMMENT_MARKER, '## License Checker', ''];
  if (report.header.failures.length > 0) {
    lines.push('### Header failures', '');
    for (const failure of report.header.failures.slice(0, 100)) {
      lines.push(`- \`${failure.file}\`: ${failure.reason} (expected \`${failure.expected}\`)`);
    }
    lines.push('');
  }
  if (report.dependency.failures.length > 0) {
    lines.push('### Dependency license failures', '', '| Dependency | Version | License | Result |', '|---|---:|---|---|');
    for (const result of report.dependency.failures.slice(0, 100)) {
      lines.push(`| ${result.name} | ${result.version} | ${result.normalized} | ${result.compatible} |`);
    }
    lines.push('');
  }
  lines.push(`Checked ${report.header.checked} source files and ${report.dependency.checked} dependencies.`);
  return lines.join('\n');
}

export async function writeSummary(report: CheckReport): Promise<void> {
  const headerRows = report.header.failures.length === 0
    ? [['Headers', 'pass', String(report.header.checked)]]
    : [['Headers', 'fail', `${report.header.failures.length} failure(s)`]];
  const dependencyRowsForSummary = report.dependency.failures.length === 0
    ? [['Dependencies', 'pass', String(report.dependency.checked)]]
    : [['Dependencies', 'fail', `${report.dependency.failures.length} failure(s)`]];

  core.summary
    .addHeading('License Checker')
    .addTable([
      [{ data: 'Area', header: true }, { data: 'Result', header: true }, { data: 'Details', header: true }],
      ...[...headerRows, ...dependencyRowsForSummary],
    ]);

  if (report.header.failures.length > 0) {
    core.summary.addHeading('Header failures', 3).addTable([
      [
        { data: 'File', header: true },
        { data: 'Reason', header: true },
      ],
      ...report.header.failures.map((failure) => [failure.file, failure.reason]),
    ]);
  }

  if (report.dependency.results.length > 0) {
    core.summary.addHeading('Dependency licenses', 3).addTable([
      [
        { data: 'Dependency', header: true },
        { data: 'Version', header: true },
        { data: 'License', header: true },
        { data: 'Compatibility', header: true },
        { data: 'Resolution', header: true },
      ],
      ...dependencyRows(report.dependency.results),
    ]);
  }
  await core.summary.write();
}

export function annotate(report: CheckReport): void {
  for (const failure of report.header.failures) {
    core.error(`${failure.reason}: ${failure.expected}`, { file: failure.file, startLine: 1 });
  }
  for (const result of report.dependency.failures) {
    core.error(`${result.name}@${result.version}: ${result.normalized} (${result.compatible})`, {
      file: result.manifest,
      startLine: 1,
    });
  }
}

export async function commentOnPullRequest(token: string | undefined, report: CheckReport): Promise<void> {
  if (!token || !github.context.payload.pull_request) return;
  const { owner, repo } = github.context.repo;
  const octokit = github.getOctokit(token);
  const body = commentBody(report);
  try {
    const comments = await octokit.rest.issues.listComments({ owner, repo, issue_number: github.context.issue.number, per_page: 100 });
    const existing = comments.data.find((comment) => comment.body?.includes(COMMENT_MARKER));
    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: github.context.issue.number, body });
    }
  } catch (error) {
    core.warning(`Unable to update the pull-request license comment: ${error instanceof Error ? error.message : String(error)}`);
  }
}
