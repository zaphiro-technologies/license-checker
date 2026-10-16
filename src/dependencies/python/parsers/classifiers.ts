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

import type { LicenseRule } from "../../../types.js";
import { normalizeLicenseExpression } from "../../../spdx.js";
import { DEFAULT_PYTHON_CLASSIFIER_RULES } from "../../sources/default-license-rules.js";

export function licenseFromPythonClassifier(
  classifier: string,
  customRules: LicenseRule[] = [],
): string {
  const label = classifier.split("::").pop()?.trim() ?? classifier;
  const applicableRules = customRules.filter(
    (rule) => rule.source === "python-classifier",
  );
  for (const rule of [...applicableRules, ...DEFAULT_PYTHON_CLASSIFIER_RULES]) {
    if (new RegExp(rule.match, "is").test(label)) return rule.license;
  }
  return label;
}

export function licensesFromPythonClassifiers(
  classifiers: string[] | undefined,
  customRules: LicenseRule[] = [],
): string[] {
  const licenses = new Set<string>();
  for (const classifier of classifiers ?? []) {
    if (!classifier.startsWith("License ::")) continue;
    const normalized = normalizeLicenseExpression(
      licenseFromPythonClassifier(classifier, customRules),
    );
    if (normalized !== "Unknown") licenses.add(normalized);
  }
  return [...licenses];
}
