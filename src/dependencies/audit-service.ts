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

import { resolve } from "node:path";
import { headerRules } from "../config.js";
import { Logger } from "../logger.js";
import {
  checkCompatibility,
  checkProprietaryCompatibility,
  distributionWarningFor,
  normalizeLicenseExpression,
} from "../spdx.js";
import type {
  Dependency,
  DependencyReport,
  DependencyResult,
  DistributionModel,
  LicenseEyeConfig,
} from "../types.js";
import { DEFAULT_DISTRIBUTION, licenseCompatAdviceUrl } from "../spdx.js";
import { isFile, matchesPath, uniqueBy } from "../util.js";
import { collectDependencyManifest } from "./registry.js";
import { systemGoPackageList } from "./go/checker.js";
import type { GoPackageListRunner } from "./checker.js";
import {
  excludedBy,
  exceptionFor,
  resolveLicense,
} from "./policy/license-policy.js";

function mainLicenseFor(
  manifest: string,
  config: LicenseEyeConfig,
): string | undefined {
  const rules = headerRules(config);
  const selected = rules
    .filter((rule) => !rule.path || matchesPath(manifest, [rule.path]))
    .sort(
      (left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0),
    )[0];
  return selected?.license["spdx-id"] ?? rules[0]?.license["spdx-id"];
}

export async function checkDependencies(
  root: string,
  config: LicenseEyeConfig,
  token: string | undefined,
  weakCompatible: boolean,
  logger: Logger,
  goPackageList: GoPackageListRunner = systemGoPackageList,
  distribution: DistributionModel = DEFAULT_DISTRIBUTION,
): Promise<DependencyReport> {
  const dependencyConfig = config.dependency;
  if (!dependencyConfig?.files?.length) {
    return { checked: 0, results: [], failures: [] };
  }

  const dependencies: Dependency[] = [];
  for (const configuredPath of dependencyConfig.files) {
    const path = configuredPath.replaceAll("\\", "/");
    if (!isFile(resolve(root, path)))
      throw new Error(`Dependency file not found: ${path}`);
    const collected = collectDependencyManifest({
      root,
      path,
      absolutePath: resolve(root, path),
      dependencyConfig,
      goPackageList,
    });
    if (collected) dependencies.push(...collected);
    else {
      dependencies.push({
        name: "(unsupported dependency input)",
        version: "unresolved",
        ecosystem: "unknown",
        manifest: path,
        versionResolved: false,
        versionResolutionError: `No parser is available for dependency input ${path.split("/").pop() ?? path}.`,
      });
    }
  }

  const uniqueDependencies = uniqueBy(
    dependencies,
    (dependency) =>
      `${dependency.ecosystem}:${dependency.name}@${dependency.version}`,
  ).filter(
    (dependency) =>
      !excludedBy(dependencyConfig, dependency.name, dependency.version),
  );
  logger.info(`Found ${uniqueDependencies.length} dependencies to check.`);

  const resultSlots: Array<DependencyResult | undefined> = new Array(
    uniqueDependencies.length,
  );
  const concurrency = Math.min(16, uniqueDependencies.length);
  const resolveDependency = async (index: number): Promise<void> => {
    const dependency = uniqueDependencies[index];
    if (!dependency) return;
    if (
      index === 0 ||
      (index + 1) % 100 === 0 ||
      index === uniqueDependencies.length - 1
    ) {
      logger.info(
        `Resolving dependencies: ${index + 1}/${uniqueDependencies.length}`,
      );
    }
    logger.debug(
      `Resolving dependency ${index + 1}/${uniqueDependencies.length}: ${dependency.name}@${dependency.version}`,
    );
    if (!dependency.versionResolved) {
      resultSlots[index] = {
        ...dependency,
        license: "Unknown",
        normalized: "Unknown",
        resolution: "unknown",
        compatible: "unknown",
        reason:
          dependency.versionResolutionError ??
          "An exact resolved dependency version is required.",
      };
      return;
    }
    const exception = exceptionFor(
      dependencyConfig,
      dependency.name,
      dependency.version,
    );
    if (exception) {
      resultSlots[index] = {
        ...dependency,
        license: "LicenseRef-Manual-Exception",
        normalized: "LicenseRef-Manual-Exception",
        resolution: "exception",
        compatible: "approved-exception",
        source: exception.url,
        approval: { url: exception.url, reason: exception.reason },
        reason: `Manual approval: ${exception.reason}`,
      };
      logger.debug(
        `Dependency ${dependency.name}@${dependency.version}: approved manual exception`,
      );
      return;
    }
    const resolved = await resolveLicense(
      root,
      dependency,
      dependencyConfig,
      token,
      logger,
    );
    const resolvedDependency = resolved.version
      ? { ...dependency, version: resolved.version }
      : dependency;
    const normalized = normalizeLicenseExpression(resolved.license);
    const distributionWarning = distributionWarningFor(
      normalized,
      distribution,
    );
    const projectLicense = mainLicenseFor(dependency.manifest, config);
    const compatibility =
      dependencyConfig.projectLicense === "proprietary"
        ? checkProprietaryCompatibility(
            normalized,
            distribution,
            dependencyConfig,
          )
        : checkCompatibility(
            projectLicense,
            normalized,
            weakCompatible,
            dependencyConfig,
          );
    resultSlots[index] = {
      ...resolvedDependency,
      license: resolved.license,
      normalized,
      resolution: resolved.resolution,
      source: resolved.source,
      compatible: compatibility,
      distributionWarning,
      adviceUrl: licenseCompatAdviceUrl(
        dependencyConfig.projectLicense === "proprietary"
          ? undefined
          : projectLicense,
        normalized,
        distribution,
      ),
      reason:
        compatibility === "compatible"
          ? undefined
          : compatibility === "unknown" || compatibility === "weak-compatible"
            ? "Manual approval required: conditional, unlisted, or unverified license compatibility."
            : dependencyConfig.projectLicense === "proprietary"
              ? `${compatibility} with proprietary software under ${distribution}`
              : `${compatibility} with project license`,
    };
    logger.debug(
      `Dependency ${dependency.name}@${dependency.version}: ${normalized} (${compatibility})`,
    );
  };
  const worker = async (index: number): Promise<void> => {
    if (index >= uniqueDependencies.length) return;
    await resolveDependency(index);
    return worker(index + concurrency);
  };
  await Promise.all(
    Array.from({ length: concurrency }, (_, index) => worker(index)),
  );
  const results = resultSlots.filter(
    (result): result is DependencyResult => result !== undefined,
  );

  return {
    checked: results.length,
    results,
    failures: results.filter(
      (result) =>
        result.compatible !== "compatible" &&
        result.compatible !== "approved-exception",
    ),
  };
}
