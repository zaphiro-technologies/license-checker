import spdxCorrect from "spdx-correct";
import parseExpression from "spdx-expression-parse";
import type { DependencyConfig } from "./types.js";

export type SpdxExpression =
  | { type: "license"; id: string }
  | { type: "and" | "or"; left: SpdxExpression; right: SpdxExpression }
  | { type: "with"; license: SpdxExpression; exception: string };

export type Compatibility =
  "compatible" | "weak-compatible" | "incompatible" | "unknown";

const CATEGORY_A = new Set([
  "Apache-2.0",
  "PHP-3.01",
  "0BSD",
  "BSD-3-Clause",
  "BSD-2-Clause",
  "BSD-2-Clause-Views",
  "PostgreSQL",
  "EDL-1.0",
  "ISC",
  "SMLNJ",
  "ICU",
  "NCSA",
  "W3C",
  "Xnet",
  "Zlib",
  "Libpng",
  "AFL-3.0",
  "MS-PL",
  "Python-2.0",
  "PSF-2.0",
  "CNRI-Python",
  "BSL-1.0",
  "WTFPL",
  "Unicode-DFS-2016",
  "Unicode-DFS-2015",
  "ZPL-2.0",
  "Unlicense",
  "HPND",
  "MulanPSL-2.0",
  "MIT",
  "MIT-0",
  "MIT-CMU",
  "BlueOak-1.0.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
]);

const CATEGORY_B = new Set([
  "CDDL-1.0",
  "CDDL-1.1",
  "CPL-1.0",
  "EPL-1.0",
  "EPL-2.0",
  "ErlPL-1.1",
  "IPA",
  "IPL-1.0",
  "UFL-1.0",
  "UnRAR",
  "MPL-1.0",
  "MPL-1.1",
  "MPL-2.0",
  "OFL-1.1",
  "OSL-3.0",
  "Ruby",
  "SPL-1.0",
]);

const CATEGORY_A_INCOMPATIBLE = new Set([
  "CAL-1.0",
  "LGPL-2.0+",
  "LGPL-2.0",
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.1+",
  "LGPL-2.1",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0+",
  "LGPL-3.0",
  "LGPL-3.0-linking-exception",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "LGPLLR",
  "GPL-1.0+",
  "GPL-1.0",
  "GPL-1.0-only",
  "GPL-1.0-or-later",
  "GPL-2.0+",
  "GPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-2.0-with-autoconf-exception",
  "GPL-2.0-with-bison-exception",
  "GPL-2.0-with-classpath-exception",
  "GPL-2.0-with-font-exception",
  "GPL-2.0-with-GCC-exception",
  "GPL-3.0+",
  "GPL-3.0",
  "GPL-3.0-linking-exception",
  "GPL-3.0-linking-source-exception",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "GPL-3.0-with-autoconf-exception",
  "GPL-3.0-with-GCC-exception",
  "GPL-CC-1.0",
  "QPL-1.0",
  "Sleepycat",
  "SSPL-1.0",
  "CPOL-1.02",
  "NPL-1.0",
  "NPL-1.1",
]);

const FSF_FREE = new Set([
  ...CATEGORY_A,
  ...CATEGORY_B,
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
]);

const OSI_APPROVED = new Set([
  ...CATEGORY_A,
  ...CATEGORY_B,
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "BSD-3-Clause-Clear",
  "BSD-3-Clause-LBNL",
  "BSD-2-Clause-Patent",
  "EUPL-1.2",
  "CAL-1.0",
]);

const ALIASES: Record<string, string> = {
  "Apache 2": "Apache-2.0",
  "Apache 2.0": "Apache-2.0",
  "Apache License 2.0": "Apache-2.0",
  "Apache License, Version 2.0": "Apache-2.0",
  "MIT License": "MIT",
  "ISC license": "ISC",
  "ISC License": "ISC",
  "ISC License (ISCL)": "ISC",
  "BSD License": "BSD-3-Clause",
  BSD: "BSD-3-Clause",
  "GPL-2.0+": "GPL-2.0-or-later",
  "GPL-3.0+": "GPL-3.0-or-later",
  "LGPL-2.1+": "LGPL-2.1-or-later",
  "LGPL-3.0+": "LGPL-3.0-or-later",
  "MPL 2.0": "MPL-2.0",
  "Mozilla Public License 2.0": "MPL-2.0",
  "MPL 1.1": "MPL-1.1",
  "Mozilla Public License 1.1": "MPL-1.1",
  "Public Domain": "CC0-1.0",
};

export function normalizeLicenseId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^unknown$/i.test(trimmed) || /^noassertion$/i.test(trimmed))
    return "Unknown";
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
): string | undefined {
  const ids = licenseIds(parseLicenseExpression(expression));
  if (ids.some((id) => /^AGPL-/.test(id)))
    return "Distribution review: AGPL terms can require offering corresponding source to network users. Include required notices and review the license before distribution or deployment.";
  if (ids.some((id) => /^GPL-/.test(id)))
    return "Distribution review: GPL terms can require distributing corresponding source and licensing covered combined work under GPL. Include required notices and the license text.";
  if (ids.some((id) => /^LGPL-/.test(id)))
    return "Distribution review: LGPL terms require preserving notices and providing the license text; distribution of modified or combined work can create source and relinking obligations.";
  if (ids.some((id) => /^MPL-/.test(id)))
    return "Distribution review: MPL terms require preserving notices and making covered source files available when distributing executable form.";
  if (ids.includes("CAL-1.0"))
    return "Distribution review: CAL has reciprocal source, deployment, and user-autonomy obligations. Review its terms before providing the software to third parties.";
  if (
    ids.some((id) =>
      [
        "CDDL-1.0",
        "CDDL-1.1",
        "CPL-1.0",
        "EPL-1.0",
        "EPL-2.0",
        "EUPL-1.2",
        "OSL-3.0",
        "CPAL-1.0",
      ].includes(id),
    )
  )
    return "Distribution review: This reciprocal license can impose notice and source-availability obligations when distributing covered software. Review its terms before release.";
  return undefined;
}

function isFree(id: string): boolean {
  return FSF_FREE.has(id);
}

function isOsi(id: string): boolean {
  return OSI_APPROVED.has(id);
}

const MATRIX_GROUPS = [
  "permissive",
  "gpl-3",
  "gpl-2",
  "lgpl-3",
  "lgpl-2.1",
  "mpl-2",
  "agpl-3",
  "cc0",
  "unlicense",
] as const;

type MatrixGroup = (typeof MATRIX_GROUPS)[number];
type MatrixValue = "compatible" | "warning" | "incompatible";

const MATRIX_VALUES: Record<"c" | "w" | "i", MatrixValue> = {
  c: "compatible",
  w: "warning",
  i: "incompatible",
};

// Rows and columns follow MATRIX_GROUPS. c = compatible, w = warning, i = incompatible.
const COMPATIBILITY_MATRIX = [
  "ciicccicc",
  "icwiiiwwc",
  "iwciiiwwc",
  "ciicwwiic",
  "ciiwcwiic",
  "ciiwwciic",
  "iwwiiiicc",
  "ccccccccc",
  "ccccccccc",
] as const;

function matrixGroup(id: string): MatrixGroup | undefined {
  if (id === "CC0-1.0") return "cc0";
  if (id === "Unlicense") return "unlicense";
  if (["MPL-1.0", "MPL-1.1", "MPL-2.0"].includes(id)) return "mpl-2";
  if (/^GPL-3\.0(?:$|-)/.test(id)) return "gpl-3";
  if (/^GPL-2\.0(?:$|-)/.test(id)) return "gpl-2";
  if (/^LGPL-3\.0(?:$|-)/.test(id)) return "lgpl-3";
  if (/^LGPL-2\.1(?:$|-)/.test(id)) return "lgpl-2.1";
  if (/^AGPL-3\.0(?:$|-)/.test(id)) return "agpl-3";
  if (CATEGORY_A.has(id)) return "permissive";
  return undefined;
}

function matrixCompatibility(
  main: MatrixGroup,
  dependency: MatrixGroup,
  weakCompatible: boolean,
): Compatibility {
  const mainIndex = MATRIX_GROUPS.indexOf(main);
  const dependencyIndex = MATRIX_GROUPS.indexOf(dependency);
  const value =
    MATRIX_VALUES[
      COMPATIBILITY_MATRIX[mainIndex][dependencyIndex] as "c" | "w" | "i"
    ];
  if (value === "warning")
    return weakCompatible ? "weak-compatible" : "unknown";
  return value;
}

function compareSingle(
  main: string,
  dependency: string,
  weakCompatible: boolean,
  config?: DependencyConfig,
): Compatibility {
  if (dependency === "Unknown") return "incompatible";
  if (config?.require_fsf_free && !isFree(dependency)) return "incompatible";
  if (config?.require_osi_approved && !isOsi(dependency)) return "incompatible";

  const mainGroup = matrixGroup(main);
  const dependencyGroup = matrixGroup(dependency);
  if (mainGroup && dependencyGroup)
    return matrixCompatibility(mainGroup, dependencyGroup, weakCompatible);

  if (CATEGORY_A.has(main)) {
    if (CATEGORY_A.has(dependency)) return "compatible";
    if (CATEGORY_B.has(dependency))
      return weakCompatible ? "weak-compatible" : "unknown";
    if (CATEGORY_A_INCOMPATIBLE.has(dependency)) return "incompatible";
    return "unknown";
  }
  if (CATEGORY_B.has(main)) {
    if (CATEGORY_B.has(dependency)) return "compatible";
    if (CATEGORY_A.has(dependency))
      return weakCompatible ? "weak-compatible" : "unknown";
    return "incompatible";
  }
  return main === dependency ? "compatible" : "unknown";
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
  const mainId = main.type === "license" ? main.id : "Unknown";

  const visit = (expression: SpdxExpression): Compatibility => {
    switch (expression.type) {
      case "license":
        return compareSingle(mainId, expression.id, weakCompatible, config);
      case "with":
        return visit(expression.license);
      case "and":
        return combineAnd(visit(expression.left), visit(expression.right));
      case "or":
        return combineOr(visit(expression.left), visit(expression.right));
    }
  };

  return visit(dependency);
}

export function isUnknownLicense(value: string | undefined): boolean {
  return normalizeLicenseExpression(value) === "Unknown";
}
