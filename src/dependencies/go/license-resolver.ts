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

import { dirname, join, relative } from "node:path";
import type { Dependency, LicenseRule } from "../../types.js";
import type { Logger } from "../../logger.js";
import { readText } from "../../util.js";
import {
  fetchJson,
  fetchText,
  identifyLicenseText,
  LICENSE_FILENAMES,
} from "../sources/metadata.js";
import type { LicenseEvidence } from "../checker.js";

function resolveVendoredGoLicense(
  root: string,
  dependency: Dependency,
  includeMatchText: boolean,
  licenseRules: LicenseRule[] | undefined,
): { license?: string; source?: string; matchText?: string } {
  const vendorRoot = join(root, dirname(dependency.manifest), "vendor");
  let directory = join(vendorRoot, ...dependency.name.split("/"));
  for (;;) {
    for (const filename of LICENSE_FILENAMES) {
      const path = join(directory, filename);
      const text = readText(path);
      const license = text
        ? identifyLicenseText(text, licenseRules)
        : undefined;
      if (license || (includeMatchText && text))
        return {
          license,
          source: relative(root, path),
          matchText: text,
        };
    }
    if (directory === vendorRoot) break;
    directory = dirname(directory);
  }
  return {};
}

export async function resolveGoLicense(
  root: string,
  dependency: Dependency,
  token: string | undefined,
  logger: Logger,
  includeMatchText: boolean,
  licenseRules?: LicenseRule[],
): Promise<LicenseEvidence> {
  const vendored = resolveVendoredGoLicense(
    root,
    dependency,
    includeMatchText,
    licenseRules,
  );
  if (vendored.license || vendored.matchText)
    return {
      ...vendored,
      resolution: "manifest",
    };
  const match = /^github\.com\/([^/]+\/[^/]+)(?:\/v\d+)?$/.exec(
    dependency.name,
  );
  if (!match) {
    logger.debug(`No repository resolver for Go module ${dependency.name}`);
    return { resolution: "unknown" };
  }

  const apiMetadata = (await fetchJson(
    `https://api.github.com/repos/${match[1]}/license`,
    token,
  )) as
    | {
        license?: { spdx_id?: string };
        download_url?: string;
      }
    | undefined;
  const apiLicense = apiMetadata?.license?.spdx_id;
  if (apiLicense && apiLicense !== "NOASSERTION") {
    const matchText =
      includeMatchText && apiMetadata.download_url
        ? await fetchText(apiMetadata.download_url)
        : undefined;
    return {
      license: apiLicense,
      source: `api.github.com/repos/${match[1]}/license`,
      matchText,
      resolution: "repository",
    };
  }

  const candidates = [
    dependency.version,
    `v${dependency.version.replace(/^v/, "")}`,
    "main",
    "master",
  ];
  const attempts = await Promise.all(
    candidates.flatMap((ref) =>
      LICENSE_FILENAMES.map(async (filename) => ({
        filename,
        text: await fetchText(
          `https://raw.githubusercontent.com/${match[1]}/${encodeURIComponent(ref)}/${filename}`,
        ),
      })),
    ),
  );
  for (const attempt of attempts) {
    const license = attempt.text
      ? identifyLicenseText(attempt.text, licenseRules)
      : undefined;
    if (license || (includeMatchText && attempt.text))
      return {
        license,
        source: `github.com/${match[1]}/${attempt.filename}`,
        matchText: attempt.text,
        resolution: "repository",
      };
  }
  return { resolution: "unknown" };
}
