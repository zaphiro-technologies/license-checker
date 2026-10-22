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

import { getCachedMetadata, rememberMetadata } from "./index.js";

interface PythonPackageMetadata {
  info?: {
    license?: string | null;
    license_expression?: string | null;
    classifiers?: string[];
    version?: string;
    home_page?: string | null;
    project_urls?: Record<string, string | null | undefined>;
  };
}

function isPythonReleaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "pypi.org" &&
      segments.length === 4 &&
      segments[0] === "pypi" &&
      segments[1] !== "" &&
      segments[2] !== "" &&
      segments[3] === "json"
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProjectUrl(
  entry: [string, unknown],
): entry is [string, string | null] {
  return typeof entry[1] === "string" || entry[1] === null;
}

function validPythonMetadata(
  value: unknown,
): PythonPackageMetadata | undefined {
  if (!isRecord(value) || !isRecord(value.info)) return undefined;
  const source = value.info;
  const projectUrls = isRecord(source.project_urls)
    ? Object.fromEntries(
        Object.entries(source.project_urls).filter(isProjectUrl),
      )
    : undefined;
  const info = {
    ...(typeof source.license === "string" || source.license === null
      ? { license: source.license }
      : {}),
    ...(typeof source.license_expression === "string" ||
    source.license_expression === null
      ? { license_expression: source.license_expression }
      : {}),
    ...(Array.isArray(source.classifiers) &&
    source.classifiers.every((item) => typeof item === "string")
      ? { classifiers: source.classifiers }
      : {}),
    ...(typeof source.version === "string" ? { version: source.version } : {}),
    ...(typeof source.home_page === "string" || source.home_page === null
      ? { home_page: source.home_page }
      : {}),
    ...(projectUrls ? { project_urls: projectUrls } : {}),
  };
  if (Object.keys(info).length === 0) return undefined;
  return { info };
}

export function cachedPythonLicenseMetadata(
  url: string,
): PythonPackageMetadata | undefined {
  return isPythonReleaseUrl(url)
    ? validPythonMetadata(getCachedMetadata(url))
    : undefined;
}

export function rememberPythonLicenseMetadata(
  url: string,
  value: unknown,
): void {
  if (!isPythonReleaseUrl(url)) return;
  const selected = validPythonMetadata(value);
  if (selected) rememberMetadata(url, selected);
}
