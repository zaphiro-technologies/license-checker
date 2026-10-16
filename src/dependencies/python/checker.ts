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

import type { Dependency } from "../../types.js";
import {
  DependencyChecker,
  type DependencyCheckContext,
  type LicenseEvidence,
  type LicenseResolutionContext,
} from "../checker.js";
import { collectPythonDependencies } from "./parsers/manifest.js";
import { resolvePythonLicense } from "./license-resolver.js";

export {
  licenseFromPythonClassifier,
  licensesFromPythonClassifiers,
} from "./parsers/classifiers.js";

export class PythonDependencyChecker extends DependencyChecker {
  readonly ecosystem = "python" as const;

  supports(manifestName: string): boolean {
    return (
      manifestName === "pyproject.toml" ||
      manifestName === "poetry.lock" ||
      manifestName === "Pipfile.lock" ||
      manifestName === "requirements.txt" ||
      manifestName.endsWith(".txt")
    );
  }

  collect(context: DependencyCheckContext): Dependency[] {
    return collectPythonDependencies(context);
  }

  resolveLicense(
    dependency: Dependency,
    context: LicenseResolutionContext,
  ): Promise<LicenseEvidence> {
    return resolvePythonLicense(
      dependency,
      context.token,
      context.logger,
      context.includeMatchText,
      context.licenseRules,
    );
  }
}
