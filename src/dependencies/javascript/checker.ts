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
import { collectJavaScriptDependencies } from "./parsers/manifest.js";
import { resolveNpmLicense } from "./license-resolver.js";

export { packageLicense } from "./parsers/package-json.js";
export { npmVersionIsExact } from "./parsers/npm-lock.js";
export type { PackageJson } from "./parsers/package-json.js";

export class JavaScriptDependencyChecker extends DependencyChecker {
  readonly ecosystem = "npm" as const;

  supports(manifestName: string): boolean {
    return (
      manifestName === "package.json" ||
      manifestName === "package-lock.json" ||
      manifestName === "npm-shrinkwrap.json" ||
      manifestName === "yarn.lock" ||
      manifestName === "pnpm-lock.yaml"
    );
  }

  collect(context: DependencyCheckContext): Dependency[] {
    return collectJavaScriptDependencies(context);
  }

  resolveLicense(
    dependency: Dependency,
    context: LicenseResolutionContext,
  ): Promise<LicenseEvidence> {
    return resolveNpmLicense(
      context.root,
      dependency,
      context.logger,
      context.token,
      context.includeMatchText,
      context.licenseRules,
    );
  }
}
