import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";
import { headerRules } from "./config.js";
import { Logger } from "./logger.js";
import { checkCompatibility, normalizeLicenseExpression } from "./spdx.js";
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
      dependencies.push({ name, version, ecosystem: "npm", manifest });
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
  if (!lock) return;

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
        dependencies.push({ name, version, ecosystem: "npm", manifest });
    }
    names = [];
    version = "*";
    workspaceEntry = false;
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t") && line.endsWith(":")) {
      flush();
      const selector = line
        .slice(0, -1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      for (const item of selector.split(/\s*,\s*/)) {
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
          const targetScoped = target.match(/^(@[^/]+\/[^@]+)@/);
          const targetPlain = target.match(/^([^@/]+)@/);
          names.push(
            targetScoped?.[1] ??
              targetPlain?.[1] ??
              normalized.slice(0, berryAlias),
          );
          continue;
        }
        const scoped = normalized.match(/^(@[^/]+\/[^@]+)@/);
        const plain = normalized.match(/^([^@]+)@/);
        const name = scoped?.[1] ?? plain?.[1];
        if (name) names.push(name);
      }
    } else {
      const match = line.match(/^\s+version(?:\s+|:\s*)['"]?([^'"\s]+)['"]?/);
      if (match) version = match[1];
      if (/^\s+resolution:\s+['"]?.+@workspace:/.test(line))
        workspaceEntry = true;
    }
  }
  flush();
}

function packageFromLockKey(
  key: string,
): { name: string; version: string } | undefined {
  const normalized = key.replace(/^\//, "").replace(/^npm:/, "");
  const scoped = normalized.match(/^(@[^/]+\/[^@]+)@(.+)$/);
  if (scoped) return { name: scoped[1], version: scoped[2].split("(")[0] };
  const plain = normalized.match(/^([^@/]+)@(.+)$/);
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
        dependencies.push({ ...packageInfo, ecosystem: "npm", manifest });
    }
  }
}

function parseGoMod(
  manifest: string,
  path: string,
  dependencies: Dependency[],
): void {
  const text = readFileSync(path, "utf8");
  let inRequire = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (/^require\s*\(/.test(line)) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ")") {
      inRequire = false;
      continue;
    }
    const inline = line.match(/^require\s+(\S+)\s+(\S+)/);
    const block = inRequire ? line.match(/^(\S+)\s+(\S+)/) : undefined;
    const match = inline ?? block;
    if (!match) continue;
    dependencies.push({
      name: match[1],
      version: match[2],
      ecosystem: "go",
      manifest,
    });
  }
}

function parseGoSum(
  manifest: string,
  path: string,
  dependencies: Dependency[],
): void {
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(\S+)\s+(\S+)(?:\/go\.mod)?\s+h1:/);
    if (match)
      dependencies.push({
        name: match[1],
        version: match[2],
        ecosystem: "go",
        manifest,
      });
  }
}

function parseRequirements(
  manifest: string,
  path: string,
  dependencies: Dependency[],
): void {
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const match = line.match(
      /^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]+\])?\s*(?:(===|==|~=|>=|<=|>|<)\s*([^;\s]+))?/,
    );
    if (match)
      dependencies.push({
        name: match[1],
        version: match[3] ?? "*",
        ecosystem: "python",
        manifest,
      });
  }
}

function parsePyproject(
  manifest: string,
  path: string,
  dependencies: Dependency[],
): void {
  const text = readFileSync(path, "utf8");
  const dependencyLines =
    text.match(/(?:^|\n)\s*dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? "";
  for (const value of dependencyLines.matchAll(/['"]([^'"]+)['"]/g)) {
    const match = value[1].match(
      /^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]+\])?\s*(.*)$/,
    );
    if (match)
      dependencies.push({
        name: match[1],
        version: match[2].trim() || "*",
        ecosystem: "python",
        manifest,
      });
  }

  const section =
    text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "";
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=\s*(.+)$/);
    if (match && match[1].toLowerCase() !== "python") {
      dependencies.push({
        name: match[1],
        version: match[2].replace(/^['"]|['"]$/g, ""),
        ecosystem: "python",
        manifest,
      });
    }
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
  for (const section of [lock?.default, lock?.develop]) {
    for (const [name, value] of Object.entries(section ?? {})) {
      dependencies.push({
        name,
        version: value.version ?? "*",
        ecosystem: "python",
        manifest,
      });
    }
  }
}

function parseManifest(
  root: string,
  path: string,
  dependencies: Dependency[],
): void {
  const basename = path.split("/").pop() ?? path;
  const absolute = resolve(root, path);
  if (!isFile(absolute)) return;

  if (basename === "package.json") {
    const packageJson = readJson(absolute) as PackageJson | undefined;
    const lockFiles: string[] = [];
    for (const lockName of [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
    ]) {
      const lockPath = join(dirname(absolute), lockName);
      if (!isFile(lockPath)) continue;
      lockFiles.push(lockName);
      if (lockName === "yarn.lock") parseYarnLock(path, lockPath, dependencies);
      else if (lockName === "pnpm-lock.yaml")
        parsePnpmLock(path, lockPath, dependencies);
      else parseNpmLock(path, lockPath, dependencies);
    }
    if (lockFiles.length === 0 && packageJson)
      addPackageJsonDependencies(dependencies, path, packageJson);
  } else if (
    basename === "package-lock.json" ||
    basename === "npm-shrinkwrap.json"
  )
    parseNpmLock(path, absolute, dependencies);
  else if (basename === "yarn.lock")
    parseYarnLock(path, absolute, dependencies);
  else if (basename === "pnpm-lock.yaml")
    parsePnpmLock(path, absolute, dependencies);
  else if (basename === "go.mod") parseGoMod(path, absolute, dependencies);
  else if (basename === "go.sum") parseGoSum(path, absolute, dependencies);
  else if (basename === "requirements.txt" || basename.endsWith(".txt"))
    parseRequirements(path, absolute, dependencies);
  else if (basename === "pyproject.toml") {
    const poetryLockPath = join(dirname(absolute), "poetry.lock");
    if (
      !isFile(poetryLockPath) ||
      !parsePoetryLock(path, poetryLockPath, dependencies)
    )
      parsePyproject(path, absolute, dependencies);
  } else if (basename === "poetry.lock")
    parsePoetryLock(path, absolute, dependencies);
  else if (basename === "Pipfile.lock")
    parsePipfileLock(path, absolute, dependencies);
}

function overrideFor(
  config: DependencyConfig,
  name: string,
  version: string,
): string | undefined {
  for (const override of config.licenses ?? []) {
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

const jsonCache = new Map<string, Promise<unknown | undefined>>();
const textCache = new Map<string, Promise<string | undefined>>();

async function fetchJson(
  url: string,
  token?: string,
): Promise<unknown | undefined> {
  const cacheKey = `${token ? "authenticated" : "anonymous"}:${url}`;
  const cached = jsonCache.get(cacheKey);
  if (cached) return cached;

  const request = (async (): Promise<unknown | undefined> => {
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
): Promise<{
  license?: string;
  source?: string;
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
  if (installedLicense)
    return {
      license: installedLicense,
      source: "node_modules/package.json",
      resolution: "manifest",
    };
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
  const registryLicense = packageLicense(
    metadata?.license ?? metadata?.licenses,
  );
  if (registryLicense)
    return {
      license: registryLicense,
      source: "registry.npmjs.org",
      resolution: "registry",
    };
  if (metadata?.versions) {
    const latest = metadata.versions[metadata["dist-tags"]?.latest ?? ""];
    const latestLicense = packageLicense(latest?.license ?? latest?.licenses);
    if (latestLicense)
      return {
        license: latestLicense,
        source: "registry.npmjs.org",
        resolution: "registry",
      };
  }
  logger.debug(
    `Could not resolve npm license for ${dependency.name}@${dependency.version}`,
  );
  return { resolution: "unknown" };
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
  const match = version.trim().match(/^v?(\d+(?:\.\d+)*)$/i);
  return match?.[1].split(".").map(Number);
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
  return version
    .trim()
    .replace(/^\((.*)\)$/, "$1")
    .split(";", 1)[0]
    .trim();
}

function matchesPythonSpecifier(version: string, specifier: string): boolean {
  const parts = pythonVersionParts(version);
  if (!parts) return false;
  const constraints = pythonSpecifier(specifier);
  if (!constraints || constraints === "*") return true;

  return constraints.split(",").every((constraint) => {
    const match = constraint
      .trim()
      .match(/^(===|==|!=|~=|>=|<=|>|<)?\s*v?(\d+(?:\.\d+)*(?:\.\*)?)$/i);
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
  const specifier = pythonSpecifier(version);
  const match = specifier.match(/^(?:===|==)?\s*(v?\d+(?:\.\d+)*)$/i);
  return match?.[1];
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
  if (/lesser general public license v3.*\(lgplv3\+\)/i.test(label))
    return "LGPL-3.0-or-later";
  if (/lesser general public license v2\.1.*\(lgplv2\.1\+\)/i.test(label))
    return "LGPL-2.1-or-later";
  if (/lesser general public license v2.*\(lgplv2\+\)/i.test(label))
    return "LGPL-2.0-or-later";
  if (/general public license v3.*\(gplv3\+\)/i.test(label))
    return "GPL-3.0-or-later";
  if (/general public license v2.*\(gplv2\+\)/i.test(label))
    return "GPL-2.0-or-later";
  if (/mozilla public license 1\.1.*\(mpl 1\.1\)/i.test(label))
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
): Promise<{
  license?: string;
  source?: string;
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
  if (apiLicense && apiLicense !== "NOASSERTION")
    return {
      license: apiLicense,
      source: apiUrl,
      resolution: "repository",
    };
  if (metadata?.download_url) {
    const text = await fetchText(metadata.download_url);
    const license = text ? identifyLicenseText(text) : undefined;
    if (license)
      return {
        license,
        source: metadata.html_url ?? metadata.download_url,
        resolution: "repository",
      };
  }
  return { resolution: "unknown" };
}

async function resolvePython(
  dependency: Dependency,
  token: string | undefined,
  logger: Logger,
): Promise<{
  license?: string;
  source?: string;
  version?: string;
  resolution: DependencyResult["resolution"];
}> {
  const packageName = dependency.name.replace(/[-_.]+/g, "-");
  const packageUrl = `https://pypi.org/pypi/${encodeURIComponent(packageName)}`;
  const pinnedVersion = exactPythonVersion(dependency.version);
  let resolvedVersion = pinnedVersion;
  let metadata = (await fetchJson(
    pinnedVersion
      ? `${packageUrl}/${encodeURIComponent(pinnedVersion)}/json`
      : `${packageUrl}/json`,
  )) as PythonPackageMetadata | undefined;

  if (!pinnedVersion && metadata) {
    resolvedVersion = selectPythonRelease(metadata, dependency.version);
    if (resolvedVersion && resolvedVersion !== metadata.info?.version) {
      const releaseMetadata = (await fetchJson(
        `${packageUrl}/${encodeURIComponent(resolvedVersion)}/json`,
      )) as PythonPackageMetadata | undefined;
      if (releaseMetadata) metadata = releaseMetadata;
    }
  }

  const info = metadata?.info;
  if (info?.license_expression?.trim())
    return {
      license: info.license_expression,
      source: "pypi.org",
      version: resolvedVersion,
      resolution: "registry",
    };
  const declaredLicense = info?.license?.trim();
  if (
    declaredLicense &&
    isConciseLicenseMetadata(declaredLicense) &&
    normalizeLicenseExpression(declaredLicense) !== "Unknown"
  )
    return {
      license: declaredLicense,
      source: "pypi.org",
      version: resolvedVersion,
      resolution: "registry",
    };
  const classifierLicenses = licensesFromPythonClassifiers(info?.classifiers);
  const repository = githubRepositoryForPython(info);
  if (classifierLicenses.length > 1 && repository) {
    const resolved = await resolveGithubRepositoryLicense(repository, token);
    if (resolved.license)
      return {
        ...resolved,
        version: resolvedVersion,
      };
  }
  if (classifierLicenses.length > 0)
    return {
      license:
        classifierLicenses.length === 1
          ? classifierLicenses[0]
          : `(${classifierLicenses.join(" OR ")})`,
      source: "pypi.org classifier",
      version: resolvedVersion,
      resolution: "registry",
    };
  if (repository) {
    const resolved = await resolveGithubRepositoryLicense(repository, token);
    if (resolved.license)
      return {
        ...resolved,
        version: resolvedVersion,
      };
  }
  logger.debug(
    `Could not resolve Python license for ${dependency.name}@${dependency.version}`,
  );
  return { resolution: "unknown" };
}

async function resolveGo(
  dependency: Dependency,
  token: string | undefined,
  logger: Logger,
): Promise<{
  license?: string;
  source?: string;
  resolution: DependencyResult["resolution"];
}> {
  const match = dependency.name.match(
    /^github\.com\/([^/]+\/[^/]+)(?:\/v\d+)?$/,
  );
  if (!match) {
    logger.debug(`No repository resolver for Go module ${dependency.name}`);
    return { resolution: "unknown" };
  }

  const apiMetadata = (await fetchJson(
    `https://api.github.com/repos/${match[1]}/license`,
    token,
  )) as { license?: { spdx_id?: string } } | undefined;
  const apiLicense = apiMetadata?.license?.spdx_id;
  if (apiLicense && apiLicense !== "NOASSERTION") {
    return {
      license: apiLicense,
      source: `api.github.com/repos/${match[1]}/license`,
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
      ["LICENSE", "LICENSE.txt", "LICENSE.md", "COPYING"].map(
        async (filename) => ({
          filename,
          text: await fetchText(
            `https://raw.githubusercontent.com/${match[1]}/${encodeURIComponent(ref)}/${filename}`,
          ),
        }),
      ),
    ),
  );
  for (const attempt of attempts) {
    const license = attempt.text
      ? identifyLicenseText(attempt.text)
      : undefined;
    if (license)
      return {
        license,
        source: `github.com/${match[1]}/${attempt.filename}`,
        resolution: "repository",
      };
  }
  return { resolution: "unknown" };
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
  if (dependency.rawLicense)
    return {
      license: dependency.rawLicense,
      resolution: "manifest",
      source: dependency.manifest,
    };

  const resolved: {
    license?: string;
    source?: string;
    version?: string;
    resolution: DependencyResult["resolution"];
  } =
    dependency.ecosystem === "npm"
      ? await resolveNpm(root, dependency, logger)
      : dependency.ecosystem === "python"
        ? await resolvePython(dependency, token, logger)
        : await resolveGo(dependency, token, logger);
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
): Promise<DependencyReport> {
  const dependencyConfig = config.dependency;
  if (
    !dependencyConfig ||
    !dependencyConfig.files ||
    dependencyConfig.files.length === 0
  ) {
    return { checked: 0, results: [], failures: [] };
  }

  const dependencies: Dependency[] = [];
  for (const configuredPath of dependencyConfig.files) {
    const path = configuredPath.replaceAll("\\", "/");
    if (!isFile(resolve(root, path)))
      throw new Error(`Dependency file not found: ${path}`);
    parseManifest(root, path, dependencies);
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
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
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
        continue;
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
        reason:
          compatibility === "compatible"
            ? undefined
            : `${compatibility} with project license`,
      };
      logger.debug(
        `Dependency ${dependency.name}@${dependency.version}: ${normalized} (${compatibility})`,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(16, uniqueDependencies.length) }, () =>
      worker(),
    ),
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
