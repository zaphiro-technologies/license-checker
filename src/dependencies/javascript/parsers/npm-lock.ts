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

import type { Dependency } from "../../../types.js";
import { readJson } from "../../../util.js";
import { packageLicense, type PackageJson } from "./package-json.js";

export function npmVersionIsExact(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    version,
  );
}

export function addPackageJsonDependencies(
  dependencies: Dependency[],
  manifest: string,
  packageJson: PackageJson,
  includeDevDependencies: boolean,
): void {
  const sections = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    ...(includeDevDependencies ? (["devDependencies"] as const) : []),
  ] as const;
  for (const section of sections) {
    for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
      dependencies.push({
        name,
        version,
        ecosystem: "npm",
        manifest,
        versionResolved: false,
        versionResolutionError: "A supported npm lockfile is required.",
      });
    }
  }
}

export function parseNpmLock(
  manifest: string,
  lockPath: string,
  dependencies: Dependency[],
  includeDevDependencies = false,
): void {
  const lock = readJson(lockPath) as
    | {
        packages?: Record<string, Record<string, unknown>>;
        dependencies?: Record<string, Record<string, unknown>>;
      }
    | undefined;
  if (!lock) {
    dependencies.push({
      name: "(invalid npm lockfile)",
      version: "unresolved",
      ecosystem: "npm",
      manifest,
      versionResolved: false,
      versionResolutionError: `Could not parse ${lockPath}.`,
    });
    return;
  }

  if (lock.packages) {
    for (const [location, value] of Object.entries(lock.packages)) {
      if (!location.startsWith("node_modules/")) continue;
      if (!includeDevDependencies && value.dev === true) continue;
      const name = location.slice(
        location.lastIndexOf("node_modules/") + "node_modules/".length,
      );
      const version = typeof value.version === "string" ? value.version : "*";
      dependencies.push({
        name,
        version,
        ecosystem: "npm",
        manifest,
        versionResolved: npmVersionIsExact(version),
        rawLicense: packageLicense(value.license ?? value.licenses),
      });
    }
  }

  const visitLegacy = (
    entries: Record<string, Record<string, unknown>>,
  ): void => {
    for (const [name, value] of Object.entries(entries)) {
      if (!includeDevDependencies && value.dev === true) continue;
      dependencies.push({
        name,
        version: typeof value.version === "string" ? value.version : "*",
        ecosystem: "npm",
        manifest,
        versionResolved:
          typeof value.version === "string" && npmVersionIsExact(value.version),
        rawLicense: packageLicense(value.license ?? value.licenses),
      });
      if (value.dependencies && typeof value.dependencies === "object") {
        visitLegacy(
          value.dependencies as Record<string, Record<string, unknown>>,
        );
      }
    }
  };
  if (lock.dependencies) visitLegacy(lock.dependencies);
}
