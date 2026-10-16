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

import type { Dependency, LicenseRule } from "../../types.js";
import type { Logger } from "../../logger.js";
import { normalizeLicenseExpression } from "../../spdx.js";
import { licensesFromPythonClassifiers } from "./parsers/classifiers.js";
import {
  fetchJson,
  githubRepositoryFromUrl,
  resolveGithubRepositoryLicense,
} from "../sources/metadata.js";
import type { LicenseEvidence } from "../checker.js";

interface PythonPackageMetadata {
  info?: {
    license?: string | null;
    license_expression?: string | null;
    classifiers?: string[];
    version?: string;
    home_page?: string | null;
    project_urls?: Record<string, string | null | undefined>;
  };
  releases?: Record<string, Array<{ yanked?: boolean }>>;
}

function pythonVersionParts(version: string): number[] | undefined {
  let value = version.trim();
  if (value[0]?.toLowerCase() === "v") value = value.slice(1);
  const parts = value.split(".");
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part)))
    return undefined;
  return parts.map(Number);
}

function comparePythonVersions(left: string, right: string): number {
  const leftParts = pythonVersionParts(left);
  const rightParts = pythonVersionParts(right);
  if (!leftParts || !rightParts) return 0;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function pythonSpecifier(version: string): string {
  let value = version.trim();
  if (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1);
  return value.split(";", 1)[0].trim();
}

function matchesPythonSpecifier(version: string, specifier: string): boolean {
  const parts = pythonVersionParts(version);
  if (!parts) return false;
  const constraints = pythonSpecifier(specifier);
  if (!constraints || constraints === "*") return true;

  return constraints.split(",").every((constraint) => {
    const match =
      /^(===|==|!=|~=|>=|<=|>|<)?\s*v?(\d+(?:\.\d+)*(?:\.\*)?)$/i.exec(
        constraint.trim(),
      );
    if (!match) return false;
    const operator = match[1] ?? "==";
    const target = match[2];
    if (target.endsWith(".*")) {
      const prefix = target.slice(0, -2).split(".").map(Number);
      const matchesPrefix = prefix.every(
        (value, index) => parts[index] === value,
      );
      return operator === "!="
        ? !matchesPrefix
        : operator === "==" && matchesPrefix;
    }
    const comparison = comparePythonVersions(version, target);
    if (operator === "===" || operator === "==") return comparison === 0;
    if (operator === "!=") return comparison !== 0;
    if (operator === ">") return comparison > 0;
    if (operator === ">=") return comparison >= 0;
    if (operator === "<") return comparison < 0;
    if (operator === "<=") return comparison <= 0;
    const targetParts = pythonVersionParts(target);
    if (!targetParts || targetParts.length < 2) return false;
    const upperBound = [...targetParts];
    upperBound[upperBound.length - 2] += 1;
    upperBound.length -= 1;
    return (
      comparison >= 0 &&
      comparePythonVersions(version, upperBound.join(".")) < 0
    );
  });
}

function exactPythonVersion(version: string): string | undefined {
  let specifier = pythonSpecifier(version);
  if (specifier.startsWith("===")) specifier = specifier.slice(3).trim();
  else if (specifier.startsWith("==")) specifier = specifier.slice(2).trim();
  return pythonVersionParts(specifier) ? specifier : undefined;
}

function selectPythonRelease(
  metadata: PythonPackageMetadata,
  specifier: string,
): string | undefined {
  return Object.entries(metadata.releases ?? {})
    .filter(
      ([version, files]) =>
        pythonVersionParts(version) &&
        files.some((file) => file.yanked !== true) &&
        matchesPythonSpecifier(version, specifier),
    )
    .map(([version]) => version)
    .sort(comparePythonVersions)
    .at(-1);
}

function isConciseLicenseMetadata(value: string): boolean {
  return value.length <= 200 && !/[\r\n]/.test(value);
}

function githubRepositoryForPython(
  info: PythonPackageMetadata["info"],
): string | undefined {
  if (!info) return undefined;
  const urls = [info.home_page, ...Object.values(info.project_urls ?? {})];
  for (const url of urls) {
    if (!url) continue;
    const repository = githubRepositoryFromUrl(url);
    if (repository) return repository;
  }
  return undefined;
}

type PythonResolution = LicenseEvidence;

async function loadPythonMetadata(
  packageUrl: string,
  dependency: Dependency,
): Promise<{ metadata?: PythonPackageMetadata; version?: string }> {
  const pinnedVersion = exactPythonVersion(dependency.version);
  let resolvedVersion = pinnedVersion;
  let metadata = (await fetchJson(
    pinnedVersion
      ? packageUrl + "/" + encodeURIComponent(pinnedVersion) + "/json"
      : packageUrl + "/json",
  )) as PythonPackageMetadata | undefined;
  if (!pinnedVersion && metadata) {
    resolvedVersion = selectPythonRelease(metadata, dependency.version);
    if (resolvedVersion && resolvedVersion !== metadata.info?.version) {
      const releaseMetadata = (await fetchJson(
        packageUrl + "/" + encodeURIComponent(resolvedVersion) + "/json",
      )) as PythonPackageMetadata | undefined;
      if (releaseMetadata) metadata = releaseMetadata;
    }
  }
  return { metadata, version: resolvedVersion };
}

function declaredPythonLicense(
  info: PythonPackageMetadata["info"],
  version: string | undefined,
): PythonResolution | undefined {
  const expression = info?.license_expression?.trim();
  if (expression)
    return {
      license: expression,
      source: "pypi.org",
      version,
      resolution: "registry",
    };
  const declaredLicense = info?.license?.trim();
  if (
    !declaredLicense ||
    !isConciseLicenseMetadata(declaredLicense) ||
    normalizeLicenseExpression(declaredLicense) === "Unknown"
  )
    return undefined;
  return {
    license: declaredLicense,
    source: "pypi.org",
    version,
    resolution: "registry",
  };
}

function classifierPythonLicense(
  classifiers: string[] | undefined,
  version: string | undefined,
  licenseRules: LicenseRule[] | undefined,
): PythonResolution | undefined {
  const licenses = licensesFromPythonClassifiers(classifiers, licenseRules);
  if (licenses.length === 0) return undefined;
  let license = licenses[0] ?? "Unknown";
  if (licenses.length > 1) license = "(" + licenses.join(" OR ") + ")";
  return {
    license,
    source: "pypi.org classifier",
    version,
    resolution: "registry",
  };
}

async function repositoryPythonLicense(
  info: PythonPackageMetadata["info"],
  token: string | undefined,
  version: string | undefined,
  includeMatchText = false,
  licenseRules?: LicenseRule[],
): Promise<PythonResolution | undefined> {
  const repository = githubRepositoryForPython(info);
  if (!repository) return undefined;
  const resolved = await resolveGithubRepositoryLicense(
    repository,
    token,
    includeMatchText,
    licenseRules,
  );
  return resolved.license ? { ...resolved, version } : undefined;
}

function addRepositoryMatchText(
  license: PythonResolution,
  repositoryLicense: PythonResolution | undefined,
): PythonResolution {
  if (!repositoryLicense?.matchText) return license;
  return { ...license, matchText: repositoryLicense.matchText };
}

async function resolveDeclaredPythonLicense(
  info: PythonPackageMetadata["info"],
  license: PythonResolution,
  token: string | undefined,
  version: string | undefined,
  licenseRules?: LicenseRule[],
): Promise<PythonResolution> {
  const repository = githubRepositoryForPython(info);
  if (!repository) return license;
  const repositoryLicense = await repositoryPythonLicense(
    info,
    token,
    version,
    true,
    licenseRules,
  );
  return addRepositoryMatchText(license, repositoryLicense);
}

async function resolvePythonFallbackLicense(
  info: PythonPackageMetadata["info"],
  token: string | undefined,
  version: string | undefined,
  includeMatchText: boolean,
  licenseRules?: LicenseRule[],
): Promise<PythonResolution | undefined> {
  const classifierLicenses = licensesFromPythonClassifiers(
    info?.classifiers,
    licenseRules,
  );
  const repository = githubRepositoryForPython(info);
  const repositoryResolution =
    includeMatchText && repository
      ? await repositoryPythonLicense(info, token, version, true, licenseRules)
      : undefined;

  if (classifierLicenses.length > 1 && repository) {
    const resolved =
      repositoryResolution ??
      (await repositoryPythonLicense(
        info,
        token,
        version,
        includeMatchText,
        licenseRules,
      ));
    if (resolved) return resolved;
  }

  const classifier = classifierPythonLicense(
    info?.classifiers,
    version,
    licenseRules,
  );
  if (classifier)
    return addRepositoryMatchText(classifier, repositoryResolution);

  if (!repository) return undefined;
  return (
    repositoryResolution ??
    (await repositoryPythonLicense(
      info,
      token,
      version,
      includeMatchText,
      licenseRules,
    ))
  );
}

export async function resolvePythonLicense(
  dependency: Dependency,
  token: string | undefined,
  logger: Logger,
  includeMatchText: boolean,
  licenseRules?: LicenseRule[],
): Promise<PythonResolution> {
  const packageName = dependency.name.replace(/[-_.]+/g, "-");
  const packageUrl = "https://pypi.org/pypi/" + encodeURIComponent(packageName);
  const { metadata, version } = await loadPythonMetadata(
    packageUrl,
    dependency,
  );

  const info = metadata?.info;
  const declared = declaredPythonLicense(info, version);
  if (declared) {
    if (!includeMatchText) return declared;
    return resolveDeclaredPythonLicense(
      info,
      declared,
      token,
      version,
      licenseRules,
    );
  }
  const fallback = await resolvePythonFallbackLicense(
    info,
    token,
    version,
    includeMatchText,
    licenseRules,
  );
  if (fallback) return fallback;
  logger.debug(
    `Could not resolve Python license for ${dependency.name}@${dependency.version}`,
  );
  return { resolution: "unknown" };
}
