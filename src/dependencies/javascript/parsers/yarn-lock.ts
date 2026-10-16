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
import { minimatch } from "minimatch";
import type { Dependency } from "../../../types.js";
import type { PackageJson } from "./package-json.js";
import { npmVersionIsExact } from "./npm-lock.js";

interface YarnDescriptor {
  name: string;
  range: string;
}

interface YarnEntry {
  descriptors: YarnDescriptor[];
  name: string;
  version: string;
  workspace: boolean;
  dependencies: YarnDescriptor[];
}

function parseYarnDescriptor(value: string): YarnDescriptor | undefined {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "");
  const separator = normalized.startsWith("@")
    ? normalized.indexOf("@", normalized.indexOf("/") + 1)
    : normalized.indexOf("@");
  if (separator <= 0) return undefined;
  return {
    name: normalized.slice(0, separator),
    range: normalized.slice(separator + 1),
  };
}

function unquoteYarn(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function parseYarnVersion(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("version")) return undefined;
  let value = trimmed.slice("version".length).trimStart();
  if (value.startsWith(":")) value = value.slice(1).trimStart();
  value = value.replace(/^['"]/, "");
  const end = [...value].findIndex((character) => /['"\s]/.test(character));
  return value.slice(0, end < 0 ? value.length : end);
}

function yarnEntryFromSelectorLine(line: string): YarnEntry {
  const selectors = line.slice(0, -1).trim().split(/,\s*/);
  const descriptors = selectors
    .map(parseYarnDescriptor)
    .filter((item): item is YarnDescriptor => item !== undefined);
  const aliasName = descriptors
    .map((descriptor) =>
      descriptor.range.startsWith("npm:")
        ? parseYarnDescriptor(descriptor.range.slice(4))?.name
        : undefined,
    )
    .find((name): name is string => name !== undefined);
  return {
    descriptors,
    name: aliasName ?? descriptors[0]?.name ?? "",
    version: "*",
    workspace: selectors.some((item) => item.includes("@workspace:")),
    dependencies: [],
  };
}

function parseYarnEntryLine(
  line: string,
  entry: YarnEntry,
  dependencySection: boolean,
): boolean {
  const trimmed = line.trimStart();
  const indentation = line.length - trimmed.length;
  if (indentation === 2) {
    if (trimmed === "dependencies:" || trimmed === "optionalDependencies:")
      return true;
    const version = parseYarnVersion(line);
    if (version) entry.version = version;
    if (!trimmed.startsWith("resolution:")) return false;
    const resolution = unquoteYarn(trimmed.slice("resolution:".length));
    const locator = resolution.indexOf("@npm:");
    if (locator >= 0) {
      const target = parseYarnDescriptor(resolution.slice(locator + 5));
      if (target) entry.name = target.name;
    }
    if (resolution.includes("@workspace:")) entry.workspace = true;
    return false;
  }
  if (indentation <= 2) return false;
  if (indentation === 3) return dependencySection;
  if (!dependencySection) return false;
  const colon = trimmed.indexOf(":");
  const separator = colon > 0 ? colon : trimmed.search(/\s/);
  if (separator <= 0) return dependencySection;
  const descriptor = parseYarnDescriptor(
    `${unquoteYarn(trimmed.slice(0, separator))}@${unquoteYarn(trimmed.slice(separator + 1))}`,
  );
  if (descriptor) entry.dependencies.push(descriptor);
  return true;
}

function parseYarnLockEntries(lockText: string): YarnEntry[] {
  const entries: YarnEntry[] = [];
  let current: YarnEntry | undefined;
  let dependencySection = false;
  for (const line of lockText.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t") && line.endsWith(":")) {
      if (current) entries.push(current);
      current = yarnEntryFromSelectorLine(line);
      dependencySection = false;
      continue;
    }
    if (current)
      dependencySection = parseYarnEntryLine(line, current, dependencySection);
  }
  if (current) entries.push(current);
  return entries;
}

export function parseYarnLock(
  manifest: string,
  lockPath: string,
  dependencies: Dependency[],
  packageJson: PackageJson,
  includeDevDependencies: boolean,
): void {
  const entries = parseYarnLockEntries(readFileSync(lockPath, "utf8"));
  if (includeDevDependencies) {
    appendAllYarnEntries(manifest, entries, dependencies);
    return;
  }
  const graph = collectYarnDependencyGraph(entries, packageJson);
  appendYarnGraphResults(manifest, graph, dependencies);
}

function appendAllYarnEntries(
  manifest: string,
  entries: YarnEntry[],
  dependencies: Dependency[],
): void {
  for (const entry of entries) {
    if (entry.workspace || !entry.name) continue;
    dependencies.push({
      name: entry.name,
      version: entry.version,
      ecosystem: "npm",
      manifest,
      versionResolved: npmVersionIsExact(entry.version),
    });
  }
}

function findYarnEntry(
  entries: YarnEntry[],
  descriptor: YarnDescriptor,
): YarnEntry | undefined {
  return entries.find(
    (entry) =>
      !entry.workspace &&
      entry.descriptors.some(
        (candidate) =>
          candidate.name === descriptor.name &&
          candidate.range.replace(/^npm:/, "") ===
            descriptor.range.replace(/^npm:/, ""),
      ),
  );
}

function resolveYarnEntry(
  entries: YarnEntry[],
  descriptor: YarnDescriptor,
  parentName: string | undefined,
  resolutions: Record<string, string>,
): YarnEntry | undefined {
  const dependencyPath = parentName
    ? `${parentName}/${descriptor.name}`
    : descriptor.name;
  const resolution = Object.entries(resolutions).find(
    ([pattern]) =>
      pattern === descriptor.name ||
      minimatch(dependencyPath, pattern, { dot: true }),
  );
  if (!resolution) return findYarnEntry(entries, descriptor);
  return findYarnEntry(entries, {
    name: descriptor.name,
    range: resolution[1].replace(/^npm:/, ""),
  });
}

function yarnRootDependencies(
  packageJson: PackageJson,
): Array<YarnDescriptor & { parentName?: string }> {
  const sections = [
    packageJson.dependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ];
  return sections.flatMap((section) =>
    Object.entries(section ?? {}).map(([name, range]) => ({
      name,
      range,
      parentName: packageJson.name,
    })),
  );
}

function collectYarnDependencyGraph(
  entries: YarnEntry[],
  packageJson: PackageJson,
): { visited: Set<YarnEntry>; unresolved: Set<string> } {
  const pending = yarnRootDependencies(packageJson);
  const visited = new Set<YarnEntry>();
  const unresolved = new Set<string>();
  while (pending.length > 0) {
    const descriptor = pending.pop();
    if (!descriptor || /^(workspace:|file:|link:)/.test(descriptor.range))
      continue;
    const entry = resolveYarnEntry(
      entries,
      descriptor,
      descriptor.parentName,
      packageJson.resolutions ?? {},
    );
    if (!entry) {
      unresolved.add(`${descriptor.name}@${descriptor.range}`);
      continue;
    }
    if (visited.has(entry)) continue;
    visited.add(entry);
    pending.push(
      ...entry.dependencies.map((dependency) => ({
        ...dependency,
        parentName: entry.name,
      })),
    );
  }
  return { visited, unresolved };
}

function appendYarnGraphResults(
  manifest: string,
  graph: { visited: Set<YarnEntry>; unresolved: Set<string> },
  dependencies: Dependency[],
): void {
  for (const entry of graph.visited) {
    dependencies.push({
      name: entry.name,
      version: entry.version,
      ecosystem: "npm",
      manifest,
      versionResolved: npmVersionIsExact(entry.version),
    });
  }
  if (graph.unresolved.size === 0) return;
  dependencies.push({
    name: "(incomplete Yarn dependency graph)",
    version: "unresolved",
    ecosystem: "npm",
    manifest,
    versionResolved: false,
    versionResolutionError: `Yarn lock entries not found for ${[...graph.unresolved].join(", ")}.`,
  });
}
