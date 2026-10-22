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

export interface NpmLicenseMetadata {
  license?: unknown;
  licenses?: unknown;
  repository?: unknown;
}

function isNpmVersionUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "registry.npmjs.org" &&
      segments.length >= 2 &&
      /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(
        decodeURIComponent(segments.at(-1) ?? ""),
      )
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMetadata(value: unknown): NpmLicenseMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const repository = value.repository;
  const validRepository =
    typeof repository === "string" ||
    (isRecord(repository) && typeof repository.url === "string");
  const licenses = Array.isArray(value.licenses)
    ? value.licenses.filter(
        (license) => isRecord(license) && typeof license.type === "string",
      )
    : undefined;
  return {
    ...(typeof value.license === "string" || isRecord(value.license)
      ? { license: value.license }
      : {}),
    ...(licenses?.length ? { licenses } : {}),
    ...(validRepository ? { repository } : {}),
  };
}

export function cachedNpmLicenseMetadata(
  url: string,
): NpmLicenseMetadata | undefined {
  if (!isNpmVersionUrl(url)) return undefined;
  return validMetadata(getCachedMetadata(url));
}

export function rememberNpmLicenseMetadata(url: string, value: unknown): void {
  if (!isNpmVersionUrl(url)) return;
  const selected = validMetadata(value);
  if (selected && Object.keys(selected).length > 0)
    rememberMetadata(url, selected);
}
