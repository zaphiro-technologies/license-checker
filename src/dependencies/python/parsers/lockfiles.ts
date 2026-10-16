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

import { readFileSync } from "node:fs";
import { parse as parseToml } from "@iarna/toml";
import type { Dependency } from "../../../types.js";
import { readJson } from "../../../util.js";
import { pythonVersionIsExact } from "./version.js";

export function parsePoetryLock(
  manifest: string,
  path: string,
  dependencies: Dependency[],
  includeDevDependencies: boolean,
): boolean {
  try {
    const lock = parseToml(readFileSync(path, "utf8")) as {
      package?: Array<{
        name?: string;
        version?: string;
        category?: string;
        groups?: string[];
      }>;
    };
    for (const entry of lock.package ?? []) {
      const isDevOnly =
        entry.category === "dev" ||
        (Array.isArray(entry.groups) &&
          entry.groups.length > 0 &&
          !entry.groups.includes("main"));
      if (!includeDevDependencies && isDevOnly) continue;
      if (entry.name)
        dependencies.push({
          name: entry.name,
          version: entry.version ?? "*",
          ecosystem: "python",
          manifest,
          versionResolved:
            typeof entry.version === "string" &&
            pythonVersionIsExact(entry.version),
          versionResolutionError:
            typeof entry.version === "string" &&
            pythonVersionIsExact(entry.version)
              ? undefined
              : "The Poetry lock entry has no exact version.",
        });
    }
    return true;
  } catch {
    // An invalid lockfile is reported by the package manager; do not make the action crash here.
    return false;
  }
}

export function parsePipfileLock(
  manifest: string,
  path: string,
  dependencies: Dependency[],
  includeDevDependencies = false,
): void {
  const lock = readJson(path) as
    | {
        default?: Record<string, { version?: string }>;
        develop?: Record<string, { version?: string }>;
      }
    | undefined;
  if (!lock) {
    dependencies.push({
      name: "(invalid Pipfile.lock)",
      version: "unresolved",
      ecosystem: "python",
      manifest,
      versionResolved: false,
      versionResolutionError: "Could not parse Pipfile.lock.",
    });
    return;
  }
  for (const section of [
    lock?.default,
    ...(includeDevDependencies ? [lock?.develop] : []),
  ]) {
    for (const [name, value] of Object.entries(section ?? {})) {
      const versionIsExact =
        typeof value.version === "string" &&
        value.version.startsWith("==") &&
        pythonVersionIsExact(value.version.slice(2));
      dependencies.push({
        name,
        version: value.version?.replace(/^==/, "") ?? "*",
        ecosystem: "python",
        manifest,
        versionResolved: versionIsExact,
        versionResolutionError: versionIsExact
          ? undefined
          : "The Pipfile lock entry has no exact version.",
      });
    }
  }
}
