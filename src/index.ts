import * as core from "@actions/core";
import { loadConfig } from "./config.js";
import { checkDependencies } from "./dependencies.js";
import { Logger } from "./logger.js";
import {
  annotate,
  commentOnPullRequest,
  distributionWarnings,
  writeSummary,
} from "./report.js";
import { headerRules } from "./config.js";
import type { CheckReport, LicenseEyeConfig } from "./types.js";

function commentsEnabled(config: LicenseEyeConfig): boolean {
  const rules = headerRules(config);
  return rules.length === 0 || rules.some((rule) => rule.comment !== "never");
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function run(): Promise<void> {
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const logger = new Logger(
    core.getInput("log") || argumentValue("--log") || "info",
  );
  const configInput =
    core.getInput("config") || argumentValue("--config") || ".licenserc.yaml";
  const token = core.getInput("token") || argumentValue("--token") || undefined;
  const weakCompatibleInput =
    core.getInput("weak-compatible") ||
    argumentValue("--weak-compatible") ||
    "false";
  const weakCompatible = weakCompatibleInput.toLowerCase() === "true";
  const reportAllInput =
    core.getInput("report-all") || argumentValue("--report-all") || "false";
  const reportAll = reportAllInput.toLowerCase() === "true";

  logger.info(`Loading configuration from ${configInput}`);
  const { config } = loadConfig(root, configInput);
  const dependency = await checkDependencies(
    root,
    config,
    token,
    weakCompatible,
    logger,
  );
  const report: CheckReport = {
    dependency,
    failed: dependency.failures.length > 0,
  };

  annotate(report);
  await writeSummary(report, reportAll);
  if (
    (report.failed || distributionWarnings(report).length > 0) &&
    commentsEnabled(config)
  )
    await commentOnPullRequest(token, report);

  logger.info(`Checked ${dependency.checked} dependencies.`);
  if (report.failed) {
    throw new Error(
      `License check failed: ${dependency.failures.length} dependency failure(s).`,
    );
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
