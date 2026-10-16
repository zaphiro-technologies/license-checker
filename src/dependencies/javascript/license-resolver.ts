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

import { dirname, join } from "node:path";
import type { Dependency, LicenseRule } from "../../types.js";
import type { Logger } from "../../logger.js";
import { readJson } from "../../util.js";
import { packageLicense, type PackageJson } from "./parsers/package-json.js";
import {
  fetchJson,
  githubRepositoryFromUrl,
  resolveGithubRepositoryLicense,
} from "../sources/metadata.js";
import type { LicenseEvidence } from "../checker.js";

function installedNpmPackage(
  root: string,
  manifest: string,
  name: string,
): PackageJson | undefined {
  const packagePath = name.startsWith("@")
    ? join("node_modules", ...name.split("/"), "package.json")
    : join("node_modules", name, "package.json");
  const candidates = [
    join(root, packagePath),
    join(root, dirname(manifest), packagePath),
  ];
  for (const candidate of candidates) {
    const packageJson = readJson(candidate) as PackageJson | undefined;
    if (packageJson) return packageJson;
  }
  return undefined;
}

async function npmRepositoryLicenseText(
  packageInfo: PackageJson | undefined,
  token: string | undefined,
  licenseRules: LicenseRule[] | undefined,
): Promise<LicenseEvidence | undefined> {
  const repositoryUrl =
    typeof packageInfo?.repository === "string"
      ? packageInfo.repository
      : packageInfo?.repository?.url;
  const repository = repositoryUrl
    ? githubRepositoryFromUrl(repositoryUrl)
    : undefined;
  if (!repository) return undefined;
  return resolveGithubRepositoryLicense(repository, token, true, licenseRules);
}

export async function resolveNpmLicense(
  root: string,
  dependency: Dependency,
  logger: Logger,
  token: string | undefined,
  includeMatchText: boolean,
  licenseRules: LicenseRule[] | undefined,
): Promise<LicenseEvidence> {
  const installed = installedNpmPackage(
    root,
    dependency.manifest,
    dependency.name,
  );
  const installedLicense = packageLicense(
    installed?.license ?? installed?.licenses,
  );
  const installedMatchText = includeMatchText
    ? await npmRepositoryLicenseText(installed, token, licenseRules)
    : undefined;
  if (
    installedLicense &&
    (!includeMatchText || installedMatchText?.matchText)
  ) {
    return {
      license: installedLicense,
      source: "node_modules/package.json",
      matchText: installedMatchText?.matchText,
      resolution: "manifest",
    };
  }
  const encodedName = dependency.name.startsWith("@")
    ? dependency.name.replace("/", "%2f")
    : dependency.name;
  const concreteVersion = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(
    dependency.version,
  );
  const registryUrl = concreteVersion
    ? `https://registry.npmjs.org/${encodedName}/${encodeURIComponent(dependency.version)}`
    : `https://registry.npmjs.org/${encodedName}`;
  const metadata = (await fetchJson(registryUrl)) as
    | (PackageJson & {
        versions?: Record<string, PackageJson>;
        ["dist-tags"]?: { latest?: string };
      })
    | undefined;
  const metadataMatch = includeMatchText
    ? ((await npmRepositoryLicenseText(metadata, token, licenseRules)) ??
      installedMatchText)
    : undefined;
  const metadataMatchText = metadataMatch?.matchText;
  if (installedLicense)
    return {
      license: installedLicense,
      source: "node_modules/package.json",
      matchText: metadataMatchText,
      resolution: "manifest",
    };
  const registryLicense = packageLicense(
    metadata?.license ?? metadata?.licenses,
  );
  if (registryLicense) {
    return {
      license: registryLicense,
      source: "registry.npmjs.org",
      matchText: metadataMatchText,
      resolution: "registry",
    };
  }
  if (metadata?.versions) {
    const latest = metadata.versions[metadata["dist-tags"]?.latest ?? ""];
    const latestLicense = packageLicense(latest?.license ?? latest?.licenses);
    if (latestLicense) {
      const matchText = includeMatchText
        ? (await npmRepositoryLicenseText(latest, token, licenseRules))
            ?.matchText
        : undefined;
      return {
        license: latestLicense,
        source: "registry.npmjs.org",
        matchText,
        resolution: "registry",
      };
    }
  }
  if (installedLicense)
    return {
      license: installedLicense,
      source: "node_modules/package.json",
      matchText: metadataMatchText,
      resolution: "manifest",
    };
  logger.debug(
    `Could not resolve npm license for ${dependency.name}@${dependency.version}`,
  );
  return {
    license: metadataMatch?.license,
    source: metadataMatch?.source,
    matchText: metadataMatchText,
    resolution: metadataMatch?.resolution ?? "unknown",
  };
}
