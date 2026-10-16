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

import type { LicenseEvidence } from "../checker.js";
import type { LicenseRule } from "../../types.js";
import { DEFAULT_LICENSE_TEXT_RULES } from "./default-license-rules.js";

const jsonCache = new Map<string, Promise<unknown>>();
const textCache = new Map<string, Promise<string | undefined>>();
export const LICENSE_FILENAMES = [
  "LICENSE",
  "LICENCE",
  "LICENSE.txt",
  "LICENCE.txt",
  "LICENSE.md",
  "LICENCE.md",
  "COPYING",
];

export async function fetchJson(url: string, token?: string): Promise<unknown> {
  const cacheKey = `${token ? "authenticated" : "anonymous"}:${url}`;
  const cached = jsonCache.get(cacheKey);
  if (cached) return cached;

  const request = (async (): Promise<unknown> => {
    try {
      const response = await fetch(url, {
        headers: token
          ? { authorization: `Bearer ${token}`, accept: "application/json" }
          : { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return undefined;
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  })();
  jsonCache.set(cacheKey, request);
  return request;
}

export async function fetchText(url: string): Promise<string | undefined> {
  const cached = textCache.get(url);
  if (cached) return cached;

  const request = (async (): Promise<string | undefined> => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      return response.ok ? response.text() : undefined;
    } catch {
      return undefined;
    }
  })();
  textCache.set(url, request);
  return request;
}

export function identifyLicenseText(
  text: string,
  customRules: LicenseRule[] = [],
): string | undefined {
  const applicableRules = customRules.filter(
    (rule) => rule.source === "license-text",
  );
  for (const rule of [...applicableRules, ...DEFAULT_LICENSE_TEXT_RULES]) {
    if (new RegExp(rule.match, "is").test(text)) return rule.license;
  }
  return undefined;
}

export function githubRepositoryFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url.replace(/^git\+/, ""));
    if (
      parsed.hostname.toLowerCase() !== "github.com" &&
      parsed.hostname.toLowerCase() !== "www.github.com"
    )
      return undefined;
    const [owner, repository] = parsed.pathname.split("/").filter(Boolean);
    return owner && repository
      ? `${owner}/${repository.replace(/\.git$/, "")}`
      : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveGithubRepositoryLicense(
  repository: string,
  token: string | undefined,
  includeMatchText = false,
  licenseRules: LicenseRule[] = [],
): Promise<LicenseEvidence> {
  const apiUrl = `https://api.github.com/repos/${repository}/license`;
  const metadata = (await fetchJson(apiUrl, token)) as
    | {
        license?: { spdx_id?: string };
        download_url?: string;
        html_url?: string;
      }
    | undefined;
  const apiLicense = metadata?.license?.spdx_id;
  if (apiLicense && apiLicense !== "NOASSERTION") {
    const matchText =
      includeMatchText && metadata?.download_url
        ? await fetchText(metadata.download_url)
        : undefined;
    return {
      license: apiLicense,
      source: apiUrl,
      matchText,
      resolution: "repository",
    };
  }
  if (metadata?.download_url) {
    const text = await fetchText(metadata.download_url);
    const license = text ? identifyLicenseText(text, licenseRules) : undefined;
    if (license || text)
      return {
        license,
        source: metadata.html_url ?? metadata.download_url,
        matchText: text,
        resolution: "repository",
      };
  }
  return { resolution: "unknown" };
}
