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

import { minimatch } from "minimatch";
import type { Logger } from "../../logger.js";
import type {
  Dependency,
  DependencyConfig,
  DependencyResult,
} from "../../types.js";
import { resolveDependencyLicense } from "../registry.js";

export interface ResolvedLicense {
  license: string;
  resolution: DependencyResult["resolution"];
  source?: string;
  version?: string;
}

function versionMatches(configured: string | undefined, version: string) {
  return (
    !configured ||
    configured
      .split(",")
      .map((item) => item.trim())
      .includes(version)
  );
}

function nameMatches(name: string, pattern: string): boolean {
  return name === pattern || minimatch(name, pattern);
}

function overrideFor(
  config: DependencyConfig,
  name: string,
  version: string,
): string | undefined {
  for (const override of config.licenses ?? []) {
    if (override.match !== undefined) continue;
    if (
      versionMatches(override.version, version) &&
      nameMatches(name, override.name)
    )
      return override.license;
  }
  return undefined;
}

function matchOverrideFor(
  config: DependencyConfig,
  name: string,
  version: string,
  candidates: string[],
): string | undefined {
  for (const candidate of candidates) {
    for (const override of config.licenses ?? []) {
      if (override.match === undefined) continue;
      if (
        versionMatches(override.version, version) &&
        nameMatches(name, override.name) &&
        new RegExp(override.match).test(candidate)
      )
        return override.license;
    }
  }
  return undefined;
}

function hasMatchRuleFor(
  config: DependencyConfig,
  name: string,
  version: string,
): boolean {
  return (config.licenses ?? []).some(
    (override) =>
      override.match !== undefined &&
      versionMatches(override.version, version) &&
      nameMatches(name, override.name),
  );
}

export function exceptionFor(
  config: DependencyConfig,
  name: string,
  version: string,
): NonNullable<DependencyConfig["exceptions"]>[number] | undefined {
  return (config.exceptions ?? []).find(
    (exception) => exception.name === name && exception.version === version,
  );
}

export function excludedBy(
  config: DependencyConfig,
  name: string,
  version: string,
): boolean {
  return (config.excludes ?? []).some(
    (exclude) =>
      versionMatches(exclude.version, version) &&
      nameMatches(name, exclude.name),
  );
}

export async function resolveLicense(
  root: string,
  dependency: Dependency,
  config: DependencyConfig,
  token: string | undefined,
  logger: Logger,
): Promise<ResolvedLicense> {
  const configured = overrideFor(config, dependency.name, dependency.version);
  if (configured)
    return {
      license: configured,
      resolution: "configured",
      source: "configuration",
    };

  const matchCandidates = dependency.rawLicense ? [dependency.rawLicense] : [];
  const configuredMatch = matchOverrideFor(
    config,
    dependency.name,
    dependency.version,
    matchCandidates,
  );
  if (configuredMatch)
    return {
      license: configuredMatch,
      resolution: "configured",
      source: "configuration",
    };

  const hasMatchRules = hasMatchRuleFor(
    config,
    dependency.name,
    dependency.version,
  );
  const includeMatchText =
    hasMatchRules ||
    config.licenseRules?.some((rule) => rule.source === "license-text") ===
      true;
  const resolved = await resolveDependencyLicense(
    dependency.ecosystem,
    dependency,
    {
      root,
      token,
      logger,
      includeMatchText,
      licenseRules: config.licenseRules,
    },
  );
  const configuredTextMatch = matchOverrideFor(
    config,
    dependency.name,
    dependency.version,
    [
      ...matchCandidates,
      ...(resolved.license ? [resolved.license] : []),
      ...(resolved.matchText ? [resolved.matchText] : []),
    ],
  );
  if (configuredTextMatch)
    return {
      license: configuredTextMatch,
      resolution: "configured",
      source: "configuration",
      version: resolved.version,
    };
  const licenseTextRule = config.licenseRules?.find(
    (rule) =>
      rule.source === "license-text" &&
      resolved.matchText !== undefined &&
      new RegExp(rule.match, "is").test(resolved.matchText),
  );
  if (licenseTextRule)
    return {
      license: licenseTextRule.license,
      resolution: "configured",
      source: "configuration",
      version: resolved.version,
    };
  if (dependency.rawLicense)
    return {
      license: dependency.rawLicense,
      resolution: "manifest",
      source: dependency.manifest,
    };

  return {
    license: resolved.license ?? "Unknown",
    resolution: resolved.resolution,
    source: resolved.source,
    version: resolved.version,
  };
}
