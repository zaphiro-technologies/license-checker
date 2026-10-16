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
import { parse as parseToml } from "@iarna/toml";
import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";
import { headerRules } from "./config.js";
import { Logger } from "./logger.js";
import {
  checkCompatibility,
  distributionWarningFor,
  normalizeLicenseExpression,
} from "./spdx.js";
import type {
  Dependency,
  DependencyConfig,
  DependencyReport,
  DependencyResult,
  LicenseEyeConfig,
} from "./types.js";
import { isFile, matchesPath, readJson, readText, uniqueBy } from "./util.js";

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: Array<{ type?: string }>;
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function packageLicense(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
  ) {
    return (value as { type: string }).type;
  }
  if (Array.isArray(value)) {
    const types = value
      .map((entry) =>
        entry && typeof entry === "object"
          ? (entry as { type?: unknown }).type
          : undefined,
      )
      .filter((entry): entry is string => typeof entry === "string");
    return types.length > 0 ? types.join(" AND ") : undefined;
  }
  return undefined;
}

function npmVersionIsExact(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    version,
  );
}

function pythonVersionIsExact(version: string): boolean {
  if (!version || version[0] < "0" || version[0] > "9") return false;
  for (const character of version) {
    if (
      (character >= "0" && character <= "9") ||
      (character >= "A" && character <= "Z") ||
      (character >= "a" && character <= "z") ||
      ".!+-".includes(character)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function addPackageJsonDependencies(
  dependencies: Dependency[],
  manifest: string,
  packageJson: PackageJson,
): void {
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
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

function parseNpmLock(
  manifest: string,
  lockPath: string,
  dependencies: Dependency[],
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

function parseYarnLock(
  manifest: string,
  lockPath: string,
  dependencies: Dependency[],
): void {
  const text = readFileSync(lockPath, "utf8");
  let names: string[] = [];
  let version = "*";
  let workspaceEntry = false;

  const flush = (): void => {
    if (!workspaceEntry) {
      for (const name of names)
        dependencies.push({
          name,
          version,
          ecosystem: "npm",
          manifest,
          versionResolved: npmVersionIsExact(version),
        });
    }
    names = [];
    version = "*";
    workspaceEntry = false;
  };

  const parseSelector = (selector: string): void => {
    for (const item of selector.split(",").map((value) => value.trim())) {
      const normalized = item.replace(/^['"]|['"]$/g, "");
      if (normalized.includes("@workspace:")) {
        workspaceEntry = true;
        continue;
      }
      const berryAlias = normalized.indexOf("@npm:");
      if (berryAlias > 0) {
        // A Berry descriptor such as `alias@npm:real-package@1.0.0`
        // installs the target package, rather than `alias`. Keep the
        // original name for ordinary descriptors like `foo@npm:^1.0.0`.
        const target = normalized.slice(berryAlias + "@npm:".length);
        const targetScoped = /^(@[^/]+\/[^@]+)@/.exec(target);
        const targetPlain = /^([^@/]+)@/.exec(target);
        names.push(
          targetScoped?.[1] ??
            targetPlain?.[1] ??
            normalized.slice(0, berryAlias),
        );
        continue;
      }
      const scoped = /^(@[^/]+\/[^@]+)@/.exec(normalized);
      const plain = /^([^@]+)@/.exec(normalized);
      const name = scoped?.[1] ?? plain?.[1];
      if (name) names.push(name);
    }
  };

  const versionFromLine = (line: string): string | undefined => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("version")) return undefined;
    let value = trimmed.slice("version".length).trimStart();
    if (value.startsWith(":")) value = value.slice(1).trimStart();
    value = value.replace(/^['"]/, "");
    const end = [...value].findIndex(
      (character) =>
        character === "'" ||
        character === '"' ||
        character === " " ||
        character === "\t",
    );
    return value.slice(0, end < 0 ? value.length : end);
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t") && line.endsWith(":")) {
      flush();
      parseSelector(line.slice(0, -1).trim());
    } else {
      const parsedVersion = versionFromLine(line);
      if (parsedVersion) version = parsedVersion;
      const trimmed = line.trimStart();
      if (trimmed.startsWith("resolution:") && trimmed.includes("@workspace:"))
        workspaceEntry = true;
    }
  }
  flush();
}

function packageFromLockKey(
  key: string,
): { name: string; version: string } | undefined {
  const normalized = key.replace(/^\//, "").replace(/^npm:/, "");
  const scoped = /^(@[^/]+\/[^@]+)@(.+)$/.exec(normalized);
  if (scoped) return { name: scoped[1], version: scoped[2].split("(")[0] };
  const plain = /^([^@/]+)@(.+)$/.exec(normalized);
  return plain
    ? { name: plain[1], version: plain[2].split("(")[0] }
    : undefined;
}

function parsePnpmLock(
  manifest: string,
  lockPath: string,
  dependencies: Dependency[],
): void {
  const parsed = parseYaml(readFileSync(lockPath, "utf8")) as Record<
    string,
    unknown
  >;
  for (const section of ["packages", "snapshots"]) {
    const entries = parsed[section];
    if (!entries || typeof entries !== "object") continue;
    for (const key of Object.keys(entries as Record<string, unknown>)) {
      const packageInfo = packageFromLockKey(key);
      if (packageInfo)
        dependencies.push({
          ...packageInfo,
          ecosystem: "npm",
          manifest,
          versionResolved: npmVersionIsExact(packageInfo.version),
        });
    }
  }
}

export type GoModuleListRunner = (moduleDirectory: string) => string;

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
      ? ["C:\\Program Files\\Go\\bin\\go.exe"]
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

function systemGoModuleList(moduleDirectory: string): string {
  return execFileSync(
    goExecutablePath(),
    ["list", "-mod=readonly", "-m", "all"],
    { cwd: moduleDirectory, encoding: "utf8" },
  );
}

function parseGoMod(
  manifest: string,
  path: string,
  dependencies: Dependency[],
  goModuleList: GoModuleListRunner,
): void {
  let output: string;
  try {
    output = goModuleList(dirname(path));
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.split("\n")[0] : String(error);
    dependencies.push({
      name: "(Go module graph)",
      version: "unresolved",
      ecosystem: "go",
      manifest,
      versionResolved: false,
      versionResolutionError: `Unable to read the Go build list: ${detail}`,
    });
    return;
  }

  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const name = fields[0];
    if (!name || fields.length < 2) continue;
    const version = fields[1];
    const replaced = fields.includes("=>");
    const versionResolved =
      !replaced && /^v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version);
    let versionResolutionError: string | undefined;
    if (replaced) {
      versionResolutionError =
        "The Go module is replaced; its effective source version is not established.";
    } else if (!versionResolved) {
      versionResolutionError =
        "The Go build list did not provide an exact module version.";
    }
    dependencies.push({
      name,
      version,
      ecosystem: "go",
      manifest,
      versionResolved,
      versionResolutionError,
    });
  }
}

function parseRequirements(
  manifest: string,
  path: string,
  dependencies: Dependency[],
): void {
  const parseRequirement = (
    value: string,
  ):
    { name: string; version: string; versionResolved: boolean } | undefined => {
    const nameMatch = /^[A-Za-z0-9][A-Za-z0-9_.-]*/.exec(value);
    if (!nameMatch) return undefined;
    const name = nameMatch[0];
    let remainder = value.slice(name.length).trimStart();
    if (remainder.startsWith("[")) {
      const extrasEnd = remainder.indexOf("]");
      if (extrasEnd < 0) return undefined;
      remainder = remainder.slice(extrasEnd + 1).trimStart();
    }
    const operator = /^(===|==|~=|>=|<=|>|<)/.exec(remainder)?.[0];
    if (!operator) return { name, version: "*", versionResolved: false };
    remainder = remainder.slice(operator.length).trimStart();
    const semicolon = remainder.indexOf(";");
    const whitespace = remainder.search(/\s/);
    const end = [semicolon, whitespace]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    const version = remainder.slice(0, end ?? remainder.length) || "*";
    const versionResolved =
      (operator === "==" || operator === "===") &&
      pythonVersionIsExact(version);
    return {
      name,
      version,
      versionResolved,
    };
  };

  for (const [lineIndex, rawLine] of readFileSync(path, "utf8")
    .split(/\r?\n/)
    .entries()) {
    const commentStart = rawLine.indexOf("#");
    const line = (
      commentStart < 0 ? rawLine : rawLine.slice(0, commentStart)
    ).trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("-")) {
      dependencies.push({
        name: `(requirements input line ${lineIndex + 1})`,
        version: "unresolved",
        ecosystem: "python",
        manifest,
        versionResolved: false,
        versionResolutionError:
          "Requirements includes, constraints, and options must be expanded before license checking.",
      });
      continue;
    }
    const requirement = parseRequirement(line);
    if (!requirement) {
      dependencies.push({
        name: `(requirements input line ${lineIndex + 1})`,
        version: "unresolved",
        ecosystem: "python",
        manifest,
        versionResolved: false,
        versionResolutionError:
          "The requirements line could not be parsed as a pinned package.",
      });
      continue;
    }
    dependencies.push({
      ...requirement,
      ecosystem: "python",
      manifest,
      versionResolutionError: requirement.versionResolved
        ? undefined
        : "Python requirements must pin an exact version with == or ===.",
    });
  }
}

function parsePyproject(
  manifest: string,
  path: string,
  dependencies: Dependency[],
): void {
  let parsed: {
    project?: { dependencies?: unknown };
    tool?: { poetry?: { dependencies?: Record<string, unknown> } };
  };
  try {
    parsed = parseToml(readFileSync(path, "utf8")) as typeof parsed;
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
      dependencies.push({
        name: nameMatch[0],
        version: value.slice(nameMatch[0].length).trim() || "*",
        ecosystem: "python",
        manifest,
        versionResolved: false,
        versionResolutionError:
          "A supported Python lockfile or fully pinned requirements file is required.",
      });
    }
  }

  for (const [name, value] of Object.entries(
    parsed.tool?.poetry?.dependencies ?? {},
  )) {
    if (name.toLowerCase() === "python" || typeof value !== "string") continue;
    dependencies.push({
      name,
      version: value,
      ecosystem: "python",
      manifest,
      versionResolved: false,
      versionResolutionError:
        "A supported Python lockfile or fully pinned requirements file is required.",
    });
  }
}

function parsePoetryLock(
  manifest: string,
  path: string,
  dependencies: Dependency[],
): boolean {
  try {
    const lock = parseToml(readFileSync(path, "utf8")) as {
      package?: Array<{ name?: string; version?: string }>;
    };
    for (const entry of lock.package ?? []) {
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

function parsePipfileLock(
  manifest: string,
  path: string,
  dependencies: Dependency[],
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
  for (const section of [lock?.default, lock?.develop]) {
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

type ManifestParser = (
  manifest: string,
  path: string,
  dependencies: Dependency[],
) => void;

function parsePackageJsonManifest(
  manifest: string,
  absolute: string,
  dependencies: Dependency[],
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
  const lockParsers: Record<string, ManifestParser> = {
    "package-lock.json": parseNpmLock,
    "npm-shrinkwrap.json": parseNpmLock,
    "yarn.lock": parseYarnLock,
    "pnpm-lock.yaml": parsePnpmLock,
  };
  const lockFiles: string[] = [];
  const lockDependencies: Dependency[] = [];
  for (const [lockName, parser] of Object.entries(lockParsers)) {
    const lockPath = join(dirname(absolute), lockName);
    if (!isFile(lockPath)) continue;
    lockFiles.push(lockName);
    parser(manifest, lockPath, lockDependencies);
  }
  if (lockFiles.length === 0) {
    addPackageJsonDependencies(dependencies, manifest, packageJson);
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
  const lockedNames = new Set(
    lockDependencies.map((dependency) => dependency.name),
  );
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
      if (version.startsWith("workspace:") || lockedNames.has(name)) continue;
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

function parsePyprojectManifest(
  manifest: string,
  path: string,
  dependencies: Dependency[],
): void {
  const poetryLockPath = join(dirname(path), "poetry.lock");
  if (isFile(poetryLockPath)) {
    if (parsePoetryLock(manifest, poetryLockPath, dependencies)) return;
    dependencies.push({
      name: "(invalid poetry.lock)",
      version: "unresolved",
      ecosystem: "python",
      manifest,
      versionResolved: false,
      versionResolutionError: "Could not parse the adjacent poetry.lock.",
    });
  }
  parsePyproject(manifest, path, dependencies);
}

const MANIFEST_PARSERS: Record<string, ManifestParser> = {
  "package-lock.json": parseNpmLock,
  "npm-shrinkwrap.json": parseNpmLock,
  "yarn.lock": parseYarnLock,
  "pnpm-lock.yaml": parsePnpmLock,
  "requirements.txt": parseRequirements,
  "pyproject.toml": parsePyprojectManifest,
  "poetry.lock": (manifest, path, dependencies) => {
    if (!parsePoetryLock(manifest, path, dependencies))
      dependencies.push({
        name: "(invalid poetry.lock)",
        version: "unresolved",
        ecosystem: "python",
        manifest,
        versionResolved: false,
        versionResolutionError: "Could not parse poetry.lock.",
      });
  },
  "Pipfile.lock": parsePipfileLock,
};

function parseManifest(
  root: string,
  path: string,
  dependencies: Dependency[],
  goModuleList: GoModuleListRunner,
): void {
  const basename = path.split("/").pop() ?? path;
  const absolute = resolve(root, path);
  if (!isFile(absolute)) return;

  if (basename === "package.json") {
    parsePackageJsonManifest(path, absolute, dependencies);
    return;
  }
  if (basename === "go.mod") {
    parseGoMod(path, absolute, dependencies, goModuleList);
    return;
  }
  if (basename === "go.sum") return;
  const parser =
    MANIFEST_PARSERS[basename] ??
    (basename.endsWith(".txt") ? parseRequirements : undefined);
  if (parser) {
    parser(path, absolute, dependencies);
    return;
  }
  dependencies.push({
    name: "(unsupported dependency input)",
    version: "unresolved",
    ecosystem: "unknown",
    manifest: path,
    versionResolved: false,
    versionResolutionError: `No parser is available for dependency input ${basename}.`,
  });
}

function overrideFor(
  config: DependencyConfig,
  name: string,
  version: string,
): string | undefined {
  for (const override of config.licenses ?? []) {
    if (override.match !== undefined) continue;
    const versionMatches =
      !override.version ||
      override.version
        .split(",")
        .map((item) => item.trim())
        .includes(version);
    if (
      versionMatches &&
      (override.name === name || minimatch(name, override.name))
    )
      return override.license;
  }
  return undefined;
}

function matchOverrideFor(
  config: DependencyConfig,
  name: string,
  version: string,
  candidates: string[],
): string | undefined {
  for (const candidate of candidates) {
    for (const override of config.licenses ?? []) {
      if (override.match === undefined) continue;
      const versionMatches =
        !override.version ||
        override.version
          .split(",")
          .map((item) => item.trim())
          .includes(version);
      if (
        versionMatches &&
        (override.name === name || minimatch(name, override.name)) &&
        new RegExp(override.match).test(candidate)
      )
        return override.license;
    }
  }
  return undefined;
}

function hasMatchRuleFor(
  config: DependencyConfig,
  name: string,
  version: string,
): boolean {
  return (config.licenses ?? []).some((override) => {
    if (override.match === undefined) return false;
    const versionMatches =
      !override.version ||
      override.version
        .split(",")
        .map((item) => item.trim())
        .includes(version);
    return (
      versionMatches &&
      (override.name === name || minimatch(name, override.name))
    );
  });
}

function exceptionFor(
  config: DependencyConfig,
  name: string,
  version: string,
): NonNullable<DependencyConfig["exceptions"]>[number] | undefined {
  return (config.exceptions ?? []).find(
    (exception) => exception.name === name && exception.version === version,
  );
}

function excludedBy(
  config: DependencyConfig,
  name: string,
  version: string,
): boolean {
  return (config.excludes ?? []).some((exclude) => {
    const versionMatches =
      !exclude.version ||
      exclude.version
        .split(",")
        .map((item) => item.trim())
        .includes(version);
    return (
      versionMatches && (exclude.name === name || minimatch(name, exclude.name))
    );
  });
}

function installedNpmPackage(
  root: string,
  manifest: string,
  name: string,
): PackageJson | undefined {
  const packagePath = name.startsWith("@")
    ? join("node_modules", ...name.split("/"), "package.json")
    : join("node_modules", name, "package.json");
  const candidates = [
    join(root, packagePath),
    join(root, dirname(manifest), packagePath),
  ];
  for (const candidate of candidates) {
    const packageJson = readJson(candidate) as PackageJson | undefined;
    if (packageJson) return packageJson;
  }
  return undefined;
}

const jsonCache = new Map<string, Promise<unknown>>();
const textCache = new Map<string, Promise<string | undefined>>();
const LICENSE_FILENAMES = [
  "LICENSE",
  "LICENCE",
  "LICENSE.txt",
  "LICENCE.txt",
  "LICENSE.md",
  "LICENCE.md",
  "COPYING",
];

async function fetchJson(url: string, token?: string): Promise<unknown> {
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

async function fetchText(url: string): Promise<string | undefined> {
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

function identifyLicenseText(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (
    lower.includes("gpl 2.0+/lgpl 2.1+/mpl 1.1") &&
    lower.includes("tri-license")
  )
    return "(GPL-2.0-or-later OR LGPL-2.1-or-later OR MPL-1.1)";
  if (lower.includes("apache license") && lower.includes("version 2.0"))
    return "Apache-2.0";
  if (lower.includes("permission is hereby granted, free of charge"))
    return "MIT";
  if (lower.includes("mozilla public license") && lower.includes("2.0"))
    return "MPL-2.0";
  if (lower.includes("gnu lesser general public license"))
    return lower.includes("2.1") ? "LGPL-2.1-only" : "LGPL-3.0-only";
  if (lower.includes("gnu general public license"))
    return lower.includes("version 2") ? "GPL-2.0-only" : "GPL-3.0-only";
  if (
    lower.includes("redistribution and use in source and binary forms") &&
    lower.includes("neither the name")
  )
    return "BSD-3-Clause";
  if (lower.includes("redistribution and use in source and binary forms"))
    return "BSD-2-Clause";
  if (lower.includes("permission to use, copy, modify, and/or distribute"))
    return "ISC";
  return undefined;
}

async function resolveNpm(
  root: string,
  dependency: Dependency,
  logger: Logger,
  token: string | undefined,
  includeMatchText: boolean,
): Promise<{
  license?: string;
  source?: string;
  matchText?: string;
  resolution: DependencyResult["resolution"];
}> {
  const installed = installedNpmPackage(
    root,
    dependency.manifest,
    dependency.name,
  );
  const installedLicense = packageLicense(
    installed?.license ?? installed?.licenses,
  );
  const installedMatchText = includeMatchText
    ? await npmRepositoryLicenseText(installed, token)
    : undefined;
  if (installedLicense && (!includeMatchText || installedMatchText)) {
    return {
      license: installedLicense,
      source: "node_modules/package.json",
      matchText: installedMatchText,
      resolution: "manifest",
    };
  }
  const encodedName = dependency.name.startsWith("@")
    ? dependency.name.replace("/", "%2f")
    : dependency.name;
  const concreteVersion = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(
    dependency.version,
  );
  const registryUrl = concreteVersion
    ? `https://registry.npmjs.org/${encodedName}/${encodeURIComponent(dependency.version)}`
    : `https://registry.npmjs.org/${encodedName}`;
  const metadata = (await fetchJson(registryUrl)) as
    | (PackageJson & {
        versions?: Record<string, PackageJson>;
        ["dist-tags"]?: { latest?: string };
      })
    | undefined;
  const metadataMatchText = includeMatchText
    ? ((await npmRepositoryLicenseText(metadata, token)) ?? installedMatchText)
    : undefined;
  if (installedLicense)
    return {
      license: installedLicense,
      source: "node_modules/package.json",
      matchText: metadataMatchText,
      resolution: "manifest",
    };
  const registryLicense = packageLicense(
    metadata?.license ?? metadata?.licenses,
  );
  if (registryLicense) {
    return {
      license: registryLicense,
      source: "registry.npmjs.org",
      matchText: metadataMatchText,
      resolution: "registry",
    };
  }
  if (metadata?.versions) {
    const latest = metadata.versions[metadata["dist-tags"]?.latest ?? ""];
    const latestLicense = packageLicense(latest?.license ?? latest?.licenses);
    if (latestLicense) {
      const matchText = includeMatchText
        ? await npmRepositoryLicenseText(latest, token)
        : undefined;
      return {
        license: latestLicense,
        source: "registry.npmjs.org",
        matchText,
        resolution: "registry",
      };
    }
  }
  if (installedLicense)
    return {
      license: installedLicense,
      source: "node_modules/package.json",
      matchText: metadataMatchText,
      resolution: "manifest",
    };
  logger.debug(
    `Could not resolve npm license for ${dependency.name}@${dependency.version}`,
  );
  return { matchText: metadataMatchText, resolution: "unknown" };
}

interface PythonPackageMetadata {
  info?: {
    license?: string | null;
    license_expression?: string | null;
    classifiers?: string[];
    version?: string;
    home_page?: string | null;
    project_urls?: Record<string, string | null | undefined>;
  };
  releases?: Record<string, Array<{ yanked?: boolean }>>;
}

function pythonVersionParts(version: string): number[] | undefined {
  let value = version.trim();
  if (value[0]?.toLowerCase() === "v") value = value.slice(1);
  const parts = value.split(".");
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part)))
    return undefined;
  return parts.map(Number);
}

function comparePythonVersions(left: string, right: string): number {
  const leftParts = pythonVersionParts(left);
  const rightParts = pythonVersionParts(right);
  if (!leftParts || !rightParts) return 0;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function pythonSpecifier(version: string): string {
  let value = version.trim();
  if (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1);
  return value.split(";", 1)[0].trim();
}

function matchesPythonSpecifier(version: string, specifier: string): boolean {
  const parts = pythonVersionParts(version);
  if (!parts) return false;
  const constraints = pythonSpecifier(specifier);
  if (!constraints || constraints === "*") return true;

  return constraints.split(",").every((constraint) => {
    const match =
      /^(===|==|!=|~=|>=|<=|>|<)?\s*v?(\d+(?:\.\d+)*(?:\.\*)?)$/i.exec(
        constraint.trim(),
      );
    if (!match) return false;
    const operator = match[1] ?? "==";
    const target = match[2];
    if (target.endsWith(".*")) {
      const prefix = target.slice(0, -2).split(".").map(Number);
      const matchesPrefix = prefix.every(
        (value, index) => parts[index] === value,
      );
      return operator === "!="
        ? !matchesPrefix
        : operator === "==" && matchesPrefix;
    }
    const comparison = comparePythonVersions(version, target);
    if (operator === "===" || operator === "==") return comparison === 0;
    if (operator === "!=") return comparison !== 0;
    if (operator === ">") return comparison > 0;
    if (operator === ">=") return comparison >= 0;
    if (operator === "<") return comparison < 0;
    if (operator === "<=") return comparison <= 0;
    const targetParts = pythonVersionParts(target);
    if (!targetParts || targetParts.length < 2) return false;
    const upperBound = [...targetParts];
    upperBound[upperBound.length - 2] += 1;
    upperBound.length -= 1;
    return (
      comparison >= 0 &&
      comparePythonVersions(version, upperBound.join(".")) < 0
    );
  });
}

function exactPythonVersion(version: string): string | undefined {
  let specifier = pythonSpecifier(version);
  if (specifier.startsWith("===")) specifier = specifier.slice(3).trim();
  else if (specifier.startsWith("==")) specifier = specifier.slice(2).trim();
  return pythonVersionParts(specifier) ? specifier : undefined;
}

function selectPythonRelease(
  metadata: PythonPackageMetadata,
  specifier: string,
): string | undefined {
  return Object.entries(metadata.releases ?? {})
    .filter(
      ([version, files]) =>
        pythonVersionParts(version) &&
        files.some((file) => file.yanked !== true) &&
        matchesPythonSpecifier(version, specifier),
    )
    .map(([version]) => version)
    .sort(comparePythonVersions)
    .at(-1);
}

function licenseFromPythonClassifier(classifier: string): string {
  const label = classifier.split("::").pop()?.trim() ?? classifier;
  const lower = label.toLowerCase();
  if (
    lower.includes("lesser general public license v3") &&
    lower.includes("(lgplv3+)")
  )
    return "LGPL-3.0-or-later";
  if (
    lower.includes("lesser general public license v2.1") &&
    lower.includes("(lgplv2.1+)")
  )
    return "LGPL-2.1-or-later";
  if (
    lower.includes("lesser general public license v2") &&
    lower.includes("(lgplv2+)")
  )
    return "LGPL-2.0-or-later";
  if (lower.includes("general public license v3") && lower.includes("(gplv3+)"))
    return "GPL-3.0-or-later";
  if (lower.includes("general public license v2") && lower.includes("(gplv2+)"))
    return "GPL-2.0-or-later";
  if (
    lower.includes("mozilla public license 1.1") &&
    lower.includes("(mpl 1.1)")
  )
    return "MPL-1.1";
  return label;
}

function licensesFromPythonClassifiers(
  classifiers: string[] | undefined,
): string[] {
  const licenses = new Set<string>();
  for (const classifier of classifiers ?? []) {
    if (!classifier.startsWith("License ::")) continue;
    const normalized = normalizeLicenseExpression(
      licenseFromPythonClassifier(classifier),
    );
    if (normalized !== "Unknown") licenses.add(normalized);
  }
  return [...licenses];
}

function isConciseLicenseMetadata(value: string): boolean {
  return value.length <= 200 && !/[\r\n]/.test(value);
}

function githubRepositoryFromUrl(url: string): string | undefined {
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

async function npmRepositoryLicenseText(
  packageInfo: PackageJson | undefined,
  token: string | undefined,
): Promise<string | undefined> {
  const repositoryUrl =
    typeof packageInfo?.repository === "string"
      ? packageInfo.repository
      : packageInfo?.repository?.url;
  const repository = repositoryUrl
    ? githubRepositoryFromUrl(repositoryUrl)
    : undefined;
  if (!repository) return undefined;
  return (await resolveGithubRepositoryLicense(repository, token, true))
    .matchText;
}

function githubRepositoryForPython(
  info: PythonPackageMetadata["info"],
): string | undefined {
  if (!info) return undefined;
  const urls = [info.home_page, ...Object.values(info.project_urls ?? {})];
  for (const url of urls) {
    if (!url) continue;
    const repository = githubRepositoryFromUrl(url);
    if (repository) return repository;
  }
  return undefined;
}

async function resolveGithubRepositoryLicense(
  repository: string,
  token: string | undefined,
  includeMatchText = false,
): Promise<{
  license?: string;
  source?: string;
  matchText?: string;
  resolution: DependencyResult["resolution"];
}> {
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
    const license = text ? identifyLicenseText(text) : undefined;
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

type PythonResolution = {
  license?: string;
  source?: string;
  version?: string;
  matchText?: string;
  resolution: DependencyResult["resolution"];
};

async function loadPythonMetadata(
  packageUrl: string,
  dependency: Dependency,
): Promise<{ metadata?: PythonPackageMetadata; version?: string }> {
  const pinnedVersion = exactPythonVersion(dependency.version);
  let resolvedVersion = pinnedVersion;
  let metadata = (await fetchJson(
    pinnedVersion
      ? packageUrl + "/" + encodeURIComponent(pinnedVersion) + "/json"
      : packageUrl + "/json",
  )) as PythonPackageMetadata | undefined;
  if (!pinnedVersion && metadata) {
    resolvedVersion = selectPythonRelease(metadata, dependency.version);
    if (resolvedVersion && resolvedVersion !== metadata.info?.version) {
      const releaseMetadata = (await fetchJson(
        packageUrl + "/" + encodeURIComponent(resolvedVersion) + "/json",
      )) as PythonPackageMetadata | undefined;
      if (releaseMetadata) metadata = releaseMetadata;
    }
  }
  return { metadata, version: resolvedVersion };
}

function declaredPythonLicense(
  info: PythonPackageMetadata["info"],
  version: string | undefined,
): PythonResolution | undefined {
  const expression = info?.license_expression?.trim();
  if (expression)
    return {
      license: expression,
      source: "pypi.org",
      version,
      resolution: "registry",
    };
  const declaredLicense = info?.license?.trim();
  if (
    !declaredLicense ||
    !isConciseLicenseMetadata(declaredLicense) ||
    normalizeLicenseExpression(declaredLicense) === "Unknown"
  )
    return undefined;
  return {
    license: declaredLicense,
    source: "pypi.org",
    version,
    resolution: "registry",
  };
}

function classifierPythonLicense(
  classifiers: string[] | undefined,
  version: string | undefined,
): PythonResolution | undefined {
  const licenses = licensesFromPythonClassifiers(classifiers);
  if (licenses.length === 0) return undefined;
  let license = licenses[0] ?? "Unknown";
  if (licenses.length > 1) license = "(" + licenses.join(" OR ") + ")";
  return {
    license,
    source: "pypi.org classifier",
    version,
    resolution: "registry",
  };
}

async function repositoryPythonLicense(
  info: PythonPackageMetadata["info"],
  token: string | undefined,
  version: string | undefined,
  includeMatchText = false,
): Promise<PythonResolution | undefined> {
  const repository = githubRepositoryForPython(info);
  if (!repository) return undefined;
  const resolved = await resolveGithubRepositoryLicense(
    repository,
    token,
    includeMatchText,
  );
  return resolved.license ? { ...resolved, version } : undefined;
}

function addRepositoryMatchText(
  license: PythonResolution,
  repositoryLicense: PythonResolution | undefined,
): PythonResolution {
  if (!repositoryLicense?.matchText) return license;
  return { ...license, matchText: repositoryLicense.matchText };
}

async function resolveDeclaredPythonLicense(
  info: PythonPackageMetadata["info"],
  license: PythonResolution,
  token: string | undefined,
  version: string | undefined,
): Promise<PythonResolution> {
  const repository = githubRepositoryForPython(info);
  if (!repository) return license;
  const repositoryLicense = await repositoryPythonLicense(
    info,
    token,
    version,
    true,
  );
  return addRepositoryMatchText(license, repositoryLicense);
}

async function resolvePythonFallbackLicense(
  info: PythonPackageMetadata["info"],
  token: string | undefined,
  version: string | undefined,
  includeMatchText: boolean,
): Promise<PythonResolution | undefined> {
  const classifierLicenses = licensesFromPythonClassifiers(info?.classifiers);
  const repository = githubRepositoryForPython(info);
  const repositoryResolution =
    includeMatchText && repository
      ? await repositoryPythonLicense(info, token, version, true)
      : undefined;

  if (classifierLicenses.length > 1 && repository) {
    const resolved =
      repositoryResolution ??
      (await repositoryPythonLicense(info, token, version, includeMatchText));
    if (resolved) return resolved;
  }

  const classifier = classifierPythonLicense(info?.classifiers, version);
  if (classifier)
    return addRepositoryMatchText(classifier, repositoryResolution);

  if (!repository) return undefined;
  return (
    repositoryResolution ??
    (await repositoryPythonLicense(info, token, version, includeMatchText))
  );
}

async function resolvePython(
  dependency: Dependency,
  token: string | undefined,
  logger: Logger,
  includeMatchText: boolean,
): Promise<PythonResolution> {
  const packageName = dependency.name.replace(/[-_.]+/g, "-");
  const packageUrl = "https://pypi.org/pypi/" + encodeURIComponent(packageName);
  const { metadata, version } = await loadPythonMetadata(
    packageUrl,
    dependency,
  );

  const info = metadata?.info;
  const declared = declaredPythonLicense(info, version);
  if (declared) {
    if (!includeMatchText) return declared;
    return resolveDeclaredPythonLicense(info, declared, token, version);
  }
  const fallback = await resolvePythonFallbackLicense(
    info,
    token,
    version,
    includeMatchText,
  );
  if (fallback) return fallback;
  logger.debug(
    `Could not resolve Python license for ${dependency.name}@${dependency.version}`,
  );
  return { resolution: "unknown" };
}

function resolveVendoredGoLicense(
  root: string,
  dependency: Dependency,
): { license?: string; source?: string; matchText?: string } {
  const vendorRoot = join(root, dirname(dependency.manifest), "vendor");
  let directory = join(vendorRoot, ...dependency.name.split("/"));
  for (;;) {
    for (const filename of LICENSE_FILENAMES) {
      const path = join(directory, filename);
      const text = readText(path);
      const license = text ? identifyLicenseText(text) : undefined;
      if (license)
        return {
          license,
          source: relative(root, path),
          matchText: text,
        };
    }
    if (directory === vendorRoot) break;
    directory = dirname(directory);
  }
  return {};
}

async function resolveGo(
  root: string,
  dependency: Dependency,
  token: string | undefined,
  logger: Logger,
  includeMatchText: boolean,
): Promise<{
  license?: string;
  source?: string;
  matchText?: string;
  resolution: DependencyResult["resolution"];
}> {
  const vendored = resolveVendoredGoLicense(root, dependency);
  if (vendored.license)
    return {
      ...vendored,
      resolution: "manifest",
    };
  const match = /^github\.com\/([^/]+\/[^/]+)(?:\/v\d+)?$/.exec(
    dependency.name,
  );
  if (!match) {
    logger.debug(`No repository resolver for Go module ${dependency.name}`);
    return { resolution: "unknown" };
  }

  const apiMetadata = (await fetchJson(
    `https://api.github.com/repos/${match[1]}/license`,
    token,
  )) as
    | {
        license?: { spdx_id?: string };
        download_url?: string;
      }
    | undefined;
  const apiLicense = apiMetadata?.license?.spdx_id;
  if (apiLicense && apiLicense !== "NOASSERTION") {
    const matchText =
      includeMatchText && apiMetadata.download_url
        ? await fetchText(apiMetadata.download_url)
        : undefined;
    return {
      license: apiLicense,
      source: `api.github.com/repos/${match[1]}/license`,
      matchText,
      resolution: "repository",
    };
  }

  const candidates = [
    dependency.version,
    `v${dependency.version.replace(/^v/, "")}`,
    "main",
    "master",
  ];
  const attempts = await Promise.all(
    candidates.flatMap((ref) =>
      LICENSE_FILENAMES.map(async (filename) => ({
        filename,
        text: await fetchText(
          `https://raw.githubusercontent.com/${match[1]}/${encodeURIComponent(ref)}/${filename}`,
        ),
      })),
    ),
  );
  for (const attempt of attempts) {
    const license = attempt.text
      ? identifyLicenseText(attempt.text)
      : undefined;
    if (license || (includeMatchText && attempt.text))
      return {
        license,
        source: `github.com/${match[1]}/${attempt.filename}`,
        matchText: attempt.text,
        resolution: "repository",
      };
  }
  return { resolution: "unknown" };
}

async function resolveByEcosystem(
  root: string,
  dependency: Dependency,
  token: string | undefined,
  logger: Logger,
  includeMatchText: boolean,
): Promise<{
  license?: string;
  source?: string;
  matchText?: string;
  version?: string;
  resolution: DependencyResult["resolution"];
}> {
  if (dependency.ecosystem === "npm")
    return resolveNpm(root, dependency, logger, token, includeMatchText);
  if (dependency.ecosystem === "python")
    return resolvePython(dependency, token, logger, includeMatchText);
  return resolveGo(root, dependency, token, logger, includeMatchText);
}

async function resolveLicense(
  root: string,
  dependency: Dependency,
  config: DependencyConfig,
  token: string | undefined,
  logger: Logger,
): Promise<{
  license: string;
  resolution: DependencyResult["resolution"];
  source?: string;
  version?: string;
}> {
  const configured = overrideFor(config, dependency.name, dependency.version);
  if (configured)
    return {
      license: configured,
      resolution: "configured",
      source: "configuration",
    };
  const matchCandidates = dependency.rawLicense ? [dependency.rawLicense] : [];
  const configuredMatch = matchOverrideFor(
    config,
    dependency.name,
    dependency.version,
    matchCandidates,
  );
  if (configuredMatch)
    return {
      license: configuredMatch,
      resolution: "configured",
      source: "configuration",
    };

  const hasMatchRules = hasMatchRuleFor(
    config,
    dependency.name,
    dependency.version,
  );
  const resolved = await resolveByEcosystem(
    root,
    dependency,
    token,
    logger,
    hasMatchRules,
  );
  const configuredTextMatch = matchOverrideFor(
    config,
    dependency.name,
    dependency.version,
    [
      ...matchCandidates,
      ...(resolved.license ? [resolved.license] : []),
      ...(resolved.matchText ? [resolved.matchText] : []),
    ],
  );
  if (configuredTextMatch)
    return {
      license: configuredTextMatch,
      resolution: "configured",
      source: "configuration",
      version: resolved.version,
    };
  if (dependency.rawLicense)
    return {
      license: dependency.rawLicense,
      resolution: "manifest",
      source: dependency.manifest,
    };

  return {
    license: resolved.license ?? "Unknown",
    resolution: resolved.resolution,
    source: resolved.source,
    version: resolved.version,
  };
}

function mainLicenseFor(
  manifest: string,
  config: LicenseEyeConfig,
): string | undefined {
  const rules = headerRules(config);
  const selected = rules
    .filter((rule) => !rule.path || matchesPath(manifest, [rule.path]))
    .sort(
      (left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0),
    )[0];
  return selected?.license["spdx-id"] ?? rules[0]?.license["spdx-id"];
}

export async function checkDependencies(
  root: string,
  config: LicenseEyeConfig,
  token: string | undefined,
  weakCompatible: boolean,
  logger: Logger,
  goModuleList: GoModuleListRunner = systemGoModuleList,
): Promise<DependencyReport> {
  const dependencyConfig = config.dependency;
  if (!dependencyConfig?.files?.length) {
    return { checked: 0, results: [], failures: [] };
  }

  const dependencies: Dependency[] = [];
  const configuredPaths = new Set(
    dependencyConfig.files.map((path) => path.replaceAll("\\", "/")),
  );
  for (const configuredPath of dependencyConfig.files) {
    const path = configuredPath.replaceAll("\\", "/");
    if (!isFile(resolve(root, path)))
      throw new Error(`Dependency file not found: ${path}`);
    if (
      path.split("/").pop() === "go.sum" &&
      !configuredPaths.has(join(dirname(path), "go.mod").replaceAll("\\", "/"))
    ) {
      dependencies.push({
        name: "(Go module graph)",
        version: "unresolved",
        ecosystem: "go",
        manifest: path,
        versionResolved: false,
        versionResolutionError:
          "go.sum contains checksums, not the selected module graph; configure the adjacent go.mod.",
      });
      continue;
    }
    parseManifest(root, path, dependencies, goModuleList);
  }

  const uniqueDependencies = uniqueBy(
    dependencies,
    (dependency) =>
      `${dependency.ecosystem}:${dependency.name}@${dependency.version}`,
  ).filter(
    (dependency) =>
      !excludedBy(dependencyConfig, dependency.name, dependency.version),
  );
  logger.info(`Found ${uniqueDependencies.length} dependencies to check.`);

  const resultSlots: Array<DependencyResult | undefined> = new Array(
    uniqueDependencies.length,
  );
  const concurrency = Math.min(16, uniqueDependencies.length);
  const resolveDependency = async (index: number): Promise<void> => {
    const dependency = uniqueDependencies[index];
    if (!dependency) return;
    if (
      index === 0 ||
      (index + 1) % 100 === 0 ||
      index === uniqueDependencies.length - 1
    ) {
      logger.info(
        `Resolving dependencies: ${index + 1}/${uniqueDependencies.length}`,
      );
    }
    logger.debug(
      `Resolving dependency ${index + 1}/${uniqueDependencies.length}: ${dependency.name}@${dependency.version}`,
    );
    if (!dependency.versionResolved) {
      resultSlots[index] = {
        ...dependency,
        license: "Unknown",
        normalized: "Unknown",
        resolution: "unknown",
        compatible: "unknown",
        reason:
          dependency.versionResolutionError ??
          "An exact resolved dependency version is required.",
      };
      return;
    }
    const exception = exceptionFor(
      dependencyConfig,
      dependency.name,
      dependency.version,
    );
    if (exception) {
      resultSlots[index] = {
        ...dependency,
        license: "LicenseRef-Manual-Exception",
        normalized: "LicenseRef-Manual-Exception",
        resolution: "exception",
        compatible: "approved-exception",
        source: exception.url,
        approval: { url: exception.url, reason: exception.reason },
        reason: `Manual approval: ${exception.reason}`,
      };
      logger.debug(
        `Dependency ${dependency.name}@${dependency.version}: approved manual exception`,
      );
      return;
    }
    const resolved = await resolveLicense(
      root,
      dependency,
      dependencyConfig,
      token,
      logger,
    );
    const resolvedDependency = resolved.version
      ? { ...dependency, version: resolved.version }
      : dependency;
    const normalized = normalizeLicenseExpression(resolved.license);
    const distributionWarning = distributionWarningFor(normalized);
    const compatibility = checkCompatibility(
      mainLicenseFor(dependency.manifest, config),
      normalized,
      weakCompatible,
      dependencyConfig,
    );
    resultSlots[index] = {
      ...resolvedDependency,
      license: resolved.license,
      normalized,
      resolution: resolved.resolution,
      source: resolved.source,
      compatible: compatibility,
      distributionWarning,
      reason:
        compatibility === "compatible"
          ? undefined
          : `${compatibility} with project license`,
    };
    logger.debug(
      `Dependency ${dependency.name}@${dependency.version}: ${normalized} (${compatibility})`,
    );
  };
  const worker = async (index: number): Promise<void> => {
    if (index >= uniqueDependencies.length) return;
    await resolveDependency(index);
    return worker(index + concurrency);
  };
  await Promise.all(
    Array.from({ length: concurrency }, (_, index) => worker(index)),
  );
  const results = resultSlots.filter(
    (result): result is DependencyResult => result !== undefined,
  );

  return {
    checked: results.length,
    results,
    failures: results.filter(
      (result) =>
        result.compatible !== "compatible" &&
        result.compatible !== "approved-exception",
    ),
  };
}
