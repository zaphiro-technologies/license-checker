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
import { dirname, join } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import type { Dependency } from "../../../types.js";
import { isFile } from "../../../util.js";
import type { DependencyCheckContext } from "../../checker.js";
import { parsePipfileLock, parsePoetryLock } from "./lockfiles.js";
import { parseRequirements } from "./requirements.js";

interface PyprojectData {
  project?: { dependencies?: unknown };
  "dependency-groups"?: Record<string, unknown>;
  tool?: {
    poetry?: {
      dependencies?: Record<string, unknown>;
      "dev-dependencies"?: Record<string, unknown>;
      group?: Record<string, { dependencies?: Record<string, unknown> }>;
    };
  };
}

function appendUnresolvedPythonDependency(
  manifest: string,
  dependency: { name: string; version: string },
  dependencies: Dependency[],
): void {
  dependencies.push({
    ...dependency,
    ecosystem: "python",
    manifest,
    versionResolved: false,
    versionResolutionError:
      "A supported Python lockfile or fully pinned requirements file is required.",
  });
}

function collectPyprojectGroup(
  entries: unknown,
  output: Array<{ name: string; version: string }>,
): void {
  if (Array.isArray(entries)) {
    for (const value of entries) {
      if (typeof value !== "string") continue;
      const name = /^[A-Za-z0-9][A-Za-z0-9_.-]*/.exec(value)?.[0];
      if (name)
        output.push({ name, version: value.slice(name.length).trim() || "*" });
    }
    return;
  }
  if (!entries || typeof entries !== "object") return;
  for (const [name, value] of Object.entries(
    entries as Record<string, unknown>,
  )) {
    let version = "*";
    if (typeof value === "string") version = value;
    else if (
      value &&
      typeof value === "object" &&
      typeof (value as { version?: unknown }).version === "string"
    ) {
      version = (value as { version: string }).version;
    }
    output.push({ name, version });
  }
}

function appendPyprojectDevelopmentDependencies(
  manifest: string,
  parsed: PyprojectData,
  dependencies: Dependency[],
): void {
  const requirements: Array<{ name: string; version: string }> = [];
  collectPyprojectGroup(parsed["dependency-groups"]?.dev, requirements);
  collectPyprojectGroup(
    parsed.tool?.poetry?.["dev-dependencies"],
    requirements,
  );
  for (const [groupName, group] of Object.entries(
    parsed.tool?.poetry?.group ?? {},
  )) {
    if (groupName !== "main")
      collectPyprojectGroup(group.dependencies, requirements);
  }
  for (const requirement of requirements) {
    appendUnresolvedPythonDependency(manifest, requirement, dependencies);
  }
}

function parsePyproject(
  manifest: string,
  path: string,
  dependencies: Dependency[],
  includeDevDependencies: boolean,
): void {
  let parsed: PyprojectData;
  try {
    parsed = parseToml(readFileSync(path, "utf8")) as PyprojectData;
  } catch {
    dependencies.push({
      name: "(invalid pyproject.toml)",
      version: "unresolved",
      ecosystem: "python",
      manifest,
      versionResolved: false,
      versionResolutionError: "Could not parse pyproject.toml dependencies.",
    });
    return;
  }

  const projectDependencies = parsed.project?.dependencies;
  if (Array.isArray(projectDependencies)) {
    for (const value of projectDependencies) {
      if (typeof value !== "string") continue;
      const nameMatch = /^[A-Za-z0-9][A-Za-z0-9_.-]*/.exec(value);
      if (!nameMatch) continue;
      appendUnresolvedPythonDependency(
        manifest,
        {
          name: nameMatch[0],
          version: value.slice(nameMatch[0].length).trim() || "*",
        },
        dependencies,
      );
    }
  }

  for (const [name, value] of Object.entries(
    parsed.tool?.poetry?.dependencies ?? {},
  )) {
    if (name.toLowerCase() === "python" || typeof value !== "string") continue;
    appendUnresolvedPythonDependency(
      manifest,
      { name, version: value },
      dependencies,
    );
  }

  if (includeDevDependencies)
    appendPyprojectDevelopmentDependencies(manifest, parsed, dependencies);
}

function parsePyprojectManifest(
  manifest: string,
  path: string,
  dependencies: Dependency[],
  includeDevDependencies: boolean,
): void {
  const poetryLockPath = join(dirname(path), "poetry.lock");
  if (isFile(poetryLockPath)) {
    if (
      parsePoetryLock(
        manifest,
        poetryLockPath,
        dependencies,
        includeDevDependencies,
      )
    )
      return;
    dependencies.push({
      name: "(invalid poetry.lock)",
      version: "unresolved",
      ecosystem: "python",
      manifest,
      versionResolved: false,
      versionResolutionError: "Could not parse the adjacent poetry.lock.",
    });
  }
  parsePyproject(manifest, path, dependencies, includeDevDependencies);
}

export function collectPythonDependencies(
  context: DependencyCheckContext,
): Dependency[] {
  const { path, absolutePath, dependencyConfig } = context;
  const dependencies: Dependency[] = [];
  const includeDevDependencies =
    dependencyConfig.includeDevDependencies === true;
  const basename = path.split("/").pop() ?? path;
  if (basename === "pyproject.toml") {
    parsePyprojectManifest(
      path,
      absolutePath,
      dependencies,
      includeDevDependencies,
    );
    return dependencies;
  }
  if (basename === "poetry.lock") {
    if (
      !parsePoetryLock(path, absolutePath, dependencies, includeDevDependencies)
    ) {
      dependencies.push({
        name: "(invalid poetry.lock)",
        version: "unresolved",
        ecosystem: "python",
        manifest: path,
        versionResolved: false,
        versionResolutionError: "Could not parse poetry.lock.",
      });
    }
    return dependencies;
  }
  if (basename === "Pipfile.lock") {
    parsePipfileLock(path, absolutePath, dependencies, includeDevDependencies);
    return dependencies;
  }
  parseRequirements(path, absolutePath, dependencies);
  return dependencies;
}
