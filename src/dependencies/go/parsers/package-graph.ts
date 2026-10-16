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

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Dependency } from "../../../types.js";
import type {
  DependencyCheckContext,
  GoPackageListRunner,
} from "../../checker.js";

function goExecutablePath(): string {
  const executable = process.platform === "win32" ? "go.exe" : "go";
  const goRoot = process.env.GOROOT;
  const runnerGoRoot = process.env.RUNNER_TOOL_CACHE
    ? join(process.env.RUNNER_TOOL_CACHE, "go")
    : undefined;
  const cachedPathCandidates = runnerGoRoot
    ? (process.env.PATH ?? "")
        .split(delimiter)
        .filter((directory) => isAbsolute(directory))
        .map((directory) => join(directory, executable))
        .filter((candidate) => {
          const relativeCandidate = relative(
            resolve(runnerGoRoot),
            resolve(candidate),
          );
          return (
            relativeCandidate !== "" &&
            relativeCandidate !== ".." &&
            !relativeCandidate.startsWith(`..${sep}`) &&
            !isAbsolute(relativeCandidate)
          );
        })
    : [];
  const candidates = [
    goRoot && isAbsolute(goRoot) ? join(goRoot, "bin", executable) : undefined,
    ...cachedPathCandidates,
    ...(process.platform === "win32"
      ? [String.raw`C:\Program Files\Go\bin\go.exe`]
      : [
          "/usr/local/go/bin/go",
          "/usr/local/bin/go",
          "/opt/homebrew/bin/go",
          "/usr/bin/go",
        ]),
  ];
  const executablePath = candidates.find(
    (candidate) => candidate && existsSync(candidate),
  );
  if (!executablePath) {
    throw new Error(
      "Could not locate Go; set GOROOT or install Go in a standard location.",
    );
  }
  return executablePath;
}

export function systemGoPackageList(
  moduleDirectory: string,
  packages: string[],
  includeTests: boolean,
): string {
  return execFileSync(
    goExecutablePath(),
    [
      "list",
      "-mod=readonly",
      "-deps",
      "-json",
      ...(includeTests ? ["-test"] : []),
      ...packages,
    ],
    { cwd: moduleDirectory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

interface GoJSONState {
  start: number;
  depth: number;
  inString: boolean;
  escaped: boolean;
}

function updateGoJSONState(character: string, state: GoJSONState): boolean {
  if (state.start < 0) return false;
  if (state.inString) {
    if (state.escaped) state.escaped = false;
    else if (character === "\\") state.escaped = true;
    else if (character === '"') state.inString = false;
    return false;
  }
  if (character === '"') state.inString = true;
  else if (character === "{") state.depth++;
  else if (character === "}") state.depth--;
  return state.depth === 0;
}

function appendGoObject(
  output: string,
  start: number,
  end: number,
  objects: Record<string, unknown>[],
): void {
  const parsed: unknown = JSON.parse(output.slice(start, end + 1));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    objects.push(parsed as Record<string, unknown>);
  }
}

function parseGoPackageObjects(output: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const state: GoJSONState = {
    start: -1,
    depth: 0,
    inString: false,
    escaped: false,
  };
  for (let index = 0; index < output.length; index++) {
    const character = output[index];
    if (state.start < 0) {
      if (character === "{") {
        state.start = index;
        state.depth = 1;
      }
      continue;
    }
    if (!updateGoJSONState(character, state)) continue;
    appendGoObject(output, state.start, index, objects);
    state.start = -1;
  }
  if (state.start >= 0) throw new Error("Go returned incomplete package JSON.");
  return objects;
}

function goModuleDependency(
  manifest: string,
  packageObject: Record<string, unknown>,
): Dependency | undefined {
  const module = packageObject.Module as
    | {
        Path?: unknown;
        Version?: unknown;
        Main?: unknown;
        Replace?: unknown;
      }
    | undefined;
  if (!module || module.Main === true || typeof module.Path !== "string")
    return undefined;
  const name = module.Path;
  const version = typeof module.Version === "string" ? module.Version : "";
  const replaced = Boolean(module.Replace);
  const versionResolved =
    !replaced && /^v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version);
  let versionResolutionError: string | undefined;
  if (replaced) {
    versionResolutionError =
      "The Go module is replaced; its effective source version is not established.";
  } else if (!versionResolved) {
    versionResolutionError =
      "The Go package graph did not provide an exact module version.";
  }
  return {
    name,
    version: version || "unresolved",
    ecosystem: "go",
    manifest,
    versionResolved,
    versionResolutionError,
  };
}

function addGoGraphFailure(
  manifest: string,
  dependencies: Dependency[],
  message: string,
): void {
  dependencies.push({
    name: "(Go package graph)",
    version: "unresolved",
    ecosystem: "go",
    manifest,
    versionResolved: false,
    versionResolutionError: message,
  });
}

function parseGoPackages(
  manifest: string,
  moduleDirectory: string,
  packages: string[],
  includeTests: boolean,
  dependencies: Dependency[],
  goPackageList: GoPackageListRunner,
): void {
  if (!packages.length) return;
  let output: string;
  try {
    output = goPackageList(moduleDirectory, packages, includeTests);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.split("\n")[0] : String(error);
    addGoGraphFailure(
      manifest,
      dependencies,
      `Unable to resolve Go packages ${packages.join(", ")}${includeTests ? " including tests" : ""}: ${detail}`,
    );
    return;
  }

  let packageObjects: Record<string, unknown>[];
  try {
    packageObjects = parseGoPackageObjects(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    addGoGraphFailure(
      manifest,
      dependencies,
      `Unable to parse Go package data: ${detail}`,
    );
    return;
  }
  if (!packageObjects.length) {
    addGoGraphFailure(
      manifest,
      dependencies,
      `Go returned no package data for ${packages.join(", ")}.`,
    );
    return;
  }
  const modules = new Map<string, Dependency>();
  for (const packageObject of packageObjects) {
    const dependency = goModuleDependency(manifest, packageObject);
    if (dependency) modules.set(dependency.name, dependency);
  }
  dependencies.push(...modules.values());
}

export function collectGoDependencies(
  context: DependencyCheckContext,
): Dependency[] {
  const { path, absolutePath, dependencyConfig, goPackageList } = context;
  const dependencies: Dependency[] = [];
  const basename = path.split("/").pop() ?? path;
  if (basename === "go.sum") {
    const adjacentModule = join(dirname(path), "go.mod").replaceAll("\\", "/");
    const configuredPaths = (dependencyConfig.files ?? []).map((file) =>
      file.replaceAll("\\", "/"),
    );
    if (!configuredPaths.includes(adjacentModule)) {
      dependencies.push({
        name: "(Go module graph)",
        version: "unresolved",
        ecosystem: "go",
        manifest: path,
        versionResolved: false,
        versionResolutionError:
          "go.sum contains checksums, not the selected module graph; configure the adjacent go.mod.",
      });
    }
    return dependencies;
  }
  if (basename !== "go.mod") return dependencies;
  const packages = dependencyConfig.go?.packages?.length
    ? dependencyConfig.go.packages
    : ["./..."];
  parseGoPackages(
    path,
    dirname(absolutePath),
    packages,
    false,
    dependencies,
    goPackageList,
  );
  if (dependencyConfig.includeDevDependencies === true) {
    parseGoPackages(
      path,
      dirname(absolutePath),
      packages,
      true,
      dependencies,
      goPackageList,
    );
  }
  return dependencies;
}
