import * as core from '@actions/core';
import { loadConfig } from './config.js';
import { checkDependencies } from './dependencies.js';
import { checkHeaders } from './header.js';
import { Logger } from './logger.js';
import { annotate, commentOnPullRequest, writeSummary } from './report.js';
import { headerRules } from './config.js';
import type { CheckReport, LicenseEyeConfig } from './types.js';

function commentsEnabled(config: LicenseEyeConfig): boolean {
  const rules = headerRules(config);
  return rules.length === 0 || rules.some((rule) => rule.comment !== 'never');
}

async function run(): Promise<void> {
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const logger = new Logger(core.getInput('log') || 'info');
  const configInput = core.getInput('config') || '.licenserc.yaml';
  const token = core.getInput('token') || undefined;
  const weakCompatible = core.getBooleanInput('weak-compatible', { required: false });

  logger.info(`Loading configuration from ${configInput}`);
  const { config } = loadConfig(root, configInput);
  const header = checkHeaders(root, config, logger);
  const dependency = await checkDependencies(root, config, token, weakCompatible, logger);
  const report: CheckReport = {
    header,
    dependency,
    failed: header.failures.length > 0 || dependency.failures.length > 0,
  };

  annotate(report);
  await writeSummary(report);
  if (report.failed && commentsEnabled(config)) await commentOnPullRequest(token, report);

  logger.info(`Checked ${header.checked} headers and ${dependency.checked} dependencies.`);
  if (report.failed) {
    throw new Error(`License check failed: ${header.failures.length} header failure(s), ${dependency.failures.length} dependency failure(s).`);
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
