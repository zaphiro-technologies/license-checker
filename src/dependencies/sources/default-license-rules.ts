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
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { LicenseRule, LicenseRuleSource } from "../../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadDefaultLicenseRules(): Record<LicenseRuleSource, LicenseRule[]> {
  const rulesPath = fileURLToPath(
    new URL("../../../config/default-license-rules.yaml", import.meta.url),
  );
  const parsed: unknown = parseYaml(readFileSync(rulesPath, "utf8"));
  if (!isRecord(parsed)) throw new Error("Invalid default license rules YAML.");

  const loadSource = (source: LicenseRuleSource): LicenseRule[] => {
    const entries = parsed[source];
    if (!Array.isArray(entries)) {
      throw new Error(`Missing default license rules for ${source}.`);
    }
    return entries.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        typeof entry.match !== "string" ||
        typeof entry.license !== "string"
      ) {
        throw new Error(`Invalid default license rule for ${source}.`);
      }
      return {
        source,
        match: entry.match,
        license: entry.license,
      } satisfies LicenseRule;
    });
  };

  return {
    "license-text": loadSource("license-text"),
    "python-classifier": loadSource("python-classifier"),
  };
}

const DEFAULT_RULES = loadDefaultLicenseRules();

export const DEFAULT_LICENSE_TEXT_RULES: LicenseRule[] =
  DEFAULT_RULES["license-text"];
export const DEFAULT_PYTHON_CLASSIFIER_RULES: LicenseRule[] =
  DEFAULT_RULES["python-classifier"];
