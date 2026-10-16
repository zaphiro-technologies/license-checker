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

import type { Dependency, Ecosystem } from "../types.js";
import type {
  DependencyCheckContext,
  LicenseEvidence,
  LicenseResolutionContext,
} from "./checker.js";
import { GoDependencyChecker } from "./go/checker.js";
import { JavaScriptDependencyChecker } from "./javascript/checker.js";
import { PythonDependencyChecker } from "./python/checker.js";

const checkers = [
  new JavaScriptDependencyChecker(),
  new PythonDependencyChecker(),
  new GoDependencyChecker(),
];

export function collectDependencyManifest(
  context: DependencyCheckContext,
): Dependency[] | undefined {
  const basename = context.path.split("/").pop() ?? context.path;
  const checker = checkers.find((candidate) => candidate.supports(basename));
  return checker?.collect(context);
}

export function resolveDependencyLicense(
  ecosystem: Ecosystem,
  dependency: Dependency,
  context: LicenseResolutionContext,
): Promise<LicenseEvidence> {
  const checker = checkers.find(
    (candidate) => candidate.ecosystem === ecosystem,
  );
  return checker
    ? checker.resolveLicense(dependency, context)
    : Promise.resolve({ resolution: "unknown" });
}
