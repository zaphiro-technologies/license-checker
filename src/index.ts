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

import * as core from "@actions/core";
import { headerRules, loadConfig } from "./config.js";
import { checkDependencies } from "./dependencies.js";
import { Logger } from "./logger.js";
import { DEFAULT_DISTRIBUTION } from "./spdx.js";
import {
  restoreMetadataCache,
  saveMetadataCache,
} from "./dependencies/metadata/cache/index.js";
import {
  annotate,
  commentOnPullRequest,
  distributionWarnings,
  writeSummary,
} from "./report.js";
import type {
  CheckReport,
  DistributionModel,
  LicenseEyeConfig,
} from "./types.js";

const DISTRIBUTION_MODELS = new Set<DistributionModel>([
  "internal-use",
  "proprietary-binary",
  "public-saas",
  "open-source-redistribution",
  "static-linking",
  "dynamic-linking",
]);

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
  await restoreMetadataCache(root, config.dependency?.files ?? []);
  const distributionInput =
    core.getInput("distribution") ||
    argumentValue("--distribution") ||
    config.dependency?.distribution ||
    DEFAULT_DISTRIBUTION;
  if (!DISTRIBUTION_MODELS.has(distributionInput as DistributionModel)) {
    throw new Error(
      "Invalid distribution. Use internal-use, proprietary-binary, public-saas, open-source-redistribution, static-linking, or dynamic-linking.",
    );
  }
  const dependency = await checkDependencies(
    root,
    config,
    token,
    weakCompatible,
    logger,
    undefined,
    distributionInput as DistributionModel,
  );
  await saveMetadataCache();
  const report: CheckReport = {
    dependency,
    failed: dependency.failures.length > 0,
  };

  annotate(report);
  await writeSummary(report, reportAll ? "all" : "issues");
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

try {
  await run();
} catch (error: unknown) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
