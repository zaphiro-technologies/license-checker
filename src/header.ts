import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headerRules } from './config.js';
import { Logger } from './logger.js';
import { normalizeLicenseId } from './spdx.js';
import type { HeaderReport, HeaderRule, LicenseEyeConfig } from './types.js';
import { listRepositoryFiles, matchesPath } from './util.js';

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.go', '.py', '.pyi',
]);

const LICENSE_MARKERS: Record<string, string[]> = {
  'Apache-2.0': [
    'apache license, version 2.0',
    'licensed under the apache license',
    'apache.org/licenses/license-2.0',
  ],
  MIT: ['permission is hereby granted, free of charge', 'the mit license'],
  'BSD-2-Clause': ['redistribution and use in source and binary forms', 'this product includes software'],
  'BSD-3-Clause': ['redistribution and use in source and binary forms', 'neither the name'],
  ISC: ['permission to use, copy, modify, and/or distribute'],
  'MPL-2.0': ['mozilla public license, version 2.0', 'mozilla public license version 2.0'],
  'GPL-2.0-only': ['gnu general public license', 'either version 2 of the license'],
  'GPL-2.0-or-later': ['gnu general public license', 'either version 2 of the license'],
  'GPL-3.0-only': ['gnu general public license', 'either version 3 of the license'],
  'GPL-3.0-or-later': ['gnu general public license', 'either version 3 of the license'],
  'LGPL-2.1-only': ['gnu lesser general public license', 'either version 2.1 of the license'],
  'LGPL-2.1-or-later': ['gnu lesser general public license', 'either version 2.1 of the license'],
  'LGPL-3.0-only': ['gnu lesser general public license', 'either version 3 of the license'],
  'LGPL-3.0-or-later': ['gnu lesser general public license', 'either version 3 of the license'],
};

function normalized(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/\/\*|\*\//g, ' '))
    .replace(/^\s*\/\/!?\s?/gm, '')
    .replace(/^\s*#\s?/gm, '')
    .replace(/^\s*\*\s?/gm, '')
    .replace(/^\s*<!--\s?/gm, '')
    .replace(/\s*-->\s*$/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/[“”’`]/g, "'")
    .replace(/https:\/\//gi, 'http://')
    .toLowerCase()
    .trim();
}

function commentText(source: string): string {
  const prefix = source.slice(0, 24000).replace(/^\uFEFF/, '');
  return normalized(prefix);
}

function replacePlaceholders(value: string, rule: HeaderRule): string {
  const license = rule.license;
  const year = license['copyright-year'] === undefined ? new Date().getFullYear().toString() : String(license['copyright-year']);
  return value
    .replaceAll('[year]', year)
    .replaceAll('[owner]', license['copyright-owner'] ?? '')
    .replaceAll('[software-name]', license['software-name'] ?? '');
}

function selectedRule(file: string, rules: HeaderRule[]): HeaderRule | undefined {
  const candidates = rules.filter((rule) => !rule.path || matchesPath(file, [rule.path]));
  if (candidates.length === 0) return undefined;
  return candidates.sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0];
}

function expectedSpdx(rule: HeaderRule): string {
  return normalizeLicenseId(rule.license['spdx-id'] ?? 'Unknown');
}

function matchesConfiguredContent(text: string, rule: HeaderRule, threshold: number): boolean {
  const content = rule.license.content;
  if (!content) return false;
  const expected = normalized(replacePlaceholders(content, rule));
  return expected.length > 0 && text.indexOf(expected) >= 0 && text.indexOf(expected) < threshold;
}

function matchesPattern(source: string, rule: HeaderRule, threshold: number): boolean {
  if (!rule.license.pattern) return false;
  try {
    const pattern = new RegExp(replacePlaceholders(rule.license.pattern, rule), 'is');
    const match = pattern.exec(source.slice(0, 24000));
    return Boolean(match && match.index < threshold * 32);
  } catch {
    return false;
  }
}

function matchesSpdx(text: string, rule: HeaderRule, threshold: number): boolean {
  const id = expectedSpdx(rule);
  if (id === 'Unknown') return false;
  const spdxLine = new RegExp(`spdx[- ]license[- ]identifier\\s*:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const marker = LICENSE_MARKERS[id] ?? [id.toLowerCase()];
  const index = text.indexOf('spdx-license-identifier');
  if (spdxLine.test(text)) return index < threshold;
  return marker.some((candidate) => {
    const markerIndex = text.indexOf(candidate.toLowerCase());
    return markerIndex >= 0 && markerIndex < threshold * 32;
  });
}

function hasCopyrightFields(text: string, rule: HeaderRule): boolean {
  const owner = rule.license['copyright-owner'];
  const year = rule.license['copyright-year'];
  if (owner && !text.includes(normalized(owner))) return false;
  if (year && !text.includes(String(year).toLowerCase())) return false;
  return true;
}

function shouldCheck(file: string, rule: HeaderRule): boolean {
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension)) return false;
  if (rule.paths && !matchesPath(file, rule.paths)) return false;
  if (matchesPath(file, rule['paths-ignore'])) return false;
  return true;
}

export function checkHeaders(root: string, config: LicenseEyeConfig, logger: Logger): HeaderReport {
  const rules = headerRules(config);
  if (rules.length === 0) return { checked: 0, ignored: 0, failures: [] };

  const report: HeaderReport = { checked: 0, ignored: 0, failures: [] };
  for (const file of listRepositoryFiles(root)) {
    const rule = selectedRule(file, rules);
    if (!rule || !shouldCheck(file, rule)) {
      if (rule) report.ignored += 1;
      continue;
    }

    report.checked += 1;
    const source = readFileSync(join(root, file), 'utf8');
    const text = commentText(source);
    const threshold = rule['license-location-threshold'] && rule['license-location-threshold'] > 0
      ? rule['license-location-threshold']
      : 80;
    const satisfied =
      matchesConfiguredContent(text, rule, threshold) ||
      matchesPattern(source, rule, threshold) ||
      matchesSpdx(text, rule, threshold);

    if (!satisfied || !hasCopyrightFields(text, rule)) {
      const reason = !satisfied
        ? `missing ${rule.license['spdx-id'] ?? 'configured'} license header`
        : 'copyright owner or year is missing';
      report.failures.push({
        file,
        expected: rule.license['spdx-id'] ?? 'configured license',
        reason,
      });
      logger.debug(`Header failure: ${file} (${reason})`);
    } else {
      logger.debug(`Header valid: ${file}`);
    }
  }
  return report;
}
