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
import { parse as parseYaml } from "yaml";
import type { Dependency } from "../../../types.js";
import { npmVersionIsExact } from "./npm-lock.js";

function packageFromLockKey(
  key: string,
): { name: string; version: string } | undefined {
  const normalized = key.replace(/^\//, "").replace(/^npm:/, "");
  const scopedSlash = /^(@[^/]+\/[^/]+)\/(.+)$/.exec(normalized);
  if (scopedSlash)
    return { name: scopedSlash[1], version: scopedSlash[2].split("(")[0] };
  const plainSlash = /^([^/@]+)\/(.+)$/.exec(normalized);
  if (plainSlash)
    return { name: plainSlash[1], version: plainSlash[2].split("(")[0] };
  const scoped = /^(@[^/]+\/[^@]+)@(.+)$/.exec(normalized);
  if (scoped) return { name: scoped[1], version: scoped[2].split("(")[0] };
  const plain = /^([^@/]+)@(.+)$/.exec(normalized);
  return plain
    ? { name: plain[1], version: plain[2].split("(")[0] }
    : undefined;
}

type PnpmEntries = Record<string, Record<string, unknown>>;

function appendAllPnpmEntries(
  manifest: string,
  parsed: Record<string, unknown>,
  dependencies: Dependency[],
): void {
  for (const section of ["packages", "snapshots"]) {
    const entries = parsed[section];
    if (!entries || typeof entries !== "object") continue;
    for (const key of Object.keys(entries as Record<string, unknown>)) {
      const packageInfo = packageFromLockKey(key);
      if (!packageInfo) continue;
      dependencies.push({
        ...packageInfo,
        ecosystem: "npm",
        manifest,
        versionResolved: npmVersionIsExact(packageInfo.version),
      });
    }
  }
}

function getPnpmRootImporter(
  parsed: Record<string, unknown>,
  importers: PnpmEntries,
): Record<string, unknown> | undefined {
  if (importers["."]) return importers["."];
  if (!parsed.dependencies && !parsed.optionalDependencies) return undefined;
  return {
    dependencies: parsed.dependencies,
    optionalDependencies: parsed.optionalDependencies,
    peerDependencies: parsed.peerDependencies,
    devDependencies: parsed.devDependencies,
  };
}

function normalizePnpmVersion(version: string): string {
  return version.split("(")[0].replace(/^\//, "");
}

function pnpmDependencyVersion(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const version = (value as { version?: unknown }).version;
    if (typeof version === "string") return version;
  }
  return "";
}

function pnpmDependencyRoots(
  rootImporter: Record<string, unknown>,
  includeDevDependencies: boolean,
): Array<{ name: string; version: string }> {
  const sections = [
    rootImporter.dependencies,
    rootImporter.optionalDependencies,
    rootImporter.peerDependencies,
    ...(includeDevDependencies ? [rootImporter.devDependencies] : []),
  ];
  const roots: Array<{ name: string; version: string }> = [];
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    for (const [name, value] of Object.entries(section)) {
      const version = pnpmDependencyVersion(value);
      if (version && !/^(link:|workspace:|file:)/.test(version))
        roots.push({ name, version });
    }
  }
  return roots;
}

function pnpmLockEntries(
  packages: PnpmEntries,
  snapshots: PnpmEntries,
): Map<
  string,
  { name: string; version: string; value: Record<string, unknown> }
> {
  const entries = new Map<
    string,
    { name: string; version: string; value: Record<string, unknown> }
  >();
  for (const [key, value] of Object.entries({ ...packages, ...snapshots })) {
    const info = packageFromLockKey(key);
    if (!info) continue;
    entries.set(`${info.name}@${normalizePnpmVersion(info.version)}`, {
      ...info,
      value,
    });
  }
  return entries;
}

function enqueuePnpmDependencies(
  value: Record<string, unknown>,
  pending: Array<{ name: string; version: string }>,
): void {
  for (const sectionName of ["dependencies", "optionalDependencies"]) {
    const section = value[sectionName];
    if (!section || typeof section !== "object") continue;
    for (const [name, dependency] of Object.entries(section)) {
      const version = typeof dependency === "string" ? dependency : "";
      if (version && !/^(link:|workspace:|file:)/.test(version))
        pending.push({ name, version });
    }
  }
}

function collectPnpmDependencyGraph(
  manifest: string,
  rootImporter: Record<string, unknown>,
  packages: PnpmEntries,
  snapshots: PnpmEntries,
  includeDevDependencies: boolean,
  dependencies: Dependency[],
): void {
  const pending = pnpmDependencyRoots(rootImporter, includeDevDependencies);
  const entries = pnpmLockEntries(packages, snapshots);
  const visited = new Set<string>();
  const unresolved = new Set<string>();
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (!dependency) continue;
    const key = `${dependency.name}@${normalizePnpmVersion(dependency.version)}`;
    const entry = entries.get(key);
    if (!entry) {
      unresolved.add(key);
      continue;
    }
    if (visited.has(key)) continue;
    visited.add(key);
    enqueuePnpmDependencies(
      snapshots[`${entry.name}@${entry.version}`] ?? entry.value,
      pending,
    );
  }
  appendPnpmGraphResults(manifest, visited, unresolved, entries, dependencies);
}

function appendPnpmGraphResults(
  manifest: string,
  visited: Set<string>,
  unresolved: Set<string>,
  entries: Map<
    string,
    { name: string; version: string; value: Record<string, unknown> }
  >,
  dependencies: Dependency[],
): void {
  for (const key of visited) {
    const entry = entries.get(key);
    if (!entry) continue;
    dependencies.push({
      name: entry.name,
      version: entry.version,
      ecosystem: "npm",
      manifest,
      versionResolved: npmVersionIsExact(entry.version),
    });
  }
  if (unresolved.size === 0) return;
  dependencies.push({
    name: "(incomplete pnpm dependency graph)",
    version: "unresolved",
    ecosystem: "npm",
    manifest,
    versionResolved: false,
    versionResolutionError: `pnpm lock entries not found for ${[...unresolved].join(", ")}.`,
  });
}

export function parsePnpmLock(
  manifest: string,
  lockPath: string,
  dependencies: Dependency[],
  includeDevDependencies = false,
): void {
  const parsed = parseYaml(readFileSync(lockPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (includeDevDependencies) {
    appendAllPnpmEntries(manifest, parsed, dependencies);
    return;
  }
  const packages = (parsed.packages ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const snapshots = (parsed.snapshots ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const importers = (parsed.importers ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const rootImporter = getPnpmRootImporter(parsed, importers);
  if (!rootImporter) {
    dependencies.push({
      name: "(incomplete pnpm dependency graph)",
      version: "unresolved",
      ecosystem: "npm",
      manifest,
      versionResolved: false,
      versionResolutionError:
        "The pnpm lockfile does not identify root dependency groups; enable dev dependencies or regenerate the lockfile.",
    });
    return;
  }
  collectPnpmDependencyGraph(
    manifest,
    rootImporter,
    packages,
    snapshots,
    includeDevDependencies,
    dependencies,
  );
}
