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
import spdxCorrect from "spdx-correct";
import parseExpression from "spdx-expression-parse";
import { parse as parseYaml } from "yaml";
import type { DependencyConfig, DistributionModel } from "./types.js";

export type SpdxExpression =
  | { type: "license"; id: string }
  | { type: "and" | "or"; left: SpdxExpression; right: SpdxExpression }
  | {
      type: "with";
      license: { type: "license"; id: string };
      exception: string;
    };

export type Compatibility =
  "compatible" | "weak-compatible" | "incompatible" | "unknown";

type MatrixValue = "compatible" | "warning" | "incompatible";
type LicenseCategory =
  | "permissive"
  | "strong-copyleft"
  | "weak-copyleft"
  | "network-copyleft"
  | "other";
type PolicyDecision = "approve" | "review" | "deny";

interface LicenseCompatibilityRules {
  aliases: Record<string, string>;
  "review-required": { licenses: string[] };
  "license-categories": Record<
    LicenseCategory,
    { exact?: string[]; prefixes?: string[] }
  >;
  "proprietary-policies": Record<
    DistributionModel,
    Record<LicenseCategory, PolicyDecision>
  >;
  matrix: {
    groups: Record<
      string,
      { category?: LicenseCategory; exact?: string[]; prefixes?: string[] }
    >;
    values: Record<string, MatrixValue[]>;
  };
  "fsf-free": { licenses: string[] };
  "osi-approved": { licenses: string[] };
  "distribution-warnings": Array<{
    licenses?: string[];
    prefixes?: string[];
    message: string;
  }>;
  "conditional-exceptions": Array<{
    "license-prefix": string;
    exception: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadLicenseCompatibilityRules(): LicenseCompatibilityRules {
  const rulesPath = new URL(
    "../config/license-compatibility.yaml",
    import.meta.url,
  );
  const parsed: unknown = parseYaml(readFileSync(rulesPath, "utf8"));
  if (!isRecord(parsed)) throw new Error("Invalid license compatibility YAML.");
  const { aliases, matrix } = parsed;
  if (
    !isRecord(aliases) ||
    !isRecord(parsed["review-required"]) ||
    !Array.isArray(parsed["review-required"].licenses) ||
    !parsed["review-required"].licenses.every((id) => typeof id === "string") ||
    !isRecord(parsed["license-categories"]) ||
    !isRecord(parsed["proprietary-policies"]) ||
    !isRecord(matrix) ||
    !isRecord(matrix.groups) ||
    !isRecord(matrix.values)
  ) {
    throw new Error("License compatibility YAML is missing required sections.");
  }
  const groupNames = Object.keys(matrix.groups);
  for (const group of groupNames) {
    const rule = matrix.groups[group];
    const row = matrix.values[group];
    if (
      !isRecord(rule) ||
      !Array.isArray(row) ||
      row.length !== groupNames.length
    ) {
      throw new Error(`Invalid license compatibility matrix row: ${group}.`);
    }
    if (
      row.some(
        (value) =>
          value !== "compatible" &&
          value !== "warning" &&
          value !== "incompatible",
      )
    ) {
      throw new Error(`Invalid license compatibility value in row: ${group}.`);
    }
  }
  for (const category of [
    "permissive",
    "strong-copyleft",
    "weak-copyleft",
    "network-copyleft",
    "other",
  ] as const) {
    const rule = parsed["license-categories"][category];
    if (
      !isRecord(rule) ||
      (!Array.isArray(rule.exact) && !Array.isArray(rule.prefixes)) ||
      (Array.isArray(rule.exact) &&
        !rule.exact.every((id) => typeof id === "string")) ||
      (Array.isArray(rule.prefixes) &&
        !rule.prefixes.every((id) => typeof id === "string"))
    )
      throw new Error(
        `Invalid license category in compatibility YAML: ${category}.`,
      );
  }
  for (const model of [
    "internal-use",
    "proprietary-binary",
    "public-saas",
    "open-source-redistribution",
    "static-linking",
    "dynamic-linking",
  ] as const) {
    const policy = parsed["proprietary-policies"][model];
    if (
      !isRecord(policy) ||
      [
        "permissive",
        "strong-copyleft",
        "weak-copyleft",
        "network-copyleft",
        "other",
      ].some(
        (category) =>
          !["approve", "review", "deny"].includes(String(policy[category])),
      )
    )
      throw new Error(
        `Invalid proprietary policy in compatibility YAML: ${model}.`,
      );
  }
  for (const key of ["fsf-free", "osi-approved"] as const) {
    const classification = parsed[key];
    if (
      !isRecord(classification) ||
      !Array.isArray(classification.licenses) ||
      !classification.licenses.every((id) => typeof id === "string")
    ) {
      throw new Error(`Invalid ${key} license list in compatibility YAML.`);
    }
  }
  if (
    !Array.isArray(parsed["distribution-warnings"]) ||
    parsed["distribution-warnings"].some(
      (rule) =>
        !isRecord(rule) ||
        typeof rule.message !== "string" ||
        (!Array.isArray(rule.licenses) && !Array.isArray(rule.prefixes)) ||
        (Array.isArray(rule.licenses) &&
          !rule.licenses.every((id) => typeof id === "string")) ||
        (Array.isArray(rule.prefixes) &&
          !rule.prefixes.every((prefix) => typeof prefix === "string")),
    )
  ) {
    throw new Error(
      "Invalid distribution warning rules in compatibility YAML.",
    );
  }
  if (
    !Array.isArray(parsed["conditional-exceptions"]) ||
    parsed["conditional-exceptions"].some(
      (rule) =>
        !isRecord(rule) ||
        typeof rule["license-prefix"] !== "string" ||
        typeof rule.exception !== "string",
    )
  ) {
    throw new Error(
      "Invalid conditional exception rules in compatibility YAML.",
    );
  }
  return parsed as unknown as LicenseCompatibilityRules;
}

const LICENSE_RULES = loadLicenseCompatibilityRules();
const REVIEW_REQUIRED = new Set(LICENSE_RULES["review-required"].licenses);
const MATRIX_GROUPS = Object.keys(LICENSE_RULES.matrix.groups);
const FSF_FREE = new Set(LICENSE_RULES["fsf-free"].licenses);
const OSI_APPROVED = new Set(LICENSE_RULES["osi-approved"].licenses);
const ALIASES = LICENSE_RULES.aliases;

export const DEFAULT_DISTRIBUTION: DistributionModel = "public-saas";
const LICENSECOMPAT_CHECKER_URL = "https://licensecompat.com/";

export function normalizeLicenseId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^unknown$/i.test(trimmed) || /^noassertion$/i.test(trimmed))
    return "Unknown";
  if (/^LicenseRef-[A-Za-z0-9.-]+$/.test(trimmed)) return trimmed;
  if (ALIASES[trimmed]) return ALIASES[trimmed];
  try {
    const corrected = spdxCorrect(trimmed);
    return corrected ?? "Unknown";
  } catch {
    return "Unknown";
  }
}

function convertParsed(value: unknown): SpdxExpression {
  const node = value as {
    license?: string;
    exception?: string;
    left?: unknown;
    right?: unknown;
    conjunction?: string;
  };
  if (node.license && node.exception) {
    return {
      type: "with",
      license: { type: "license", id: normalizeLicenseId(node.license) },
      exception: node.exception,
    };
  }
  if (node.license)
    return { type: "license", id: normalizeLicenseId(node.license) };
  if (node.left && node.right && node.conjunction) {
    return {
      type: node.conjunction.toLowerCase() === "and" ? "and" : "or",
      left: convertParsed(node.left),
      right: convertParsed(node.right),
    };
  }
  return { type: "license", id: "Unknown" };
}

function normalizeExpressionTokens(value: string): string {
  let exception = false;
  return value.replace(/[A-Za-z0-9][A-Za-z0-9.+_-]*/g, (token) => {
    if (/^(AND|OR|WITH)$/i.test(token)) {
      exception = token.toUpperCase() === "WITH";
      return token.toUpperCase();
    }
    if (exception) {
      exception = false;
      return token;
    }
    return normalizeLicenseId(token);
  });
}

export function parseLicenseExpression(
  value: string | undefined,
): SpdxExpression {
  if (!value) return { type: "license", id: "Unknown" };
  const normalized = normalizeExpressionTokens(value);
  try {
    return convertParsed(parseExpression(normalized));
  } catch {
    return { type: "license", id: normalizeLicenseId(value) };
  }
}

export function normalizeLicenseExpression(value: string | undefined): string {
  const expression = parseLicenseExpression(value);
  const render = (node: SpdxExpression): string => {
    if (node.type === "license") return node.id;
    if (node.type === "with")
      return `${render(node.license)} WITH ${node.exception}`;
    return `(${render(node.left)} ${node.type.toUpperCase()} ${render(node.right)})`;
  };
  return render(expression);
}

function licenseIds(expression: SpdxExpression): string[] {
  if (expression.type === "license") return [expression.id];
  if (expression.type === "with") return licenseIds(expression.license);
  return [...licenseIds(expression.left), ...licenseIds(expression.right)];
}

export function distributionWarningFor(
  expression: string | undefined,
  distribution?: DistributionModel,
): string | undefined {
  const ids = licenseIds(parseLicenseExpression(expression));
  for (const rule of LICENSE_RULES["distribution-warnings"]) {
    if (
      ids.some(
        (id) =>
          rule.licenses?.includes(id) ||
          rule.prefixes?.some((prefix) => id.startsWith(prefix)),
      )
    )
      return `${rule.message} Distribution model: ${distribution ?? DEFAULT_DISTRIBUTION}.`;
  }
  return undefined;
}

function isFree(id: string): boolean {
  return FSF_FREE.has(id);
}

function isOsi(id: string): boolean {
  return OSI_APPROVED.has(id);
}

function matrixGroup(id: string): string | undefined {
  for (const [group, rule] of Object.entries(LICENSE_RULES.matrix.groups)) {
    if (rule.exact?.includes(id)) return group;
    if (
      rule.prefixes?.some((prefix) =>
        prefix.endsWith("-")
          ? id.startsWith(prefix)
          : id === prefix || id.startsWith(`${prefix}-`),
      )
    )
      return group;
  }
  for (const [group, rule] of Object.entries(LICENSE_RULES.matrix.groups)) {
    if (rule.category && licenseCategory(id) === rule.category) return group;
  }
  return undefined;
}

function licenseCategory(id: string): LicenseCategory {
  for (const [category, rule] of Object.entries(
    LICENSE_RULES["license-categories"],
  ) as Array<[LicenseCategory, { exact?: string[]; prefixes?: string[] }]>) {
    if (
      rule.exact?.includes(id) ||
      rule.prefixes?.some((prefix) => id.startsWith(prefix))
    )
      return category;
  }
  return "other";
}

export function licenseCompatAdviceUrl(
  projectExpression: string | undefined,
  dependencyExpression: string | undefined,
  distribution: DistributionModel = DEFAULT_DISTRIBUTION,
): string {
  const ids = [
    ...new Set(
      [
        ...licenseIds(parseLicenseExpression(projectExpression)),
        ...licenseIds(parseLicenseExpression(dependencyExpression)),
      ].filter((id) => id !== "Unknown"),
    ),
  ];
  return `${LICENSECOMPAT_CHECKER_URL}?licenses=${encodeURIComponent(ids.join(","))}&model=${distribution.replaceAll("-", "_")}`;
}

function matrixCompatibility(
  main: string,
  dependency: string,
  weakCompatible: boolean,
): Compatibility {
  const dependencyIndex = MATRIX_GROUPS.indexOf(dependency);
  const value = LICENSE_RULES.matrix.values[main][dependencyIndex];
  if (value === "warning")
    return weakCompatible ? "weak-compatible" : "unknown";
  return value;
}

function configuredCompatibility(
  dependency: string,
  config?: DependencyConfig,
): Compatibility | undefined {
  if (config?.require_fsf_free && !isFree(dependency)) return "incompatible";
  if (config?.require_osi_approved && !isOsi(dependency)) return "incompatible";
  return undefined;
}

function categoryCompatibility(
  main: string,
  dependency: string,
  weakCompatible: boolean,
): Compatibility {
  const mainCategory = licenseCategory(main);
  const dependencyCategory = licenseCategory(dependency);
  if (mainCategory === "permissive") {
    if (dependencyCategory === "permissive") return "compatible";
    if (dependencyCategory === "weak-copyleft")
      return weakCompatible ? "weak-compatible" : "unknown";
    if (
      dependencyCategory === "strong-copyleft" ||
      dependencyCategory === "network-copyleft"
    )
      return "incompatible";
    return "unknown";
  }
  if (mainCategory === "weak-copyleft") {
    if (dependencyCategory === "weak-copyleft") return "compatible";
    if (dependencyCategory === "permissive")
      return weakCompatible ? "weak-compatible" : "unknown";
    if (
      dependencyCategory === "strong-copyleft" ||
      dependencyCategory === "network-copyleft"
    )
      return "incompatible";
    return "unknown";
  }
  return main === dependency ? "compatible" : "unknown";
}

function compareSingle(
  main: string,
  dependency: string,
  weakCompatible: boolean,
  config?: DependencyConfig,
): Compatibility {
  if (
    main === "Unknown" ||
    dependency === "Unknown" ||
    licenseCategory(main) === "other" ||
    licenseCategory(dependency) === "other"
  )
    return "unknown";
  if (REVIEW_REQUIRED.has(main) || REVIEW_REQUIRED.has(dependency))
    return "unknown";
  const configured = configuredCompatibility(dependency, config);
  if (configured) return configured;

  const mainGroup = matrixGroup(main);
  const dependencyGroup = matrixGroup(dependency);
  const compatibility =
    mainGroup && dependencyGroup
      ? matrixCompatibility(mainGroup, dependencyGroup, weakCompatible)
      : categoryCompatibility(main, dependency, weakCompatible);
  return compatibility;
}

function proprietaryLicenseDecision(
  id: string,
  distribution: DistributionModel,
): Compatibility {
  const category = licenseCategory(id);
  if (category === "other") return "unknown";
  const decision =
    LICENSE_RULES["proprietary-policies"][distribution][category];
  if (decision === "deny") return "incompatible";
  if (decision === "review") return "unknown";
  return "compatible";
}

export function checkProprietaryCompatibility(
  expression: string | undefined,
  distribution: DistributionModel = DEFAULT_DISTRIBUTION,
  config?: DependencyConfig,
): Compatibility {
  if (distribution === "open-source-redistribution") return "unknown";
  const dependency = parseLicenseExpression(expression);
  const compare = (node: SpdxExpression): Compatibility => {
    if (node.type === "and")
      return combineAnd(compare(node.left), compare(node.right));
    if (node.type === "or")
      return combineOr(compare(node.left), compare(node.right));
    if (node.type === "with") {
      const base = compare(node.license);
      if (base !== "incompatible") return base;
      const allowedConditionally = LICENSE_RULES["conditional-exceptions"].some(
        (rule) =>
          rule.exception === node.exception &&
          (node.license.id === rule["license-prefix"] ||
            node.license.id.startsWith(`${rule["license-prefix"]}-`)),
      );
      return allowedConditionally ? "unknown" : base;
    }
    if (node.type !== "license") return "unknown";
    if (
      node.id === "Unknown" ||
      licenseCategory(node.id) === "other" ||
      REVIEW_REQUIRED.has(node.id)
    )
      return "unknown";
    const configured = configuredCompatibility(node.id, config);
    if (configured) return configured;
    return proprietaryLicenseDecision(node.id, distribution);
  };
  return compare(dependency);
}

function combineAnd(left: Compatibility, right: Compatibility): Compatibility {
  if (left === "incompatible" || right === "incompatible")
    return "incompatible";
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === "weak-compatible" || right === "weak-compatible")
    return "weak-compatible";
  return "compatible";
}

function combineOr(left: Compatibility, right: Compatibility): Compatibility {
  if (left === "compatible" || right === "compatible") return "compatible";
  if (left === "weak-compatible" || right === "weak-compatible")
    return "weak-compatible";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "incompatible";
}

export function checkCompatibility(
  mainExpression: string | undefined,
  dependencyExpression: string | undefined,
  weakCompatible: boolean,
  config?: DependencyConfig,
): Compatibility {
  const main = parseLicenseExpression(mainExpression);
  const dependency = parseLicenseExpression(dependencyExpression);
  const applyConditionalException = (
    license: string,
    exception: string,
    compatibility: Compatibility,
  ): Compatibility => {
    if (compatibility !== "incompatible") return compatibility;
    const configuredAsConditional = LICENSE_RULES[
      "conditional-exceptions"
    ].some(
      (rule) =>
        rule.exception === exception &&
        (license === rule["license-prefix"] ||
          license.startsWith(`${rule["license-prefix"]}-`)),
    );
    if (configuredAsConditional && weakCompatible) return "weak-compatible";
    return "unknown";
  };

  const compare = (
    project: SpdxExpression,
    packageLicense: SpdxExpression,
  ): Compatibility => {
    if (project.type === "and")
      return combineAnd(
        compare(project.left, packageLicense),
        compare(project.right, packageLicense),
      );
    if (project.type === "or")
      return combineOr(
        compare(project.left, packageLicense),
        compare(project.right, packageLicense),
      );
    if (project.type === "with")
      return applyConditionalException(
        project.license.id,
        project.exception,
        compare(project.license, packageLicense),
      );

    if (packageLicense.type === "and")
      return combineAnd(
        compare(project, packageLicense.left),
        compare(project, packageLicense.right),
      );
    if (packageLicense.type === "or")
      return combineOr(
        compare(project, packageLicense.left),
        compare(project, packageLicense.right),
      );
    if (packageLicense.type === "with")
      return applyConditionalException(
        packageLicense.license.id,
        packageLicense.exception,
        compare(project, packageLicense.license),
      );
    if (project.type === "license" && packageLicense.type === "license")
      return compareSingle(
        project.id,
        packageLicense.id,
        weakCompatible,
        config,
      );
    return "unknown";
  };

  return compare(main, dependency);
}

export function isUnknownLicense(value: string | undefined): boolean {
  return normalizeLicenseExpression(value) === "Unknown";
}
