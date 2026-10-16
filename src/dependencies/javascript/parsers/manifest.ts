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
import type { Dependency } from "../../../types.js";
import { isFile, readJson } from "../../../util.js";
import type { DependencyCheckContext } from "../../checker.js";
import type { PackageJson } from "./package-json.js";
import { addPackageJsonDependencies, parseNpmLock } from "./npm-lock.js";
import { parseYarnLock } from "./yarn-lock.js";
import { parsePnpmLock } from "./pnpm-lock.js";

type ManifestParser = (
  manifest: string,
  path: string,
  dependencies: Dependency[],
  includeDevDependencies?: boolean,
) => void;

function parsePackageJsonManifest(
  manifest: string,
  absolute: string,
  dependencies: Dependency[],
  includeDevDependencies: boolean,
): void {
  const packageJson = readJson(absolute) as PackageJson | undefined;
  if (!packageJson) {
    dependencies.push({
      name: "(invalid package.json)",
      version: "unresolved",
      ecosystem: "npm",
      manifest,
      versionResolved: false,
      versionResolutionError: "Could not parse package.json dependencies.",
    });
    return;
  }
  parsePackageJsonLocks(
    manifest,
    absolute,
    dependencies,
    packageJson,
    includeDevDependencies,
  );
}

function parsePackageJsonLocks(
  manifest: string,
  absolute: string,
  dependencies: Dependency[],
  packageJson: PackageJson,
  includeDevDependencies: boolean,
): void {
  const lockParsers: Record<string, (lockPath: string) => void> = {
    "package-lock.json": (lockPath) =>
      parseNpmLock(
        manifest,
        lockPath,
        lockDependencies,
        includeDevDependencies,
      ),
    "npm-shrinkwrap.json": (lockPath) =>
      parseNpmLock(
        manifest,
        lockPath,
        lockDependencies,
        includeDevDependencies,
      ),
    "yarn.lock": (lockPath) =>
      parseYarnLock(
        manifest,
        lockPath,
        lockDependencies,
        packageJson,
        includeDevDependencies,
      ),
    "pnpm-lock.yaml": (lockPath) =>
      parsePnpmLock(
        manifest,
        lockPath,
        lockDependencies,
        includeDevDependencies,
      ),
  };
  const lockFiles: string[] = [];
  const lockDependencies: Dependency[] = [];
  for (const [lockName, parser] of Object.entries(lockParsers)) {
    const lockPath = join(dirname(absolute), lockName);
    if (!isFile(lockPath)) continue;
    lockFiles.push(lockName);
    parser(lockPath);
  }
  if (lockFiles.length === 0) {
    addPackageJsonDependencies(
      dependencies,
      manifest,
      packageJson,
      includeDevDependencies,
    );
    return;
  }
  dependencies.push(...lockDependencies);
  if (lockFiles.length > 1) {
    dependencies.push({
      name: "(ambiguous JavaScript lockfiles)",
      version: "unresolved",
      ecosystem: "npm",
      manifest,
      versionResolved: false,
      versionResolutionError: `Multiple supported lockfiles found: ${lockFiles.join(", ")}.`,
    });
  }
  appendMissingPackageJsonLockEntries(
    manifest,
    dependencies,
    packageJson,
    includeDevDependencies,
    lockFiles,
    lockDependencies,
  );
}

function appendMissingPackageJsonLockEntries(
  manifest: string,
  dependencies: Dependency[],
  packageJson: PackageJson,
  includeDevDependencies: boolean,
  lockFiles: string[],
  lockDependencies: Dependency[],
): void {
  const lockedNames = new Set(
    lockDependencies.map((dependency) => dependency.name),
  );
  const sections = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    ...(includeDevDependencies ? (["devDependencies"] as const) : []),
  ] as const;
  for (const section of sections) {
    for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
      const aliasTarget = version.startsWith("npm:")
        ? parseNpmAliasName(version.slice("npm:".length))
        : undefined;
      if (
        version.startsWith("workspace:") ||
        lockedNames.has(name) ||
        (aliasTarget !== undefined && lockedNames.has(aliasTarget))
      )
        continue;
      dependencies.push({
        name,
        version,
        ecosystem: "npm",
        manifest,
        versionResolved: false,
        versionResolutionError: `The dependency is missing from ${lockFiles.join(", ")}.`,
      });
    }
  }
}

function parseNpmAliasName(value: string): string | undefined {
  const separator = value.startsWith("@")
    ? value.indexOf("@", value.indexOf("/") + 1)
    : value.indexOf("@");
  return separator > 0 ? value.slice(0, separator) : undefined;
}

export function collectJavaScriptDependencies(
  context: DependencyCheckContext,
): Dependency[] {
  const { path, absolutePath, dependencyConfig } = context;
  const dependencies: Dependency[] = [];
  const includeDevDependencies =
    dependencyConfig.includeDevDependencies === true;
  const basename = path.split("/").pop() ?? path;
  if (basename === "package.json") {
    parsePackageJsonManifest(
      path,
      absolutePath,
      dependencies,
      includeDevDependencies,
    );
    return dependencies;
  }
  const parser: ManifestParser =
    basename === "package-lock.json" || basename === "npm-shrinkwrap.json"
      ? parseNpmLock
      : basename === "pnpm-lock.yaml"
        ? parsePnpmLock
        : (manifest, lockPath, output, includeDev) => {
            const packageJson = readJson(
              join(dirname(lockPath), "package.json"),
            ) as PackageJson | undefined;
            parseYarnLock(
              manifest,
              lockPath,
              output,
              packageJson ?? {},
              includeDev === true,
            );
          };
  parser(path, absolutePath, dependencies, includeDevDependencies);
  return dependencies;
}
