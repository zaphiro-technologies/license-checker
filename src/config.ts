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

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type {
  DependencyConfig,
  HeaderRule,
  LicenseEyeConfig,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function flattenHeader(
  entry: HeaderRule | HeaderRule[] | undefined,
): HeaderRule[] {
  if (Array.isArray(entry)) return entry;
  return entry ? [entry] : [];
}

function normalizeHeader(
  value: unknown,
): HeaderRule | HeaderRule[] | undefined {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeHeader(entry)).flatMap(flattenHeader);
  }
  if (!value || typeof value !== "object") return undefined;

  const record = asRecord(value);
  const license = asRecord(record.license);
  return {
    path: typeof record.path === "string" ? record.path : undefined,
    license: {
      "spdx-id":
        typeof license["spdx-id"] === "string" ? license["spdx-id"] : undefined,
      "copyright-owner":
        typeof license["copyright-owner"] === "string"
          ? license["copyright-owner"]
          : undefined,
      "copyright-year":
        typeof license["copyright-year"] === "string" ||
        typeof license["copyright-year"] === "number"
          ? license["copyright-year"]
          : undefined,
      "software-name":
        typeof license["software-name"] === "string"
          ? license["software-name"]
          : undefined,
      content:
        typeof license.content === "string" ? license.content : undefined,
      pattern:
        typeof license.pattern === "string" ? license.pattern : undefined,
    },
    paths: Array.isArray(record.paths)
      ? record.paths.filter((item): item is string => typeof item === "string")
      : undefined,
    "paths-ignore": Array.isArray(record["paths-ignore"])
      ? record["paths-ignore"].filter(
          (item): item is string => typeof item === "string",
        )
      : undefined,
    comment:
      record.comment === "always" ||
      record.comment === "never" ||
      record.comment === "on-failure"
        ? record.comment
        : undefined,
    "license-location-threshold":
      typeof record["license-location-threshold"] === "number"
        ? record["license-location-threshold"]
        : undefined,
    language: asRecord(record.language),
  };
}

function normalizeDependencies(value: unknown): DependencyConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = asRecord(value);
  if (record.exceptions !== undefined && !Array.isArray(record.exceptions)) {
    throw new Error("dependency.exceptions must be a list.");
  }
  const exceptions = Array.isArray(record.exceptions)
    ? record.exceptions.map((item, index) => {
        const entry = asRecord(item);
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        const version =
          typeof entry.version === "string" ? entry.version.trim() : "";
        const url = typeof entry.url === "string" ? entry.url.trim() : "";
        const reason =
          typeof entry.reason === "string" ? entry.reason.trim() : "";
        if (!name || !version || !url || !reason) {
          throw new Error(
            `dependency.exceptions[${index}] requires name, version, url, and reason.`,
          );
        }
        try {
          const parsedUrl = new URL(url);
          if (
            parsedUrl.protocol !== "https:" &&
            parsedUrl.protocol !== "http:"
          ) {
            throw new Error("unsupported protocol");
          }
        } catch {
          throw new Error(
            `dependency.exceptions[${index}].url must be an HTTP(S) URL.`,
          );
        }
        return { name, version, url, reason };
      })
    : [];
  return {
    files: Array.isArray(record.files)
      ? record.files.filter((item): item is string => typeof item === "string")
      : [],
    licenses: Array.isArray(record.licenses)
      ? record.licenses.flatMap((item) => {
          const entry = asRecord(item);
          if (
            typeof entry.name !== "string" ||
            typeof entry.license !== "string"
          )
            return [];
          return [
            {
              name: entry.name,
              version:
                typeof entry.version === "string" ? entry.version : undefined,
              license: entry.license,
            },
          ];
        })
      : [],
    threshold:
      typeof record.threshold === "number" ? record.threshold : undefined,
    excludes: Array.isArray(record.excludes)
      ? record.excludes.flatMap((item) => {
          const entry = asRecord(item);
          if (typeof entry.name !== "string") return [];
          return [
            {
              name: entry.name,
              version:
                typeof entry.version === "string" ? entry.version : undefined,
              recursive: entry.recursive === true,
            },
          ];
        })
      : [],
    exceptions,
    require_fsf_free: record.require_fsf_free === true,
    require_osi_approved: record.require_osi_approved === true,
  };
}

export function loadConfig(
  root: string,
  configPath: string,
): { config: LicenseEyeConfig; path: string } {
  const absolutePath = resolve(root, configPath);
  if (!existsSync(absolutePath))
    throw new Error(`Configuration file not found: ${configPath}`);

  const source = readFileSync(absolutePath, "utf8");
  const parsed = asRecord(parse(source));
  const config: LicenseEyeConfig = {
    header: normalizeHeader(parsed.header),
    dependency: normalizeDependencies(parsed.dependency),
  };

  if (!config.header && !config.dependency) {
    throw new Error(
      `Configuration contains neither a header nor dependency section: ${configPath}`,
    );
  }
  return { config, path: absolutePath };
}

export function headerRules(config: LicenseEyeConfig): HeaderRule[] {
  if (!config.header) return [];
  return Array.isArray(config.header) ? config.header : [config.header];
}
